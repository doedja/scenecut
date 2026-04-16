/**
 * Scene Detector — main orchestrator.
 *
 * Pipeline per frame:
 *   1. Fused fast pass: single loop over frame computes sampled MAD (vs prev)
 *      and drift (vs EMA reference). Cheap, ~1.5% of pixels touched.
 *   2. Gate: skip WASM entirely if MAD below quick-reject and drift below
 *      drift-reject. This catches the ~80% of near-identical frames.
 *   3. WASM MEanalysis returns rawScore. Calibrated to p_cut via sigmoid in
 *      the bridge.
 *   4. Fade rescue: if p_cut is moderate (borderline) AND drift is high,
 *      lower the effective threshold locally — no extra WASM run, we already
 *      have the raw score.
 *   5. Warmup (first N frames): collect p_cut distribution and nudge the
 *      detection threshold to match the per-video noise floor.
 *   6. Smoother: non-max suppression with min-gap refractory window.
 *   7. EMA reference updates every frame regardless, so drift tracks slow
 *      content changes (pans, lighting) instead of only the last cut.
 */

import { FFmpegDecoder } from '../decoder/ffmpeg-decoder';
import { WasmBridge, calibratePCut } from './wasm-bridge';
import { SceneSmoother } from './scene-smoother';
import {
  DetectionOptions,
  DetectionResult,
  SceneInfo,
  Progress,
  DetectionState,
  RawFrame
} from '../types';
import {
  formatTimecode,
  calculateFcode,
  calculateThresholds,
  validateFrame
} from '../utils/frame-processor';

export class SceneDetector {
  private options: Required<Pick<DetectionOptions,
    'sensitivity' | 'searchRange' | 'onProgress' | 'onScene' | 'format'
  >> & { signal?: AbortSignal };

  private wasmBridge: WasmBridge;
  private state: DetectionState;

  constructor(options: DetectionOptions = {}) {
    this.options = {
      sensitivity: options.sensitivity || 'low',
      searchRange: options.searchRange || 'auto',
      onProgress: options.onProgress || (() => {}),
      onScene: options.onScene || (() => {}),
      format: options.format || 'json',
      signal: options.signal
    };

    this.wasmBridge = new WasmBridge();
    this.state = { intraCount: 1, fcode: 4, prevFrame: null, curFrame: null };
  }

  async detect(videoPath: string): Promise<DetectionResult> {
    await this.wasmBridge.init();

    const decoder = new FFmpegDecoder(videoPath, { pixelFormat: 'gray', maxBufferFrames: 2 });
    const metadata = await decoder.getMetadata();

    this.state.fcode = calculateFcode(
      this.options.searchRange,
      metadata.resolution.width,
      metadata.resolution.height
    );

    const base = calculateThresholds(this.options.sensitivity);
    // intraThresh2 is the sigmoid midpoint and the smoother's decision point.
    // We let the warmup pass shift it to match per-video noise, within bounds.
    let intraThresh = base.intraThresh;
    let intraThresh2 = base.intraThresh2;
    const baseThresh2 = intraThresh2;

    this.wasmBridge.allocateBuffers(metadata.resolution.width, metadata.resolution.height);

    // Gap scaled to framerate: ~0.25s minimum between cuts
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

    // --- Fade detection state (EMA reference, replaces stale keyframe) ---
    // EMA decays slowly enough to accumulate fade drift but fast enough to
    // absorb stable content. alpha=0.03 ≈ 33-frame effective window.
    const frameSize = metadata.resolution.width * metadata.resolution.height;
    const emaStride = 4; // sample every 4th pixel; matches old drift cost
    const emaSamples = Math.floor(frameSize / emaStride);
    const emaRef = new Float32Array(emaSamples);
    const emaAlpha = 0.03;
    // Drift threshold on sampled MAD against EMA (grayscale 0-255).
    const driftRescue = 25;
    // Fade rescue scales thresh2 down by this factor if drift triggers.
    const fadeFactor = 0.6;

    // --- Quick-reject gating ---
    const quickRejectStride = 64;
    const quickRejectThreshold = 4;

    // --- Adaptive warmup ---
    // Collect rawScores over first N frames, set threshold = max(base, p95*1.5).
    const warmupFrames = Math.min(120, Math.max(60, Math.floor(metadata.fps * 2)));
    const warmupScores: number[] = [];
    let warmupDone = false;

    const signal = this.options.signal;

    await decoder.extractFrames(
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

          // === Fused pass: compute sampled MAD, EMA drift, AND update EMA in one walk.
          // MAD samples at quickRejectStride (sparse). Drift + EMA update walk
          // at emaStride. Running both in a single loop halves memory reads
          // vs two passes at stride 4.
          let madSum = 0;
          let madCount = 0;
          let driftSum = 0;
          const a = emaAlpha;
          const b = 1 - a;
          const madEvery = quickRejectStride / emaStride; // integer: 16
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

          let pCut = 0;
          let rawScore = 0;

          // Gate: skip WASM only if both signals quiet
          if (mad >= quickRejectThreshold || drift >= driftRescue) {
            const res = this.wasmBridge.detectSceneChange(
              this.state.prevFrame,
              this.state.curFrame,
              this.state.intraCount,
              this.state.fcode,
              intraThresh,
              intraThresh2
            );
            rawScore = res.rawScore;
            pCut = res.pCut;

            // Fade rescue — recompute p_cut against a lower threshold if
            // drift is elevated. No extra WASM call; we already have rawScore.
            if (pCut < 0.5 && drift >= driftRescue) {
              const loweredThresh = Math.round(intraThresh2 * fadeFactor);
              const pCutFade = calibratePCut(rawScore, loweredThresh);
              if (pCutFade > pCut) pCut = pCutFade;
            }

            // Warmup calibration: watch rawScore of non-cut frames to size the
            // noise floor. We use pCut<0.5 under current threshold as proxy.
            if (!warmupDone) {
              warmupScores.push(rawScore);
              if (warmupScores.length >= warmupFrames) {
                warmupDone = true;
                // Robust p95 of observed rawScores.
                const sorted = warmupScores.slice().sort((a, b) => a - b);
                const p95 = sorted[Math.floor(sorted.length * 0.95)];
                const calibrated = Math.max(baseThresh2, Math.round(p95 * 1.5));
                // Clamp to ≤ 4× base to avoid pathological cases on cut-heavy
                // warmup (trailers etc).
                intraThresh2 = Math.min(calibrated, baseThresh2 * 4);
                // Scale intraThresh proportionally so intra-block detection
                // stays consistent with sSAD expectations.
                intraThresh = Math.round(base.intraThresh * (intraThresh2 / baseThresh2));
              }
            }
          }

          // Feed smoother. It applies NMS over a minGap window before
          // confirming. No flash rule — low-prob single frames are dropped
          // by the threshold gate inside the smoother.
          const emissions = smoother.observe(frame.frameNumber, pCut);
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
          // EMA already updated in fused pass above.
        } else {
          // First frame seeds the EMA.
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

    // Flush any pending smoother candidates
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

    // Scene durations & frame counts
    for (let i = 0; i < scenes.length; i++) {
      if (i < scenes.length - 1) {
        scenes[i].duration = scenes[i + 1].timestamp - scenes[i].timestamp;
        scenes[i].frameCount = scenes[i + 1].frameNumber - scenes[i].frameNumber;
      } else {
        scenes[i].duration = metadata.duration - scenes[i].timestamp;
        scenes[i].frameCount = metadata.totalFrames - scenes[i].frameNumber;
      }
    }

    decoder.destroy();

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
