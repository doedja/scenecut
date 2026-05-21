/**
 * Scene Detector: main orchestrator.
 *
 * Per-frame pipeline matches v1.0.2 byte-for-byte in the single-thread path
 * so its output reproduces v1's keyframes on the same ffmpeg-decoded input:
 *   1. Pre-pass: sampled MAD between prev and cur at stride 64. If MAD < 5,
 *      skip WASM entirely (matches v1's quick-reject).
 *   2. WASM MEanalysis returns rawScore. Sigmoid-calibrated to p_cut.
 *   3. Fade rescue: when p_cut < 0.5 and drift vs the last-cut keyframe (at
 *      stride 4) is strictly > 30, re-run WASM with thresholds * 0.6.
 *   4. Emit on p_cut >= 0.5. Scene timestamp uses the frame's own pts so it
 *      matches the decoder (VFR-safe). Keyframe snapshot refreshes EAGERLY
 *      to the cut frame's bytes for the next drift baseline.
 *
 * Worker pool path: same shape, but WASM dispatches concurrently. Results
 * drain in frame order via an inflight queue. The dispatched frame's bytes
 * are gone by emit time, so the pool path falls back to a one-frame-lag
 * lazy keyframe refresh (not v1-byte-identical; v1 had no pool).
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
   * in parallel across the pool. Main thread still owns pre-pass and
   * keyframe state.
   */
  pool?: MotionWorkerPool;
}

export type SceneDetectorOptions = DetectionOptions & DetectorExtras;

interface PendingAnalysis {
  frameNumber: number;
  pts: number;
  drift: number;
  promise: Promise<AnalyzeResult>;
  intraThreshAtDispatch: number;
  intraThresh2AtDispatch: number;
  intraCountAtDispatch: number;
  fcodeAtDispatch: number;
  width: number;
  height: number;
  /** Spare copies kept only when drift suggests fade rescue may be needed. */
  prevSpare: Uint8Array | null;
  curSpare: Uint8Array | null;
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

    // Drift reference: snapshot of the last confirmed scene-cut frame. v1.0.2
    // uses eager refresh (cur bytes at emit). Pool path falls back to lazy.
    let keyframeData: Uint8Array | null = null;
    let pendingKeyframeRefresh = false;

    // v1.0.2 quick-reject: stride 64, threshold 5. Skip WASM when prev->cur
    // is essentially static.
    const gateStride = 64;
    const gateMad = 5;

    // v1.0.2 drift sample at stride 4 against last-cut keyframe. Rescue fires
    // when drift is strictly > 30 (matches v1's `if (driftAvg > 30)`).
    const driftStride = 4;
    const driftRescue = 30;
    const fadeFactor = 0.6;

    const signal = this.options.signal;

    const inflight: PendingAnalysis[] = [];
    const maxInflight = pool ? Math.max(2, pool.size * 2) : 0;

    const refreshKeyframe = (data: Uint8Array): void => {
      keyframeData = data.slice();
    };

    const emitInline = (
      frameNumber: number,
      pts: number,
      pCut: number,
      curData: Uint8Array
    ): void => {
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
        refreshKeyframe(curData);
      } else {
        this.state.intraCount++;
      }
    };

    const emitFromPool = (
      frameNumber: number,
      pts: number,
      pCut: number
    ): void => {
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
        pendingKeyframeRefresh = true;
      } else {
        this.state.intraCount++;
      }
    };

    const commitInline = (
      frameNumber: number,
      pts: number,
      rawScore: number,
      drift: number,
      dispatchedThresh: number,
      dispatchedThresh2: number,
      dispatchedIntraCount: number,
      width: number,
      height: number,
      prevData: Uint8Array,
      curData: Uint8Array
    ): void => {
      let pCut = calibratePCut(rawScore, dispatchedThresh2);
      if (pCut < 0.5 && keyframeData && drift > driftRescue) {
        const fadeThresh = Math.round(dispatchedThresh * fadeFactor);
        const fadeThresh2 = Math.round(dispatchedThresh2 * fadeFactor);
        const fadeRes = this.wasmBridge.detectSceneChangeStateless(
          prevData, curData, width, height,
          dispatchedIntraCount, this.state.fcode,
          fadeThresh, fadeThresh2
        );
        // Stateless overwrites both slots, so reset double-buffer state.
        this.wasmBridge.resetBufferState();
        const pCutFade = calibratePCut(fadeRes.rawScore, fadeThresh2);
        if (pCutFade > pCut) pCut = pCutFade;
      }
      emitInline(frameNumber, pts, pCut, curData);
    };

    const commitFromPool = async (head: PendingAnalysis): Promise<void> => {
      const result = await head.promise;
      let pCut = calibratePCut(result.rawScore, head.intraThresh2AtDispatch);
      if (
        pCut < 0.5 &&
        head.drift > driftRescue &&
        head.prevSpare &&
        head.curSpare &&
        pool
      ) {
        const fadeThresh = Math.round(head.intraThreshAtDispatch * fadeFactor);
        const fadeThresh2 = Math.round(head.intraThresh2AtDispatch * fadeFactor);
        const fadeRes = await pool.analyze({
          width: head.width,
          height: head.height,
          intraCount: head.intraCountAtDispatch,
          fcode: head.fcodeAtDispatch,
          intraThresh: fadeThresh,
          intraThresh2: fadeThresh2,
          prev: head.prevSpare,
          cur: head.curSpare
        });
        const pCutFade = calibratePCut(fadeRes.rawScore, fadeThresh2);
        if (pCutFade > pCut) pCut = pCutFade;
      }
      emitFromPool(head.frameNumber, head.pts, pCut);
    };

    const drainOne = async (): Promise<void> => {
      const head = inflight.shift();
      if (!head) return;
      await commitFromPool(head);
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

        // Pool path lazy refresh: snap keyframe to this frame's bytes if a
        // recent pool emit flagged it. One frame after the actual cut.
        if (pendingKeyframeRefresh) {
          refreshKeyframe(frame.data);
          pendingKeyframeRefresh = false;
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

          let drift = 0;
          if (keyframeData) {
            let driftSum = 0;
            let driftCount = 0;
            for (let i = 0; i < curData.length; i += driftStride) {
              const c = curData[i];
              const k = keyframeData[i];
              driftSum += c > k ? c - k : k - c;
              driftCount++;
            }
            drift = driftCount > 0 ? driftSum / driftCount : 0;
          }

          if (mad >= gateMad) {
            const needsRescueStash = drift > driftRescue;

            if (pool) {
              const prevCopy = prevData.slice();
              const curCopy = curData.slice();
              let prevSpare: Uint8Array | null = null;
              let curSpare: Uint8Array | null = null;
              if (needsRescueStash) {
                prevSpare = prevData.slice();
                curSpare = curData.slice();
              }
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
                drift,
                promise: p,
                intraThreshAtDispatch: intraThresh,
                intraThresh2AtDispatch: intraThresh2,
                intraCountAtDispatch: this.state.intraCount,
                fcodeAtDispatch: this.state.fcode,
                width: frame.width,
                height: frame.height,
                prevSpare,
                curSpare
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
              commitInline(
                frame.frameNumber,
                frame.pts,
                res.rawScore,
                drift,
                intraThresh,
                intraThresh2,
                this.state.intraCount,
                frame.width,
                frame.height,
                prevData,
                curData
              );
            }
          } else {
            // Below the gate: no WASM. Flush inflight first so emit order
            // stays in frame order, then mark no-cut.
            await drainAll();
            emitInline(frame.frameNumber, frame.pts, 0, curData);
          }
        } else {
          // First frame: seed keyframeData. Frame 0 is already pushed as a
          // scene before extractFrames started.
          refreshKeyframe(frame.data);
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
