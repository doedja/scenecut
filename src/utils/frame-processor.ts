/**
 * Frame Processor - Utilities for frame preprocessing
 */

import { RawFrame } from '../types';

/**
 * Format timestamp as timecode (HH:MM:SS.mmm)
 */
export function formatTimecode(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * Calculate macroblock parameters for frame dimensions
 */
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

/**
 * Check if frame dimensions are valid
 */
export function validateFrameDimensions(width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid frame dimensions: ${width}x${height}`);
  }

  if (width > 8192 || height > 8192) {
    throw new Error(`Frame dimensions too large: ${width}x${height} (max: 8192x8192)`);
  }
}

/**
 * Calculate fcode from search range option
 */
export function calculateFcode(searchRange: 'auto' | 'small' | 'medium' | 'large', width: number, height: number): number {
  switch (searchRange) {
    case 'small':
      return 2; // 64 pixel range
    case 'medium':
      return 4; // 256 pixel range (default)
    case 'large':
      return 6; // 1024 pixel range
    case 'auto':
      // Auto-adjust based on resolution
      const pixels = width * height;
      if (pixels <= 720 * 480) return 3;      // SD: 128px
      if (pixels <= 1920 * 1080) return 4;    // HD: 256px
      return 5;                               // 4K+: 512px
    default:
      return 4;
  }
}

/**
 * Calculate adaptive thresholds based on sensitivity
 */
export function calculateThresholds(sensitivity: 'low' | 'medium' | 'high' | 'custom'): { intraThresh: number; intraThresh2: number } {
  switch (sensitivity) {
    case 'low':
      return { intraThresh: 3000, intraThresh2: 150 };  // Less sensitive
    case 'medium':
      return { intraThresh: 2000, intraThresh2: 90 };   // Default
    case 'high':
      return { intraThresh: 1000, intraThresh2: 50 };   // More sensitive
    case 'custom':
      // Will be overridden by customThresholds
      return { intraThresh: 2000, intraThresh2: 90 };
    default:
      return { intraThresh: 2000, intraThresh2: 90 };
  }
}

/**
 * Validate frame data
 */
export function validateFrame(frame: RawFrame): void {
  if (!frame.data || frame.data.length === 0) {
    throw new Error('Frame data is empty');
  }

  const expectedSize = frame.width * frame.height;
  if (frame.data.length < expectedSize) {
    throw new Error(
      `Frame data size mismatch: expected at least ${expectedSize}, got ${frame.data.length}`
    );
  }

  validateFrameDimensions(frame.width, frame.height);
}

/**
 * Calculate memory usage for frame
 */
export function calculateFrameMemory(width: number, height: number): number {
  const mbParam = calculateMBParam(width, height);
  return mbParam.edged_width * mbParam.edged_height;
}

/**
 * Estimate processing time based on frame count and resolution
 */
export function estimateProcessingTime(
  frameCount: number,
  width: number,
  height: number,
  targetFps: number = 60
): number {
  // Rough estimate: higher resolution = slower
  const resolutionFactor = (width * height) / (1920 * 1080);
  const adjustedFps = targetFps / resolutionFactor;
  return frameCount / adjustedFps;
}
