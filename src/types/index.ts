/**
 * Type definitions for keyframes scene detection library
 */

/**
 * 2D motion vector
 */
export interface Vector {
  x: number;
  y: number;
}

/**
 * Raw frame data
 */
export interface RawFrame {
  /** Raw pixel data (grayscale, 1 byte per pixel) */
  data: Uint8Array;
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Row stride (may differ from width due to padding) */
  stride: number;
  /** Presentation timestamp in seconds */
  pts: number;
  /** Frame number (0-indexed) */
  frameNumber: number;
}

/**
 * Scene change information
 */
export interface SceneInfo {
  /** Frame number where scene change occurs */
  frameNumber: number;
  /** Timestamp in seconds */
  timestamp: number;
  /** Human-readable timecode (HH:MM:SS.mmm) */
  timecode?: string;
  /** Confidence score (0-1), if available */
  confidence?: number;
}

/**
 * Video metadata
 */
export interface VideoMetadata {
  /** Total number of frames */
  totalFrames: number;
  /** Video duration in seconds */
  duration: number;
  /** Frames per second */
  fps: number;
  /** Video resolution */
  resolution: {
    width: number;
    height: number;
  };
}

/**
 * Detection statistics
 */
export interface DetectionStats {
  /** Total processing time in seconds */
  processingTime: number;
  /** Processing speed in frames per second */
  framesPerSecond: number;
}

/**
 * Complete detection result
 */
export interface DetectionResult {
  /** Array of detected scene changes */
  scenes: SceneInfo[];
  /** Video metadata */
  metadata: VideoMetadata;
  /** Processing statistics */
  stats?: DetectionStats;
}

/**
 * Progress information
 */
export interface Progress {
  /** Current frame number */
  currentFrame: number;
  /** Total frames to process */
  totalFrames: number;
  /** Progress percentage (0-100) */
  percent: number;
  /** Estimated time remaining in seconds */
  eta?: number;
}

/**
 * Sensitivity level for scene detection
 */
export type SensitivityLevel = 'low' | 'medium' | 'high' | 'custom';

/**
 * Search range for motion estimation
 */
export type SearchRange = 'auto' | 'small' | 'medium' | 'large';

/**
 * Custom threshold values
 */
export interface CustomThresholds {
  /** Intra threshold (default: 2000) */
  intraThresh: number;
  /** Secondary intra threshold (default: 90) */
  intraThresh2: number;
}

/**
 * Temporal smoothing configuration
 */
export interface TemporalSmoothing {
  /** Enable temporal smoothing */
  enabled: boolean;
  /** Number of frames to consider in sliding window */
  windowSize: number;
  /** Minimum consecutive frames above threshold */
  minConsecutive: number;
}

/**
 * Progressive processing configuration
 */
export interface ProgressiveProcessing {
  /** Enable progressive processing */
  enabled: boolean;
  /** Initial step size (process every Nth frame) */
  initialStep: number;
  /** Refinement steps (e.g., [4, 2, 1]) */
  refinementSteps: number[];
}

/**
 * Frame extraction options
 */
export interface FrameExtractionOptions {
  /** Pixel format for extraction */
  pixelFormat?: 'gray' | 'yuv420p';
  /** Maximum number of frames to buffer */
  maxBufferFrames?: number;
  /** Skip every N frames (for performance testing) */
  skipFrames?: number;
}

/**
 * Detection options
 */
export interface DetectionOptions {
  // Sensitivity
  /** Detection sensitivity level */
  sensitivity?: SensitivityLevel;
  /** Custom threshold values (only used when sensitivity='custom') */
  customThresholds?: CustomThresholds;

  // Performance
  /** Motion search range */
  searchRange?: SearchRange;
  /** Number of worker threads (default: CPU count - 1) */
  workers?: number;

  // Processing
  /** Progressive processing configuration */
  progressive?: ProgressiveProcessing;

  // Filtering
  /** Temporal smoothing to reduce false positives */
  temporalSmoothing?: TemporalSmoothing;

  // Frame extraction
  /** Frame extraction options */
  frameExtraction?: FrameExtractionOptions;

  // Callbacks
  /** Progress callback */
  onProgress?: (progress: Progress) => void;
  /** Scene change callback */
  onScene?: (scene: SceneInfo) => void;

  // Output
  /** Output format */
  format?: 'json' | 'csv' | 'edl';
}

/**
 * WASM module interface
 */
export interface WasmModule {
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _MEanalysis_js: (
    pRefPtr: number,
    pCurPtr: number,
    width: number,
    height: number,
    intraCount: number,
    fcode: number
  ) => number;
  _calculate_padded_size: (width: number, height: number) => number;
  _pad_frame: (
    srcPtr: number,
    dstPtr: number,
    width: number,
    height: number
  ) => void;
  HEAPU8: Uint8Array;
  ccall: (
    ident: string,
    returnType: string,
    argTypes: string[],
    args: any[]
  ) => any;
  cwrap: (
    ident: string,
    returnType: string,
    argTypes: string[]
  ) => (...args: any[]) => any;
}

/**
 * Internal detection state
 */
export interface DetectionState {
  /** Number of consecutive non-scene-change frames */
  intraCount: number;
  /** Motion search range parameter */
  fcode: number;
  /** Previous frame buffer */
  prevFrame: RawFrame | null;
  /** Current frame buffer */
  curFrame: RawFrame | null;
}

/**
 * Macroblock parameters
 */
export interface MBParam {
  width: number;
  height: number;
  edged_width: number;
  edged_height: number;
  mb_width: number;
  mb_height: number;
  edge_size: number;
}

/**
 * Export format options
 */
export type ExportFormat = 'json' | 'csv' | 'edl';

/**
 * CSV export options
 */
export interface CsvExportOptions {
  /** Include header row */
  header?: boolean;
  /** Field delimiter */
  delimiter?: string;
}

/**
 * EDL export options
 */
export interface EdlExportOptions {
  /** EDL title */
  title?: string;
  /** Frame rate (FCM) */
  fcm?: 'DROP FRAME' | 'NON-DROP FRAME';
}
