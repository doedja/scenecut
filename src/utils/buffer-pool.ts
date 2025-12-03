/**
 * Buffer Pool - Memory management for frame buffers
 *
 * Reuses TypedArray buffers to reduce memory allocation and GC pressure
 */

export class BufferPool {
  private pool: Map<number, Uint8Array[]> = new Map();
  private maxPoolSize: number;

  /**
   * Create a new buffer pool
   *
   * @param maxPoolSize Maximum number of buffers to keep per size (default: 4)
   */
  constructor(maxPoolSize: number = 4) {
    this.maxPoolSize = maxPoolSize;
  }

  /**
   * Acquire a buffer of the specified size
   *
   * @param size Buffer size in bytes
   * @returns Uint8Array buffer
   */
  acquire(size: number): Uint8Array {
    const poolForSize = this.pool.get(size);

    if (poolForSize && poolForSize.length > 0) {
      const buffer = poolForSize.pop()!;
      // Clear the buffer before reuse
      buffer.fill(0);
      return buffer;
    }

    // No buffer available, allocate new one
    return new Uint8Array(size);
  }

  /**
   * Release a buffer back to the pool
   *
   * @param buffer Buffer to release
   */
  release(buffer: Uint8Array): void {
    const size = buffer.length;
    let poolForSize = this.pool.get(size);

    if (!poolForSize) {
      poolForSize = [];
      this.pool.set(size, poolForSize);
    }

    // Only keep buffer if pool not full
    if (poolForSize.length < this.maxPoolSize) {
      poolForSize.push(buffer);
    }
    // Otherwise, let it be garbage collected
  }

  /**
   * Get pool statistics
   */
  getStats(): { size: number; count: number }[] {
    const stats: { size: number; count: number }[] = [];

    for (const [size, buffers] of this.pool.entries()) {
      stats.push({
        size,
        count: buffers.length
      });
    }

    return stats.sort((a, b) => b.size - a.size);
  }

  /**
   * Clear all pooled buffers
   */
  clear(): void {
    this.pool.clear();
  }

  /**
   * Get total memory used by pooled buffers
   */
  getTotalMemory(): number {
    let total = 0;

    for (const [size, buffers] of this.pool.entries()) {
      total += size * buffers.length;
    }

    return total;
  }
}
