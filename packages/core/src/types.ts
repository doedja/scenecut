/**
 * Shared types for scenecut (platform-agnostic).
 */

export interface Vector {
  x: number;
  y: number;
}

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

export interface SceneInfo {
  frameNumber: number;
  timestamp: number;
  timecode?: string;
  confidence?: number;
  duration?: number;
  frameCount?: number;
}

export interface VideoMetadata {
  totalFrames: number;
  duration: number;
  fps: number;
  resolution: { width: number; height: number };
  codec?: string;
  pixelFormat?: string;
  bitrate?: number;
}

export interface DetectionStats {
  processingTime: number;
  framesPerSecond: number;
}

export interface DetectionResult {
  scenes: SceneInfo[];
  metadata: VideoMetadata;
  stats?: DetectionStats;
}

export interface Progress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
  eta?: number;
  fps?: number;
  elapsed?: number;
  scenesDetected?: number;
}

export type SensitivityLevel = 'low' | 'medium' | 'high';
export type SearchRange = 'auto' | 'small' | 'medium' | 'large';
export type ExportFormat = 'json' | 'csv' | 'edl';

export interface DetectionOptions {
  sensitivity?: SensitivityLevel;
  searchRange?: SearchRange;
  onProgress?: (progress: Progress) => void;
  onScene?: (scene: SceneInfo) => void;
  format?: ExportFormat;
  signal?: AbortSignal;
}

export interface WasmModule {
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _MEanalysis_js: (
    pRefPtr: number,
    pCurPtr: number,
    width: number,
    height: number,
    intraCount: number,
    fcode: number,
    intraThresh: number,
    intraThresh2: number
  ) => number;
  _calculate_padded_size: (width: number, height: number) => number;
  _pad_frame: (srcPtr: number, dstPtr: number, width: number, height: number) => void;
  _allocate_mb_array: (width: number, height: number) => number;
  _free_mb_array: () => void;
  HEAPU8: Uint8Array;
  ccall: (ident: string, returnType: string, argTypes: string[], args: unknown[]) => unknown;
  cwrap: (ident: string, returnType: string, argTypes: string[]) => (...args: unknown[]) => unknown;
}

/** Factory that produces a ready-to-use WASM module instance. */
export type WasmFactory = () => Promise<WasmModule>;

/**
 * Platform-agnostic frame source contract.
 * Node implementations drive ffmpeg; web implementations drive WebCodecs.
 */
export interface FrameSource {
  getMetadata(): Promise<VideoMetadata>;
  extractFrames(
    onFrame: (frame: RawFrame) => Promise<void> | void,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void>;
  destroy?(): void;
}

export interface DetectionState {
  intraCount: number;
  fcode: number;
  prevFrame: RawFrame | null;
  curFrame: RawFrame | null;
}

export interface MBParam {
  width: number;
  height: number;
  edged_width: number;
  edged_height: number;
  mb_width: number;
  mb_height: number;
  edge_size: number;
}
