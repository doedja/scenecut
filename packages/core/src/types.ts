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
  /** Threshold pair for the cut decision. Default 'medium' (90/2000), which
   * is Xvid's stock MEanalysis pair, i.e. what vapoursynth-scxvid uses.
   * 'low' (150/3000) trades recall for fewer false cuts. */
  sensitivity?: SensitivityLevel;
  /** Motion-estimation search range. Default 'small' (fcode 2, +/-32px),
   * matching scxvid's effective range. Wider ranges compensate real cuts
   * below the threshold and lose recall; use them only when false cuts on
   * fast pans are worse than missed cuts. */
  searchRange?: SearchRange;
  onProgress?: (progress: Progress) => void;
  onScene?: (scene: SceneInfo) => void;
  format?: ExportFormat;
  signal?: AbortSignal;
  /**
   * v2 (experimental, single-thread only). Suppress cuts caused by a global
   * luminance change (flash/fade/strobe). A frame is treated as a flash when
   * the mean signed luma delta is large but the residual MAD after removing
   * that global shift is small (whole frame moved together). Removes the
   * burst false-positives on flashing scenes. Default off (v1 parity).
   */
  flashSuppress?: boolean;
  /**
   * v2 (experimental, single-thread only). Replace the fixed sSAD threshold
   * with a rolling outlier test (EWMA mean + K*std of recent non-cut scores),
   * clamped to [intraThresh2*0.4, intraThresh2]. Lowers the bar in dark/low-
   * contrast scenes where real cuts score below the fixed threshold, without
   * raising it elsewhere. Never exceeds the v1 threshold, so recall only goes
   * up. Default off (v1 parity).
   */
  adaptiveThreshold?: boolean;
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
