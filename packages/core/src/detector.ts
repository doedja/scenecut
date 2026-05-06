/**
 * Scene Detector: main orchestrator.
 *
 * Per-frame pipeline:
 *   1. Fast pre-pass (main thread): sampled MAD between prev and cur, plus
 *      sampled drift between cur and the last confirmed scene-cut frame.
 *   2. Gate: if MAD is below threshold, skip WASM entirely.
 *   3. WASM MEanalysis returns rawScore (inline WasmBridge or worker pool).
 *      rawScore is sigmoid-calibrated to p_cut.
 *   4. Fade rescue: when p_cut < 0.5 and drift-vs-keyframe is high, run a
 *      second WASM pass with thresholds * 0.6. The C code re-evaluates with
 *      the looser bar so rawScore actually changes.
 *   5. Emit immediately on p_cut >= 0.5. Confirmed scene frames flag a
 *      pending keyframe refresh; the next frame's bytes become the new
 *      drift reference. The C code's intraCount boost suppresses re-firing
 *      on the next ~30 frames so back-to-back duplicate emits do not happen.
 *
 * Worker pool path: main thread owns the pre-pass and keyframe state. Only
 * MEanalysis is dispatched. Results drain in frame order. Spare prev/cur
 * copies are stashed pre-dispatch only when drift is high enough that
 * rescue is plausible.
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
   * thread still owns pre-pass and keyframe state.
   */
  pool?: MotionWorkerPool;
}

export type SceneDetectorOptions = DetectionOptions & DetectorExtras;

interface PendingAnalysis {
  frameNumber: number;
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
    const intraThresh = base.intraThresh;
    const intraThresh2 = base.intraThresh2;

    if (!pool) {
      this.wasmBridge.allocateBuffers(metadata.resolution.width, metadata.resolution.height);
    }

    // Smoother is configured to pass through (minGap=1, lookahead=0). The
    // dedup it performs is a safety net only. The WASM intraCount boost in
    // detection.c already suppresses re-firing on adjacent frames.
    const smoother = new SceneSmoother({ minGap: 1, lookahead: 0, threshold: 0.5 });

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

    // Drift reference: snapshot of the last confirmed scene-cut frame.
    // This is the cumulative-since-cut measure, not a per-frame EMA. It does
    // not chase fades or dissolves, so slow transitions stay visible.
    let keyframeData: Uint8Array | null = null;
    // Set by emit(); the main loop snaps keyframe to the next frame's bytes.
    // For pool path, emit happens after the dispatching frame is gone, so we
    // cannot refresh from that frame's bytes directly. One-frame lag is fine.
    let pendingKeyframeRefresh = false;

    // Gate: skip WASM only when prev->cur is essentially static.
    // Threshold 1.5 keeps low-contrast cuts (talking-head A->B, similar-lit
    // reverse shots) reaching WASM where motion estimation can resolve them.
    const gateStride = 64;
    const gateMad = 1.5;

    // Drift threshold for fade rescue (vs keyframeData). Stride 4 captures
    // localized changes (subtitles, lower-thirds, character entry).
    const driftStride = 4;
    const driftRescue = 30;
    const fadeFactor = 0.6;

    const signal = this.options.signal;

    const inflight: PendingAnalysis[] = [];
    const maxInflight = pool ? Math.max(2, pool.size * 2) : 0;

    const refreshKeyframe = (data: Uint8Array): void => {
      keyframeData = data.slice();
    };

    const emit = (frameNumber: number, pCut: number): void => {
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
        pendingKeyframeRefresh = true;
      }
      if (emissions.length === 0) {
        this.state.intraCount++;
      }
    };

    const commitInline = (
      frameNumber: number,
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
      if (pCut < 0.5 && keyframeData && drift >= driftRescue) {
        const fadeThresh = Math.round(dispatchedThresh * fadeFactor);
        const fadeThresh2 = Math.round(dispatchedThresh2 * fadeFactor);
        const fadeRes = this.wasmBridge.detectSceneChangeStateless(
          prevData, curData, width, height,
          dispatchedIntraCount, this.state.fcode,
          fadeThresh, fadeThresh2
        );
        // Stateless overwrites both slots, so reset double-buffer state.
        // The next regular call will re-pad prev fresh.
        this.wasmBridge.resetBufferState();
        const pCutFade = calibratePCut(fadeRes.rawScore, fadeThresh2);
        if (pCutFade > pCut) pCut = pCutFade;
      }
      emit(frameNumber, pCut);
    };

    const commitFromPool = async (head: PendingAnalysis): Promise<void> => {
      const result = await head.promise;
      let pCut = calibratePCut(result.rawScore, head.intraThresh2AtDispatch);
      if (
        pCut < 0.5 &&
        head.drift >= driftRescue &&
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
      emit(head.frameNumber, pCut);
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

        // Lazy keyframe refresh: snap to the current frame's bytes when a
        // recent emit flagged it. This is one frame after the actual cut,
        // close enough for cumulative drift to be meaningful.
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
            const needsRescueStash = drift >= driftRescue;

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
            // Below the gate: no WASM. Flush inflight first so smoother
            // sees results in frame order.
            await drainAll();
            emit(frame.frameNumber, 0);
          }
        } else {
          // First frame: seed keyframeData so drift can compute against it
          // right away. The very first scene cut at frame 0 has confidence 1
          // and was pushed before extractFrames started.
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
