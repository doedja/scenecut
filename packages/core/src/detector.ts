/**
 * Scene Detector — main orchestrator.
 *
 * Per-frame pipeline:
 *   1. Fused fast pass (main thread): sampled MAD vs. prev + drift vs. EMA reference,
 *      EMA updated in-place. Cheap, ~1.5% of pixels touched.
 *   2. Gate: if MAD and drift both below their thresholds, skip WASM entirely.
 *   3. WASM MEanalysis returns rawScore — inline (WasmBridge) or dispatched to a
 *      worker pool for parallelism. Either way, sigmoid-calibrated to p_cut.
 *   4. Fade rescue: borderline p_cut + elevated drift lowers the effective
 *      threshold locally. No extra WASM call.
 *   5. Warmup: first ~2 s of rawScores set the per-video noise floor and nudge
 *      intraThresh2 up.
 *   6. Smoother: online NMS with a minGap refractory window.
 *
 * Worker pool path: main thread still owns the fused pass, EMA, warmup, and
 * smoother. Only MEanalysis is dispatched. Results are drained in frame order
 * so state updates stay sequential.
 */

import { WasmBridge, calibratePCut } from './wasm-bridge';
import { SceneSmoother } from './scene-smoother';
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
   * in parallel across the pool and the main thread stays responsive. Main
   * thread still owns fused pass, EMA, warmup, and smoother state.
   */
  pool?: MotionWorkerPool;
}

export type SceneDetectorOptions = DetectionOptions & DetectorExtras;

interface PendingAnalysis {
  frameNumber: number;
  drift: number;
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
      searchRange: options.searchRange || 'auto',
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
    let intraThresh = base.intraThresh;
    let intraThresh2 = base.intraThresh2;
    const baseThresh2 = intraThresh2;

    if (!pool) {
      this.wasmBridge.allocateBuffers(metadata.resolution.width, metadata.resolution.height);
    }

    const minGap = Math.max(4, Math.round(metadata.fps * 0.25));
    const smoother = new SceneSmoother({ minGap, threshold: 0.5 });

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

    // EMA fade detection — main-thread-owned
    const frameSize = metadata.resolution.width * metadata.resolution.height;
    const emaStride = 16;
    const emaSamples = Math.floor(frameSize / emaStride);
    const emaRef = new Float32Array(emaSamples);
    const emaAlpha = 0.03;
    const driftRescue = 25;
    const fadeFactor = 0.6;

    const quickRejectStride = 64;
    const quickRejectThreshold = 4;

    const warmupFrames = Math.min(120, Math.max(60, Math.floor(metadata.fps * 2)));
    const warmupScores: number[] = [];
    let warmupDone = false;

    const signal = this.options.signal;

    // Worker pool: in-flight queue preserving frame order
    const inflight: PendingAnalysis[] = [];
    // Max in-flight caps at pool.size * 2 so the queue stays saturated but
    // doesn't balloon memory on slow consumers.
    const maxInflight = pool ? Math.max(2, pool.size * 2) : 0;

    const commitAnalyzed = (frameNumber: number, rawScore: number, drift: number, dispatchedThresh2: number) => {
      let pCut = calibratePCut(rawScore, dispatchedThresh2);
      if (pCut < 0.5 && drift >= driftRescue) {
        const loweredThresh = Math.round(dispatchedThresh2 * fadeFactor);
        const pCutFade = calibratePCut(rawScore, loweredThresh);
        if (pCutFade > pCut) pCut = pCutFade;
      }

      if (!warmupDone) {
        warmupScores.push(rawScore);
        if (warmupScores.length >= warmupFrames) {
          warmupDone = true;
          const sorted = warmupScores.slice().sort((a, b) => a - b);
          const p95 = sorted[Math.floor(sorted.length * 0.95)];
          const calibrated = Math.max(baseThresh2, Math.round(p95 * 1.5));
          intraThresh2 = Math.min(calibrated, baseThresh2 * 4);
          intraThresh = Math.round(base.intraThresh * (intraThresh2 / baseThresh2));
        }
      }

      emit(frameNumber, pCut);
    };

    const emit = (frameNumber: number, pCut: number) => {
      const emissions = smoother.observe(frameNumber, pCut);
      for (const e of emissions) {
        const scene: SceneInfo = {
          frameNumber: e.frameNumber,
          timestamp: e.frameNumber / metadata.fps,
          timecode: formatTimecode(e.frameNumber / metadata.fps),
          confidence: e.confidence
        };
        scenes.push(scene);
        this.options.onScene(scene);
        this.state.intraCount = 1;
      }
      if (emissions.length === 0) {
        this.state.intraCount++;
      }
    };

    const drainOne = async (): Promise<void> => {
      const head = inflight.shift();
      if (!head) return;
      const result = await head.promise;
      commitAnalyzed(head.frameNumber, result.rawScore, head.drift, head.intraThresh2AtDispatch);
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
          let driftSum = 0;
          const a = emaAlpha;
          const b = 1 - a;
          const madEvery = quickRejectStride / emaStride; // integer: 4
          for (let i = 0, s = 0; i < curData.length; i += emaStride, s++) {
            const cur = curData[i];
            const ref = emaRef[s];
            driftSum += cur > ref ? cur - ref : ref - cur;
            emaRef[s] = b * ref + a * cur;
            if ((s % madEvery) === 0) {
              const p = prevData[i];
              madSum += cur > p ? cur - p : p - cur;
              madCount++;
            }
          }
          const mad = madCount > 0 ? madSum / madCount : 0;
          const drift = driftSum / emaSamples;

          if (mad >= quickRejectThreshold || drift >= driftRescue) {
            if (pool) {
              // Copy bytes — the decoder's buffers get reused for the next frame.
              // `slice()` is the fastest portable way; it's a single memcpy.
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
                drift,
                promise: p,
                intraThresh2AtDispatch: intraThresh2
              });

              // Drain one-by-one while we're over the cap. Each drain
              // advances state and frees a slot.
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
              commitAnalyzed(frame.frameNumber, res.rawScore, drift, intraThresh2);
            }
          } else {
            // No-WASM frame — flush inflight first so state stays ordered.
            await drainAll();
            emit(frame.frameNumber, 0);
          }
        } else {
          // Seed EMA from the first frame.
          for (let i = 0, s = 0; i < frame.data.length; i += emaStride, s++) {
            emaRef[s] = frame.data[i];
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

    // Flush remaining in-flight work before the final smoother flush.
    await drainAll();

    const tail = smoother.flush();
    for (const e of tail) {
      const scene: SceneInfo = {
        frameNumber: e.frameNumber,
        timestamp: e.frameNumber / metadata.fps,
        timecode: formatTimecode(e.frameNumber / metadata.fps),
        confidence: e.confidence
      };
      scenes.push(scene);
      this.options.onScene(scene);
    }

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
