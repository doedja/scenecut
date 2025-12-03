/**
 * WASM Bridge - Interface between JavaScript and WebAssembly
 *
 * This module handles:
 * - Loading the WASM module
 * - Memory allocation and management
 * - Calling WASM functions
 * - Data marshalling between JS and WASM
 */

import { WasmModule, RawFrame } from '../types';
import * as path from 'path';
import * as fs from 'fs';

export class WasmBridge {
  private module: WasmModule | null = null;
  private initialized: boolean = false;

  // Pre-allocated WASM buffers for frame processing
  private prevFramePtr: number = 0;      // Raw previous frame
  private curFramePtr: number = 0;       // Raw current frame
  private prevPaddedPtr: number = 0;     // Padded previous frame
  private curPaddedPtr: number = 0;      // Padded current frame
  private allocatedFrameSize: number = 0;  // Size of raw frame buffers
  private allocatedPaddedSize: number = 0; // Size of padded frame buffers

  /**
   * Initialize the WASM module
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Load the WASM module
      const wasmPath = path.join(__dirname, '../dist/detection.wasm.js');

      if (!fs.existsSync(wasmPath)) {
        throw new Error(
          `WASM module not found at ${wasmPath}. ` +
          `Please run 'npm run build:wasm' to compile the WASM module.`
        );
      }

      // Dynamic import the WASM module
      const createWasmModule = require(wasmPath);
      this.module = await createWasmModule();
      this.initialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize WASM module: ${error}`);
    }
  }

  /**
   * Ensure the WASM module is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.module) {
      throw new Error('WASM module not initialized. Call init() first.');
    }
  }

  /**
   * Pre-allocate WASM buffers for frame processing
   * This eliminates per-frame allocation overhead and reduces memory copies
   *
   * @param width Frame width
   * @param height Frame height
   */
  allocateBuffers(width: number, height: number): void {
    this.ensureInitialized();

    const frameSize = width * height;
    const paddedSize = this.module!._calculate_padded_size(width, height);

    // Allocate or re-allocate raw frame buffers if size changed
    if (frameSize !== this.allocatedFrameSize) {
      if (this.prevFramePtr) this.module!._free(this.prevFramePtr);
      if (this.curFramePtr) this.module!._free(this.curFramePtr);

      this.prevFramePtr = this.module!._malloc(frameSize);
      this.curFramePtr = this.module!._malloc(frameSize);
      this.allocatedFrameSize = frameSize;
    }

    // Allocate or re-allocate padded frame buffers if size changed
    if (paddedSize !== this.allocatedPaddedSize) {
      if (this.prevPaddedPtr) this.module!._free(this.prevPaddedPtr);
      if (this.curPaddedPtr) this.module!._free(this.curPaddedPtr);

      this.prevPaddedPtr = this.module!._malloc(paddedSize);
      this.curPaddedPtr = this.module!._malloc(paddedSize);
      this.allocatedPaddedSize = paddedSize;
    }
  }

  /**
   * Detect scene change between two frames
   *
   * Uses pre-allocated WASM buffers to eliminate per-frame allocation
   * and reduce memory copies from 3 to 1 per frame.
   *
   * @param prevFrame Previous frame
   * @param curFrame Current frame
   * @param intraCount Number of consecutive non-scene-change frames
   * @param fcode Motion search range parameter (default: 4 = 256 pixels)
   * @returns true if scene change detected, false otherwise
   */
  detectSceneChange(
    prevFrame: RawFrame,
    curFrame: RawFrame,
    intraCount: number,
    fcode: number = 4
  ): boolean {
    this.ensureInitialized();

    // Validate inputs
    if (prevFrame.width !== curFrame.width || prevFrame.height !== curFrame.height) {
      throw new Error('Frame dimensions must match');
    }

    // Ensure buffers are allocated (should be done once at start)
    if (!this.prevFramePtr || this.allocatedFrameSize !== prevFrame.data.length) {
      this.allocateBuffers(prevFrame.width, prevFrame.height);
    }

    // Single copy: Raw frames -> WASM memory (eliminates 2 extra copies)
    this.module!.HEAPU8.set(prevFrame.data, this.prevFramePtr);
    this.module!.HEAPU8.set(curFrame.data, this.curFramePtr);

    // Pad frames in-place in WASM (no copy back to JS)
    this.module!._pad_frame(this.prevFramePtr, this.prevPaddedPtr, prevFrame.width, prevFrame.height);
    this.module!._pad_frame(this.curFramePtr, this.curPaddedPtr, curFrame.width, curFrame.height);

    // Run motion estimation on pre-padded buffers
    const result = this.module!._MEanalysis_js(
      this.prevPaddedPtr,
      this.curPaddedPtr,
      prevFrame.width,
      prevFrame.height,
      intraCount,
      fcode
    );

    return result === 1;
  }

  /**
   * Calculate required buffer size for a padded frame
   *
   * @param width Original frame width
   * @param height Original frame height
   * @returns Required buffer size in bytes
   */
  calculatePaddedSize(width: number, height: number): number {
    this.ensureInitialized();
    return this.module!._calculate_padded_size(width, height);
  }

  /**
   * Get macroblock parameters for a given frame size
   *
   * @param width Frame width
   * @param height Frame height
   * @returns Macroblock parameters
   */
  getMBParam(width: number, height: number) {
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
   * Check if the WASM module is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    // Free pre-allocated WASM buffers
    if (this.module) {
      if (this.prevFramePtr) this.module._free(this.prevFramePtr);
      if (this.curFramePtr) this.module._free(this.curFramePtr);
      if (this.prevPaddedPtr) this.module._free(this.prevPaddedPtr);
      if (this.curPaddedPtr) this.module._free(this.curPaddedPtr);
    }

    this.prevFramePtr = 0;
    this.curFramePtr = 0;
    this.prevPaddedPtr = 0;
    this.curPaddedPtr = 0;
    this.allocatedFrameSize = 0;
    this.allocatedPaddedSize = 0;

    this.module = null;
    this.initialized = false;
  }
}
