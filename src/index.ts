/**
 * keyframes - Scene change detection for Node.js
 *
 * A JavaScript/TypeScript port of vapoursynth-wwxd using Xvid's motion estimation algorithm.
 * Powered by WebAssembly for high performance.
 */

export { SceneDetector } from './detection/detector';
export { FFmpegDecoder } from './decoder/ffmpeg-decoder';
export { WasmBridge } from './detection/wasm-bridge';
export { FrameBuffer } from './decoder/frame-buffer';
export { BufferPool } from './utils/buffer-pool';

// Export types
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
  CustomThresholds,
  TemporalSmoothing,
  ProgressiveProcessing,
  FrameExtractionOptions
} from './types';

// Export utilities
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
import { DetectionOptions, DetectionResult } from './types';

/**
 * Detect scene changes in a video file (simple API)
 *
 * @param videoPath Path to video file
 * @param options Detection options
 * @returns Detection results with scene changes and metadata
 *
 * @example
 * ```typescript
 * import { detectSceneChanges } from 'keyframes';
 *
 * const results = await detectSceneChanges('input.mp4');
 * console.log(`Found ${results.scenes.length} scenes`);
 *
 * results.scenes.forEach(scene => {
 *   console.log(`Scene at ${scene.timecode}`);
 * });
 * ```
 */
export async function detectSceneChanges(
  videoPath: string,
  options?: DetectionOptions
): Promise<DetectionResult> {
  const detector = new SceneDetector(options);

  try {
    const results = await detector.detect(videoPath);
    return results;
  } finally {
    detector.destroy();
  }
}

/**
 * Version information
 */
export const version = '1.0.0';

/**
 * Library information
 */
export const info = {
  name: 'keyframes',
  version: '1.0.0',
  description: 'Scene change detection for Node.js using Xvid\'s motion estimation algorithm',
  license: 'GPL-2.0',
  repository: 'https://github.com/yourusername/keyframes',
  author: '',
  credits: {
    original: 'vapoursynth-wwxd by dubhater (https://github.com/dubhater/vapoursynth-wwxd)',
    algorithm: 'Xvid motion estimation (https://www.xvid.com)'
  }
};
