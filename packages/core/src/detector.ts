/**
 * Scene Detector: main orchestrator.
 *
 * v1.0.2 byte-parity (single-thread path on identical ffmpeg-decoded input):
 *   1. Pre-pass: sampled MAD at stride 64. If MAD < 5, skip WASM entirely
 *      (matches v1's quick-reject).
 *   2. WASM MEanalysis returns rawScore.
 *   3. Emit when rawScore >= intraThresh2 (equivalent to sigmoid p_cut >= 0.5).
 *      Reset intraCount to 1 on emit, else +1. Scene timestamp = frame.pts.
 *
 * v1.0.2 also had a fade-rescue path but a double-buffer bug made the second
 * WASM call compare cur to itself (returning ~0), so the rescue never fired
 * in practice. 3.0.3-3.0.7 reintroduced a working rescue via a stateless
 * WASM call, which emitted cuts v1 missed and shifted intraCount, diverging
 * the output. 3.0.8 removes the rescue to ship the actual v1 behavior.
 *
 * Worker pool path: same shape, but WASM dispatches concurrently. Results
 * drain in frame order via an inflight queue. Pool wasn't in v1, so not
 * v1-byte-identical; documented in CLAUDE.md.
 */

import { WasmBridge, calibratePCut } from './wasm-bridge';
import type { MotionWorkerPool, AnalyzeResult } from './worker/pool';
import {
  DetectionOptions,
  DetectionResult,
  SceneInfo,
  Progress,
  DetectionState,
  FrameSource,
  WasmFactory,
  RawFrame
} from './types';
import {
  formatTimecode,
  calculateFcode,
  calculateThresholds,
  validateFrame
} from './frame-processor';

export interface DetectorExtras {
  /**
   * Optional motion worker pool. When provided, WASM motion estimation runs
   * in parallel across the pool. Main thread still owns pre-pass.
   */
  pool?: MotionWorkerPool;
}

export type SceneDetectorOptions = DetectionOptions & DetectorExtras;

interface PendingAnalysis {
  frameNumber: number;
  pts: number;
  promise: Promise<AnalyzeResult>;
  intraThresh2AtDispatch: number;
}

export class SceneDetector {
  private options: Required<Pick<DetectionOptions,
    'sensitivity' | 'searchRange' | 'onProgress' | 'onScene' | 'format'
  >> & { signal?: AbortSignal; pool?: MotionWorkerPool };

  private wasmBridge: WasmBridge;
  private state: DetectionState;

  constructor(factory: WasmFactory, options: SceneDetectorOptions = {}) {
    this.options = {
      sensitivity: options.sensitivity || 'low',
      searchRange: options.searchRange || 'medium',
      onProgress: options.onProgress || (() => {}),
      onScene: options.onScene || (() => {}),
      format: options.format || 'json',
      signal: options.signal,
      pool: options.pool
    };

    this.wasmBridge = new WasmBridge(factory);
    this.state = { intraCount: 1, fcode: 4, prevFrame: null, curFrame: null };
  }

  async detect(source: FrameSource): Promise<DetectionResult> {
    const pool = this.options.pool;

    if (pool) {
      await pool.init();
    } else {
      await this.wasmBridge.init();
    }

    const metadata = await source.getMetadata();

    this.state.fcode = calculateFcode(
      this.options.searchRange,
      metadata.resolution.width,
      metadata.resolution.height
    );

    const base = calculateThresholds(this.options.sensitivity);
    const intraThresh = base.intraThresh;
    const intraThresh2 = base.intraThresh2;

    if (!pool) {
      this.wasmBridge.allocateBuffers(metadata.resolution.width, metadata.resolution.height);
    }

    const scenes: SceneInfo[] = [{
      frameNumber: 0,
      timestamp: 0,
      timecode: '00:00:00.000',
      confidence: 1.0
    }];

    const startTime = Date.now();
    let processedFrames = 0;
    let firstFrameValidated = false;
    const fpsWindow: { time: number; frame: number }[] = [];

    // v1.0.2 quick-reject: stride 64, threshold 5.
    const gateStride = 64;
    const gateMad = 5;

    const signal = this.options.signal;

    const inflight: PendingAnalysis[] = [];
    const maxInflight = pool ? Math.max(2, pool.size * 2) : 0;

    const emit = (frameNumber: number, pts: number, pCut: number): void => {
      if (pCut >= 0.5) {
        const scene: SceneInfo = {
          frameNumber,
          timestamp: pts,
          timecode: formatTimecode(pts),
          confidence: pCut
        };
        scenes.push(scene);
        this.options.onScene(scene);
        this.state.intraCount = 1;
      } else {
        this.state.intraCount++;
      }
    };

    const drainOne = async (): Promise<void> => {
      const head = inflight.shift();
      if (!head) return;
      const result = await head.promise;
      const pCut = calibratePCut(result.rawScore, head.intraThresh2AtDispatch);
      emit(head.frameNumber, head.pts, pCut);
    };

    const drainAll = async (): Promise<void> => {
      while (inflight.length > 0) await drainOne();
    };

    await source.extractFrames(
      async (frame: RawFrame) => {
        if (signal?.aborted) throw new Error('Detection aborted');

        if (!firstFrameValidated) {
          validateFrame(frame);
          firstFrameValidated = true;
        }

        this.state.curFrame = frame;

        if (this.state.prevFrame) {
          const prevData = this.state.prevFrame.data;
          const curData = this.state.curFrame.data;

          let madSum = 0;
          let madCount = 0;
          for (let i = 0; i < curData.length; i += gateStride) {
            const c = curData[i];
            const p = prevData[i];
            madSum += c > p ? c - p : p - c;
            madCount++;
          }
          const mad = madCount > 0 ? madSum / madCount : 0;

          if (mad >= gateMad) {
            if (pool) {
              const prevCopy = prevData.slice();
              const curCopy = curData.slice();
              const p = pool.analyze({
                width: frame.width,
                height: frame.height,
                intraCount: this.state.intraCount,
                fcode: this.state.fcode,
                intraThresh,
                intraThresh2,
                prev: prevCopy,
                cur: curCopy
              });
              inflight.push({
                frameNumber: frame.frameNumber,
                pts: frame.pts,
                promise: p,
                intraThresh2AtDispatch: intraThresh2
              });

              while (inflight.length >= maxInflight) await drainOne();
            } else {
              const res = this.wasmBridge.detectSceneChange(
                this.state.prevFrame,
                this.state.curFrame,
                this.state.intraCount,
                this.state.fcode,
                intraThresh,
                intraThresh2
              );
              const pCut = calibratePCut(res.rawScore, intraThresh2);
              emit(frame.frameNumber, frame.pts, pCut);
            }
          } else {
            // Below the gate: no WASM. Flush inflight first so emit stays
            // in frame order, then mark no-cut. v1.0.2 just incremented
            // intraCount here; we do the same via emit(pCut=0).
            await drainAll();
            emit(frame.frameNumber, frame.pts, 0);
          }
        }

        this.state.prevFrame = this.state.curFrame;
        processedFrames++;
      },
      (current: number, total: number) => {
        const now = Date.now();
        const elapsed = (now - startTime) / 1000;
        fpsWindow.push({ time: now, frame: current });
        while (fpsWindow.length > 1 && (now - fpsWindow[0].time) > 3000) {
          fpsWindow.shift();
        }
        let currentFps = 0;
        if (fpsWindow.length >= 2) {
          const oldest = fpsWindow[0];
          const newest = fpsWindow[fpsWindow.length - 1];
          const dt = (newest.time - oldest.time) / 1000;
          if (dt > 0) currentFps = (newest.frame - oldest.frame) / dt;
        }
        const remaining = currentFps > 0 ? (total - current) / currentFps : undefined;
        const progress: Progress = {
          currentFrame: current,
          totalFrames: total,
          percent: Math.round((current / total) * 100),
          eta: remaining,
          fps: currentFps,
          elapsed,
          scenesDetected: scenes.length
        };
        this.options.onProgress(progress);
      },
      signal
    );

    await drainAll();

    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    const framesPerSecond = processedFrames / processingTime;

    for (let i = 0; i < scenes.length; i++) {
      if (i < scenes.length - 1) {
        scenes[i].duration = scenes[i + 1].timestamp - scenes[i].timestamp;
        scenes[i].frameCount = scenes[i + 1].frameNumber - scenes[i].frameNumber;
      } else {
        scenes[i].duration = metadata.duration - scenes[i].timestamp;
        scenes[i].frameCount = metadata.totalFrames - scenes[i].frameNumber;
      }
    }

    return {
      scenes,
      metadata,
      stats: { processingTime, framesPerSecond }
    };
  }

  destroy(): void {
    this.wasmBridge.destroy();
    this.state.prevFrame = null;
    this.state.curFrame = null;
  }
}
