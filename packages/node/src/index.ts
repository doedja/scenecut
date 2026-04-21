/**
 * @doedja/scenecut — scene change detection for Node.js.
 * FFmpeg-driven decoder; Xvid motion estimation (WASM) via @doedja/scenecut-core.
 */

import { SceneDetector } from '@doedja/scenecut-core';
import type { DetectionResult, SceneDetectorOptions } from '@doedja/scenecut-core';
import { FFmpegDecoder } from './ffmpeg-decoder';
import { nodeWasmFactory } from './wasm-factory';
import { createNodeMotionPool } from './worker-pool';
import type { FrameImageOptions } from './types';

export { SceneDetector, WasmBridge, SceneSmoother, calibratePCut } from '@doedja/scenecut-core';
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
  WasmModule,
  WasmFactory,
  FrameSource
} from '@doedja/scenecut-core';
export {
  formatTimecode,
  calculateFcode,
  calculateThresholds,
  validateFrame,
  validateFrameDimensions,
  calculateMBParam,
  calculateFrameMemory,
  estimateProcessingTime,
  secondsToSmpte,
  frameDurationNumDen,
  formatJson,
  formatCsv,
  formatAegisub,
  formatTimecodeList,
  formatEdl,
  formatPremiereMarkers,
  formatFcpxml
} from '@doedja/scenecut-core';

export { FFmpegDecoder } from './ffmpeg-decoder';
export { nodeWasmFactory } from './wasm-factory';
export { createNodeMotionPool } from './worker-pool';
export type { CreateNodePoolOptions } from './worker-pool';
export type { FrameImageOptions, CsvExportOptions, EdlExportOptions } from './types';

export interface NodeDetectionOptions extends SceneDetectorOptions {
  /**
   * Parallelize WASM motion estimation across N worker threads.
   *   - number: explicit pool size
   *   - true:   auto-size (cores - 1, clamped to [1, 8])
   *   - false / undefined: single-threaded (legacy behavior)
   *
   * Ignored when `pool` is provided directly.
   */
  workers?: number | boolean;
}

async function runDetection(
  videoPath: string,
  options?: NodeDetectionOptions,
  afterDetect?: (source: FFmpegDecoder, result: DetectionResult) => Promise<void>
): Promise<DetectionResult> {
  const wantsPool = options?.pool ?? (options?.workers != null && options.workers !== false);
  const pool = options?.pool
    ?? (wantsPool
      ? createNodeMotionPool({ size: typeof options?.workers === 'number' ? options.workers : undefined })
      : undefined);

  const detectorOptions: SceneDetectorOptions = { ...options, pool };
  const detector = new SceneDetector(nodeWasmFactory, detectorOptions);
  const source = new FFmpegDecoder(videoPath, { pixelFormat: 'gray', maxBufferFrames: 2 });
  const ownsPool = pool != null && options?.pool == null;
  try {
    const result = await detector.detect(source);
    if (afterDetect) await afterDetect(source, result);
    return result;
  } finally {
    detector.destroy();
    source.destroy();
    if (ownsPool && pool) await pool.destroy();
  }
}

export function detectSceneChanges(
  videoPath: string,
  options?: NodeDetectionOptions
): Promise<DetectionResult> {
  return runDetection(videoPath, options);
}

export function extractSceneImages(
  videoPath: string,
  options?: NodeDetectionOptions,
  imageOptions?: FrameImageOptions
): Promise<DetectionResult> {
  return runDetection(videoPath, options, async (source, result) => {
    if (imageOptions) {
      await source.extractFrameImages(result.scenes.map(s => s.frameNumber), imageOptions);
    }
  });
}

export const version = '3.0.1';

export const info = {
  name: 'scenecut',
  version: '3.0.1',
  description: 'Scene change detection for Node.js using Xvid motion estimation',
  license: 'GPL-2.0',
  credits: {
    original: 'vapoursynth-wwxd by dubhater',
    algorithm: 'Xvid motion estimation'
  }
};
