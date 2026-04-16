/**
 * scenecut - Scene change detection for Node.js
 *
 * Xvid motion estimation via WebAssembly, with online smoothing
 * and per-video adaptive calibration.
 */

export { SceneDetector } from './detection/detector';
export { FFmpegDecoder } from './decoder/ffmpeg-decoder';
export { WasmBridge, calibratePCut } from './detection/wasm-bridge';
export { SceneSmoother } from './detection/scene-smoother';
export { FrameBuffer } from './decoder/frame-buffer';
export { BufferPool } from './utils/buffer-pool';

export type {
  DetectionOptions,
  DetectionResult,
  SceneInfo,
  VideoMetadata,
  DetectionStats,
  Progress,
  RawFrame,
  SensitivityLevel,
  SearchRange,
  ExportFormat,
  FrameImageOptions
} from './types';

export {
  formatTimecode,
  calculateFcode,
  calculateThresholds,
  validateFrame,
  validateFrameDimensions,
  calculateMBParam,
  calculateFrameMemory,
  estimateProcessingTime
} from './utils/frame-processor';

import { SceneDetector } from './detection/detector';
import { FFmpegDecoder } from './decoder/ffmpeg-decoder';
import { DetectionOptions, DetectionResult, FrameImageOptions } from './types';

/**
 * Detect scene changes in a video file.
 */
export async function detectSceneChanges(
  videoPath: string,
  options?: DetectionOptions
): Promise<DetectionResult> {
  const detector = new SceneDetector(options);
  try {
    return await detector.detect(videoPath);
  } finally {
    detector.destroy();
  }
}

/**
 * Detect scenes and extract a thumbnail per scene.
 */
export async function extractSceneImages(
  videoPath: string,
  options?: DetectionOptions,
  imageOptions?: FrameImageOptions
): Promise<DetectionResult> {
  const detector = new SceneDetector(options);
  try {
    const results = await detector.detect(videoPath);
    if (imageOptions) {
      const decoder = new FFmpegDecoder(videoPath);
      const frameNumbers = results.scenes.map(s => s.frameNumber);
      await decoder.extractFrameImages(frameNumbers, imageOptions);
      decoder.destroy();
    }
    return results;
  } finally {
    detector.destroy();
  }
}

export const version = '2.0.0';

export const info = {
  name: 'scenecut',
  version: '2.0.0',
  description: 'Scene change detection for Node.js using Xvid motion estimation',
  license: 'GPL-2.0',
  credits: {
    original: 'vapoursynth-wwxd by dubhater',
    algorithm: 'Xvid motion estimation'
  }
};
