/**
 * Scene Detector - Main orchestrator for scene change detection
 */

import { FFmpegDecoder } from '../decoder/ffmpeg-decoder';
import { WasmBridge } from './wasm-bridge';
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
  validateFrame
} from '../utils/frame-processor';

export class SceneDetector {
  private options: Required<DetectionOptions>;
  private wasmBridge: WasmBridge;
  private state: DetectionState;

  constructor(options: DetectionOptions = {}) {
    // Set default options
    this.options = {
      sensitivity: options.sensitivity || 'medium',
      customThresholds: options.customThresholds || { intraThresh: 2000, intraThresh2: 90 },
      searchRange: options.searchRange || 'medium',
      workers: options.workers || 1, // Multi-threading not implemented yet
      progressive: options.progressive || { enabled: false, initialStep: 1, refinementSteps: [] },
      temporalSmoothing: options.temporalSmoothing || { enabled: false, windowSize: 5, minConsecutive: 2 },
      frameExtraction: options.frameExtraction || { pixelFormat: 'gray', maxBufferFrames: 2 },
      onProgress: options.onProgress || (() => {}),
      onScene: options.onScene || (() => {}),
      format: options.format || 'json'
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

    // Pre-allocate WASM buffers (eliminates per-frame allocation overhead)
    this.wasmBridge.allocateBuffers(
      metadata.resolution.width,
      metadata.resolution.height
    );

    // Initialize scene list (frame 0 is always a scene change)
    const scenes: SceneInfo[] = [
      {
        frameNumber: 0,
        timestamp: 0,
        timecode: '00:00:00.000'
      }
    ];

    // Processing statistics
    const startTime = Date.now();
    let processedFrames = 0;

    // Process frames
    await decoder.extractFrames(
      async (frame: RawFrame) => {
        validateFrame(frame);

        // Update current frame
        this.state.curFrame = frame;

        // Need at least 2 frames to detect scene change
        if (this.state.prevFrame) {
          const isSceneChange = this.wasmBridge.detectSceneChange(
            this.state.prevFrame,
            this.state.curFrame,
            this.state.intraCount,
            this.state.fcode
          );

          if (isSceneChange) {
            const scene: SceneInfo = {
              frameNumber: frame.frameNumber,
              timestamp: frame.pts,
              timecode: formatTimecode(frame.pts)
            };

            scenes.push(scene);

            // Call scene callback
            this.options.onScene(scene);

            // Reset intraCount
            this.state.intraCount = 1;
          } else {
            // Increment intraCount
            this.state.intraCount++;
          }
        }

        // Move current frame to previous
        this.state.prevFrame = this.state.curFrame;

        processedFrames++;
      },
      (current: number, total: number) => {
        // Progress callback
        const progress: Progress = {
          currentFrame: current,
          totalFrames: total,
          percent: Math.round((current / total) * 100)
        };

        // Calculate ETA
        const elapsed = (Date.now() - startTime) / 1000;
        const fps = current / elapsed;
        const remaining = (total - current) / fps;
        progress.eta = remaining;

        this.options.onProgress(progress);
      }
    );

    // Calculate statistics
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    const framesPerSecond = processedFrames / processingTime;

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
