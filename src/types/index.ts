/**
 * Type definitions for scenecut
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
  /** Frame number where scene change occurs */
  frameNumber: number;
  /** Timestamp in seconds */
  timestamp: number;
  /** Human-readable timecode (HH:MM:SS.mmm) */
  timecode?: string;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Duration of this scene in seconds */
  duration?: number;
  /** Number of frames in this scene */
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

/**
 * Detection options. Minimal surface — the detector auto-calibrates and smooths internally.
 */
export interface DetectionOptions {
  /** Detection sensitivity level (default: 'low') */
  sensitivity?: SensitivityLevel;
  /** Motion search range (default: 'auto') */
  searchRange?: SearchRange;
  /** Progress callback */
  onProgress?: (progress: Progress) => void;
  /** Scene change callback */
  onScene?: (scene: SceneInfo) => void;
  /** Output format */
  format?: ExportFormat;
  /** AbortSignal for cancellation */
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
  ccall: (ident: string, returnType: string, argTypes: string[], args: any[]) => any;
  cwrap: (ident: string, returnType: string, argTypes: string[]) => (...args: any[]) => any;
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

export interface CsvExportOptions {
  header?: boolean;
  delimiter?: string;
}

export interface EdlExportOptions {
  title?: string;
  fcm?: 'DROP FRAME' | 'NON-DROP FRAME';
}

export interface FrameImageOptions {
  outputDir: string;
  format?: 'jpg' | 'png' | 'bmp';
  quality?: number;
  width?: number;
  filenameTemplate?: string;
}
