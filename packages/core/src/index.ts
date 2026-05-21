/**
 * @doedja/scenecut-core — platform-agnostic scene detection primitives.
 *
 * Provides the motion-estimation WASM bridge, the detector orchestrator, and
 * shared types. Does not include a decoder. Consumers (node, web) supply a
 * FrameSource and a WasmFactory.
 */

export { SceneDetector } from './detector';
export { WasmBridge, calibratePCut } from './wasm-bridge';

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
  FrameSource,
  DetectionState,
  MBParam
} from './types';

export type { SceneChangeResult } from './wasm-bridge';
export type { SceneDetectorOptions, DetectorExtras } from './detector';
export { MotionWorkerPool } from './worker/pool';
export type {
  MotionPoolOptions,
  WorkerAdapter,
  AnalyzeRequest,
  AnalyzeResult
} from './worker/pool';
export { installMotionHandler } from './worker/handler';
export type { WorkerMessagePort, FactoryFromUrls } from './worker/handler';
export type {
  WorkerInitMessage,
  WorkerAnalyzeMessage,
  WorkerAnalyzeResponse,
  WorkerReadyMessage,
  WorkerErrorMessage,
  WorkerInboundMessage,
  WorkerOutboundMessage
} from './worker/protocol';

export {
  formatTimecode,
  calculateFcode,
  calculateThresholds,
  validateFrame,
  validateFrameDimensions,
  calculateMBParam,
  calculateFrameMemory,
  estimateProcessingTime
} from './frame-processor';

export {
  secondsToSmpte,
  frameDurationNumDen,
  formatJson,
  formatCsv,
  formatAegisub,
  formatTimecodeList,
  formatEdl,
  formatPremiereMarkers,
  formatFcpxml
} from './exporters';
