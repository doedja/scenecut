/**
 * Frame Buffer - Circular buffer for frame management
 *
 * Maintains a circular buffer of frames for efficient scene detection
 * Typically only needs to hold 2 frames (previous and current)
 */

import { RawFrame } from '../types';
import { BufferPool } from '../utils/buffer-pool';

export class FrameBuffer {
  private bufferPool: BufferPool;
  private frames: (RawFrame | null)[];
  private maxFrames: number;
  private currentIndex: number = 0;

  /**
   * Create a new frame buffer
   *
   * @param maxFrames Maximum number of frames to buffer (default: 2)
   * @param bufferPool Optional buffer pool for memory reuse
   */
  constructor(maxFrames: number = 2, bufferPool?: BufferPool) {
    this.maxFrames = maxFrames;
    this.bufferPool = bufferPool || new BufferPool();
    this.frames = new Array(maxFrames).fill(null);
  }

  /**
   * Push a new frame into the buffer
   *
   * @param frame Frame to push
   * @returns The frame that was evicted, if any
   */
  push(frame: RawFrame): RawFrame | null {
    const evictedFrame = this.frames[this.currentIndex];

    // Release the evicted frame's buffer back to pool
    if (evictedFrame) {
      this.bufferPool.release(evictedFrame.data);
    }

    // Store the new frame
    this.frames[this.currentIndex] = frame;

    // Move to next position
    this.currentIndex = (this.currentIndex + 1) % this.maxFrames;

    return evictedFrame;
  }

  /**
   * Get frame at specific offset from current position
   *
   * @param offset Offset from current position (0 = most recent, 1 = previous, etc.)
   * @returns Frame or null if not available
   */
  get(offset: number = 0): RawFrame | null {
    if (offset < 0 || offset >= this.maxFrames) {
      return null;
    }

    const index = (this.currentIndex - 1 - offset + this.maxFrames) % this.maxFrames;
    return this.frames[index];
  }

  /**
   * Get the most recent frame
   */
  getCurrent(): RawFrame | null {
    return this.get(0);
  }

  /**
   * Get the previous frame
   */
  getPrevious(): RawFrame | null {
    return this.get(1);
  }

  /**
   * Get both current and previous frames
   *
   * @returns [current, previous] or null if either is not available
   */
  getCurrentAndPrevious(): [RawFrame, RawFrame] | null {
    const current = this.getCurrent();
    const previous = this.getPrevious();

    if (!current || !previous) {
      return null;
    }

    return [current, previous];
  }

  /**
   * Allocate a buffer for a new frame
   *
   * @param size Buffer size in bytes
   * @returns Uint8Array buffer
   */
  allocateBuffer(size: number): Uint8Array {
    return this.bufferPool.acquire(size);
  }

  /**
   * Clear all frames from the buffer
   */
  clear(): void {
    // Release all buffers back to pool
    for (const frame of this.frames) {
      if (frame) {
        this.bufferPool.release(frame.data);
      }
    }

    this.frames = new Array(this.maxFrames).fill(null);
    this.currentIndex = 0;
  }

  /**
   * Get the number of frames currently in the buffer
   */
  size(): number {
    return this.frames.filter(f => f !== null).length;
  }

  /**
   * Check if buffer is full
   */
  isFull(): boolean {
    return this.size() === this.maxFrames;
  }

  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      maxFrames: this.maxFrames,
      currentFrames: this.size(),
      bufferPoolStats: this.bufferPool.getStats(),
      totalPoolMemory: this.bufferPool.getTotalMemory()
    };
  }
}
