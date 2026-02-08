/**
 * Scene Detector - Main orchestrator for scene change detection
 */

import { FFmpegDecoder } from '../decoder/ffmpeg-decoder';
import { WasmBridge } from './wasm-bridge';
import { TemporalSmoother } from './temporal-smoother';
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
  private options: Required<DetectionOptions>;
  private wasmBridge: WasmBridge;
  private state: DetectionState;

  constructor(options: DetectionOptions = {}) {
    // Set default options
    this.options = {
      sensitivity: options.sensitivity || 'low',
      customThresholds: options.customThresholds || { intraThresh: 2000, intraThresh2: 90 },
      searchRange: options.searchRange || 'medium',
      workers: options.workers || 1,
      progressive: options.progressive || { enabled: false, initialStep: 1, refinementSteps: [] },
      temporalSmoothing: options.temporalSmoothing || { enabled: false, windowSize: 5, minConsecutive: 2 },
      frameExtraction: options.frameExtraction || { pixelFormat: 'gray', maxBufferFrames: 2 },
      onProgress: options.onProgress || (() => {}),
      onScene: options.onScene || (() => {}),
      format: options.format || 'json',
      signal: options.signal || undefined as any
    };

    this.wasmBridge = new WasmBridge();

    // Initialize detection state
    this.state = {
      intraCount: 1,
      fcode: 4,
      prevFrame: null,
      curFrame: null
    };
  }

  /**
   * Detect scene changes in a video file
   */
  async detect(videoPath: string): Promise<DetectionResult> {
    // Initialize WASM module
    await this.wasmBridge.init();

    // Create decoder
    const decoder = new FFmpegDecoder(videoPath, {
      pixelFormat: this.options.frameExtraction.pixelFormat,
      maxBufferFrames: this.options.frameExtraction.maxBufferFrames,
      skipFrames: this.options.frameExtraction.skipFrames
    });

    // Get video metadata
    const metadata = await decoder.getMetadata();

    // Calculate fcode from search range
    this.state.fcode = calculateFcode(
      this.options.searchRange,
      metadata.resolution.width,
      metadata.resolution.height
    );

    // Calculate thresholds from sensitivity
    let thresholds: { intraThresh: number; intraThresh2: number };
    if (this.options.sensitivity === 'custom') {
      thresholds = this.options.customThresholds;
    } else {
      thresholds = calculateThresholds(this.options.sensitivity);
    }

    // Pre-allocate WASM buffers
    this.wasmBridge.allocateBuffers(
      metadata.resolution.width,
      metadata.resolution.height
    );

    // Initialize temporal smoother if enabled
    let temporalSmoother: TemporalSmoother | null = null;
    if (this.options.temporalSmoothing.enabled) {
      temporalSmoother = new TemporalSmoother(this.options.temporalSmoothing);
    }

    // Initialize scene list (frame 0 is always a scene change)
    const scenes: SceneInfo[] = [
      {
        frameNumber: 0,
        timestamp: 0,
        timecode: '00:00:00.000',
        confidence: 1.0
      }
    ];

    // Processing statistics
    const startTime = Date.now();
    let processedFrames = 0;
    let firstFrameValidated = false;

    // Rolling FPS window for accurate speed metrics (3-second window)
    const fpsWindow: { time: number; frame: number }[] = [];

    // Fade/dissolve detection state
    let keyframeData: Uint8Array | null = null;
    const driftThresholdFactor = 0.6; // Re-run detection at 60% of base thresholds

    // Quick-reject sampling interval
    const quickRejectStep = 64;
    const quickRejectThreshold = 5;

    // AbortSignal check
    const signal = this.options.signal;

    // Process frames
    await decoder.extractFrames(
      async (frame: RawFrame) => {
        // Check abort signal
        if (signal && signal.aborted) {
          throw new Error('Detection aborted');
        }

        // Validate only the first frame (dimensions never change within a video)
        if (!firstFrameValidated) {
          validateFrame(frame);
          firstFrameValidated = true;
        }

        // Update current frame
        this.state.curFrame = frame;

        // Need at least 2 frames to detect scene change
        if (this.state.prevFrame) {
          let isSceneChange = false;
          let confidence = 0;

          // Quick-reject: sampled MAD between prev and cur frame
          const prevData = this.state.prevFrame.data;
          const curData = this.state.curFrame.data;
          let sampledDiff = 0;
          let sampleCount = 0;
          for (let i = 0; i < curData.length; i += quickRejectStep) {
            sampledDiff += Math.abs(curData[i] - prevData[i]);
            sampleCount++;
          }
          const avgDiff = sampledDiff / sampleCount;

          if (avgDiff >= quickRejectThreshold) {
            // Frame differs enough, run full WASM detection
            const result = this.wasmBridge.detectSceneChange(
              this.state.prevFrame,
              this.state.curFrame,
              this.state.intraCount,
              this.state.fcode,
              thresholds.intraThresh,
              thresholds.intraThresh2
            );

            isSceneChange = result.isSceneChange;
            confidence = result.confidence;

            // Fade/dissolve detection: if not detected as scene change,
            // check drift from last keyframe
            if (!isSceneChange && keyframeData) {
              let driftSum = 0;
              let driftCount = 0;
              // Sample every 4th pixel for speed
              for (let i = 0; i < curData.length; i += 4) {
                driftSum += Math.abs(curData[i] - keyframeData[i]);
                driftCount++;
              }
              const driftAvg = driftSum / driftCount;

              // If cumulative drift is high but per-frame SAD didn't trigger,
              // re-run with lowered thresholds
              if (driftAvg > 30) {
                const fadeResult = this.wasmBridge.detectSceneChange(
                  this.state.prevFrame,
                  this.state.curFrame,
                  this.state.intraCount,
                  this.state.fcode,
                  Math.round(thresholds.intraThresh * driftThresholdFactor),
                  Math.round(thresholds.intraThresh2 * driftThresholdFactor)
                );

                if (fadeResult.isSceneChange) {
                  isSceneChange = true;
                  confidence = fadeResult.confidence;
                }
              }
            }
          }
          // else: quick-reject - frames are nearly identical, skip WASM call

          // Apply temporal smoothing if enabled
          if (temporalSmoother) {
            const smoothed = temporalSmoother.process(frame.frameNumber, isSceneChange, confidence);
            isSceneChange = smoothed.isSceneChange;
            confidence = smoothed.confidence;
          }

          if (isSceneChange) {
            const scene: SceneInfo = {
              frameNumber: frame.frameNumber,
              timestamp: frame.pts,
              timecode: formatTimecode(frame.pts),
              confidence
            };

            scenes.push(scene);

            // Call scene callback
            this.options.onScene(scene);

            // Reset intraCount
            this.state.intraCount = 1;

            // Update keyframe for drift detection
            keyframeData = new Uint8Array(curData);
          } else {
            this.state.intraCount++;
          }
        } else {
          // First frame is the initial keyframe for drift detection
          keyframeData = new Uint8Array(frame.data);
        }

        // Move current frame to previous
        this.state.prevFrame = this.state.curFrame;

        processedFrames++;
      },
      (current: number, total: number) => {
        // Enhanced progress with rolling FPS window
        const now = Date.now();
        const elapsed = (now - startTime) / 1000;

        // Add to rolling window
        fpsWindow.push({ time: now, frame: current });

        // Remove samples older than 3 seconds
        while (fpsWindow.length > 1 && (now - fpsWindow[0].time) > 3000) {
          fpsWindow.shift();
        }

        // Calculate instantaneous FPS from rolling window
        let currentFps = 0;
        if (fpsWindow.length >= 2) {
          const oldest = fpsWindow[0];
          const newest = fpsWindow[fpsWindow.length - 1];
          const dt = (newest.time - oldest.time) / 1000;
          if (dt > 0) {
            currentFps = (newest.frame - oldest.frame) / dt;
          }
        }

        // Calculate ETA from instantaneous FPS
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
      }
    );

    // Calculate statistics
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    const framesPerSecond = processedFrames / processingTime;

    // Post-process: compute scene durations
    for (let i = 0; i < scenes.length; i++) {
      if (i < scenes.length - 1) {
        scenes[i].duration = scenes[i + 1].timestamp - scenes[i].timestamp;
        scenes[i].frameCount = scenes[i + 1].frameNumber - scenes[i].frameNumber;
      } else {
        // Last scene: duration until end of video
        scenes[i].duration = metadata.duration - scenes[i].timestamp;
        scenes[i].frameCount = metadata.totalFrames - scenes[i].frameNumber;
      }
    }

    // Clean up
    decoder.destroy();

    return {
      scenes,
      metadata,
      stats: {
        processingTime,
        framesPerSecond
      }
    };
  }

  /**
   * Destroy the detector and clean up resources
   */
  destroy(): void {
    this.wasmBridge.destroy();
    this.state.prevFrame = null;
    this.state.curFrame = null;
  }
}
