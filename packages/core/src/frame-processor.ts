import { RawFrame, SensitivityLevel, SearchRange } from './types';

export function formatTimecode(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

export function calculateMBParam(width: number, height: number) {
  const mb_width = Math.ceil(width / 16);
  const mb_height = Math.ceil(height / 16);
  const edge_size = 64;
  return {
    width,
    height,
    mb_width,
    mb_height,
    edged_width: 16 * mb_width + 2 * edge_size,
    edged_height: 16 * mb_height + 2 * edge_size,
    edge_size
  };
}

export function validateFrameDimensions(width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid frame dimensions: ${width}x${height}`);
  }
  if (width > 8192 || height > 8192) {
    throw new Error(`Frame dimensions too large: ${width}x${height} (max: 8192x8192)`);
  }
}

export function calculateFcode(searchRange: SearchRange, width: number, height: number): number {
  switch (searchRange) {
    case 'small': return 2;
    case 'medium': return 4;
    case 'large': return 6;
    case 'auto': {
      const pixels = width * height;
      if (pixels <= 720 * 480) return 3;
      if (pixels <= 1920 * 1080) return 4;
      return 5;
    }
    default: return 4;
  }
}

export function calculateThresholds(sensitivity: SensitivityLevel): { intraThresh: number; intraThresh2: number } {
  switch (sensitivity) {
    case 'low':    return { intraThresh: 3000, intraThresh2: 150 };
    case 'medium': return { intraThresh: 2000, intraThresh2: 90 };
    case 'high':   return { intraThresh: 1000, intraThresh2: 50 };
    default:       return { intraThresh: 3000, intraThresh2: 150 };
  }
}

export function validateFrame(frame: RawFrame): void {
  if (!frame.data || frame.data.length === 0) {
    throw new Error('Frame data is empty');
  }
  const expectedSize = frame.width * frame.height;
  if (frame.data.length < expectedSize) {
    throw new Error(`Frame data size mismatch: expected at least ${expectedSize}, got ${frame.data.length}`);
  }
  validateFrameDimensions(frame.width, frame.height);
}

export function calculateFrameMemory(width: number, height: number): number {
  const mbParam = calculateMBParam(width, height);
  return mbParam.edged_width * mbParam.edged_height;
}

export function estimateProcessingTime(
  frameCount: number,
  width: number,
  height: number,
  targetFps: number = 60
): number {
  const resolutionFactor = (width * height) / (1920 * 1080);
  const adjustedFps = targetFps / resolutionFactor;
  return frameCount / adjustedFps;
}
