/**
 * @doedja/scenecut-web — browser scene detection.
 *
 * Drives an invisible <video> element with requestVideoFrameCallback, pushes
 * grayscale frames into @doedja/scenecut-core. No SharedArrayBuffer needed,
 * so no COOP/COEP headers are required — works on plain GitHub Pages.
 */

import { SceneDetector } from '@doedja/scenecut-core';
import type { DetectionResult, WasmFactory, MotionWorkerPool, SceneDetectorOptions, FrameSource } from '@doedja/scenecut-core';
import { VideoElementSource } from './video-source';
import type { VideoElementSourceOptions } from './video-source';
import { WebCodecsSource, isWebCodecsSupported, isMp4LikeFile } from './webcodecs-source';
import type { WebCodecsSourceOptions } from './webcodecs-source';
import { MkvSource, isMkvLikeFile } from './mkv-source';
import type { MkvSourceOptions } from './mkv-source';

export { VideoElementSource } from './video-source';
export type { VideoElementSourceOptions } from './video-source';
export { WebCodecsSource, isWebCodecsSupported, isMp4LikeFile } from './webcodecs-source';
export type { WebCodecsSourceOptions } from './webcodecs-source';
export { MkvSource, isMkvLikeFile } from './mkv-source';
export type { MkvSourceOptions } from './mkv-source';
export { createWebWasmFactory } from './wasm-factory';
export type { WebWasmFactoryOptions } from './wasm-factory';
export { createWebMotionPool } from './worker-pool';
export type { CreateWebPoolOptions } from './worker-pool';

export { SceneDetector, WasmBridge, calibratePCut, MotionWorkerPool } from '@doedja/scenecut-core';
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
  WasmModule,
  WasmFactory,
  FrameSource,
  SceneDetectorOptions,
  AnalyzeRequest,
  AnalyzeResult,
  WorkerAdapter,
  WorkerMessagePort
} from '@doedja/scenecut-core';
export {
  formatTimecode,
  calculateFcode,
  calculateThresholds,
  validateFrame,
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

export type DecoderBackend = 'auto' | 'webcodecs' | 'video';

export interface BrowserDetectionOptions extends SceneDetectorOptions, VideoElementSourceOptions, WebCodecsSourceOptions, MkvSourceOptions {
  /** WASM factory for the main thread. Build with createWebWasmFactory({ glueUrl, wasmUrl }). */
  wasmFactory: WasmFactory;
  /** Optional motion worker pool. Parallelizes WASM motion estimation. */
  pool?: MotionWorkerPool;
  /**
   * Which decoder to use.
   *   - 'auto': WebCodecs for MP4/MOV/MKV/WebM when supported, <video> fallback otherwise.
   *   - 'webcodecs': force WebCodecs (fails on unsupported containers / browsers).
   *   - 'video': force the <video>+requestVideoFrameCallback path.
   * Default: 'auto'.
   */
  decoder?: DecoderBackend;
}

function chooseSource(file: File | Blob, opts: BrowserDetectionOptions): FrameSource {
  const backend = opts.decoder ?? 'auto';
  const webCodecs = isWebCodecsSupported();
  const wcOpts: WebCodecsSourceOptions = { maxDimension: opts.maxDimension, decodeQueueTarget: opts.decodeQueueTarget };
  const mkvOpts: MkvSourceOptions = wcOpts;
  const videoOpts: VideoElementSourceOptions = { fps: opts.fps, maxDimension: opts.maxDimension, playbackRate: opts.playbackRate };

  if (backend === 'webcodecs') {
    if (!webCodecs) throw new Error('WebCodecs not supported in this browser');
    if (isMkvLikeFile(file)) return new MkvSource(file, mkvOpts);
    return new WebCodecsSource(file, wcOpts);
  }
  if (backend === 'video') {
    return new VideoElementSource(file, videoOpts);
  }
  // auto
  if (webCodecs) {
    if (isMp4LikeFile(file)) return new WebCodecsSource(file, wcOpts);
    if (isMkvLikeFile(file)) return new MkvSource(file, mkvOpts);
  }
  return new VideoElementSource(file, videoOpts);
}

export async function detectSceneChanges(
  file: File | Blob,
  options: BrowserDetectionOptions
): Promise<DetectionResult> {
  const {
    wasmFactory,
    fps, maxDimension, playbackRate, decodeQueueTarget, decoder: _decoder,
    ...detectionOptions
  } = options;
  void fps; void playbackRate; void maxDimension; void decodeQueueTarget; void _decoder;

  const detector = new SceneDetector(wasmFactory, detectionOptions);
  const source = chooseSource(file, options);
  try {
    return await detector.detect(source);
  } finally {
    detector.destroy();
    if (source.destroy) source.destroy();
  }
}
