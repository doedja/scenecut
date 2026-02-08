/**
 * WASM Bridge - Interface between JavaScript and WebAssembly
 *
 * This module handles:
 * - Loading the WASM module
 * - Memory allocation and management
 * - Calling WASM functions
 * - Data marshalling between JS and WASM
 * - Double-buffering to avoid redundant frame copies
 */

import { WasmModule, RawFrame } from '../types';
import * as path from 'path';
import * as fs from 'fs';

export interface SceneChangeResult {
  isSceneChange: boolean;
  confidence: number;
}

export class WasmBridge {
  private module: WasmModule | null = null;
  private initialized: boolean = false;

  // Double-buffered WASM pointers for frame processing
  // Slot A and Slot B raw frame buffers
  private slotARawPtr: number = 0;
  private slotBRawPtr: number = 0;
  // Slot A and Slot B padded frame buffers
  private slotAPaddedPtr: number = 0;
  private slotBPaddedPtr: number = 0;
  // Which slot currently holds the "previous" frame (true = A, false = B)
  private prevIsSlotA: boolean = true;
  // Whether the previous slot has valid padded data
  private prevSlotPadded: boolean = false;

  private allocatedFrameSize: number = 0;
  private allocatedPaddedSize: number = 0;

  // Frame dimensions (reserved for future use in validation/resizing)

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
   * Pre-allocate WASM buffers for frame processing.
   * Allocates double-buffered raw + padded slots and pre-allocates the MB array.
   */
  allocateBuffers(width: number, height: number): void {
    this.ensureInitialized();

    const frameSize = width * height;
    const paddedSize = this.module!._calculate_padded_size(width, height);

    // Allocate or re-allocate raw frame buffers if size changed
    if (frameSize !== this.allocatedFrameSize) {
      if (this.slotARawPtr) this.module!._free(this.slotARawPtr);
      if (this.slotBRawPtr) this.module!._free(this.slotBRawPtr);

      this.slotARawPtr = this.module!._malloc(frameSize);
      this.slotBRawPtr = this.module!._malloc(frameSize);
      this.allocatedFrameSize = frameSize;
    }

    // Allocate or re-allocate padded frame buffers if size changed
    if (paddedSize !== this.allocatedPaddedSize) {
      if (this.slotAPaddedPtr) this.module!._free(this.slotAPaddedPtr);
      if (this.slotBPaddedPtr) this.module!._free(this.slotBPaddedPtr);

      this.slotAPaddedPtr = this.module!._malloc(paddedSize);
      this.slotBPaddedPtr = this.module!._malloc(paddedSize);
      this.allocatedPaddedSize = paddedSize;
    }

    // Reset double-buffer state
    this.prevIsSlotA = true;
    this.prevSlotPadded = false;

    // Pre-allocate macroblock array in WASM
    const mbResult = this.module!._allocate_mb_array(width, height);
    if (mbResult === 0) {
      throw new Error('Failed to pre-allocate macroblock array in WASM');
    }
  }

  /**
   * Detect scene change between two frames using double-buffering.
   *
   * On first call, both frames are copied and padded.
   * On subsequent calls, only the new current frame is copied and padded;
   * the previous frame is already in WASM memory from the last call.
   *
   * @param prevFrame Previous frame
   * @param curFrame Current frame
   * @param intraCount Number of consecutive non-scene-change frames
   * @param fcode Motion search range parameter
   * @param intraThresh Primary intra threshold
   * @param intraThresh2 Secondary intra threshold (sSAD comparison)
   * @returns Scene change result with confidence score
   */
  detectSceneChange(
    prevFrame: RawFrame,
    curFrame: RawFrame,
    intraCount: number,
    fcode: number = 4,
    intraThresh: number = 2000,
    intraThresh2: number = 90
  ): SceneChangeResult {
    this.ensureInitialized();

    // Validate inputs
    if (prevFrame.width !== curFrame.width || prevFrame.height !== curFrame.height) {
      throw new Error('Frame dimensions must match');
    }

    // Ensure buffers are allocated
    if (!this.slotARawPtr || this.allocatedFrameSize !== prevFrame.data.length) {
      this.allocateBuffers(prevFrame.width, prevFrame.height);
    }

    // Determine which slot is "prev" and which is "cur"
    const prevRawPtr = this.prevIsSlotA ? this.slotARawPtr : this.slotBRawPtr;
    const prevPaddedPtr = this.prevIsSlotA ? this.slotAPaddedPtr : this.slotBPaddedPtr;
    const curRawPtr = this.prevIsSlotA ? this.slotBRawPtr : this.slotARawPtr;
    const curPaddedPtr = this.prevIsSlotA ? this.slotBPaddedPtr : this.slotAPaddedPtr;

    // Copy and pad previous frame only if not already valid in WASM
    if (!this.prevSlotPadded) {
      this.module!.HEAPU8.set(prevFrame.data, prevRawPtr);
      this.module!._pad_frame(prevRawPtr, prevPaddedPtr, prevFrame.width, prevFrame.height);
    }

    // Always copy and pad the new current frame
    this.module!.HEAPU8.set(curFrame.data, curRawPtr);
    this.module!._pad_frame(curRawPtr, curPaddedPtr, curFrame.width, curFrame.height);

    // Run motion estimation with parameterized thresholds
    const rawScore = this.module!._MEanalysis_js(
      prevPaddedPtr,
      curPaddedPtr,
      prevFrame.width,
      prevFrame.height,
      intraCount,
      fcode,
      intraThresh,
      intraThresh2
    );

    // Check for WASM error
    if (rawScore === -1) {
      throw new Error(
        'WASM memory allocation failed during scene detection. ' +
        `Frame size: ${prevFrame.width}x${prevFrame.height}. ` +
        'The video resolution may be too high for available WASM memory.'
      );
    }

    // Swap roles: current slot becomes previous for next call
    this.prevIsSlotA = !this.prevIsSlotA;
    this.prevSlotPadded = true;

    // Determine scene change and confidence
    const isSceneChange = rawScore >= intraThresh2;

    // Normalize confidence: 0 when at threshold, 1 at 2x threshold
    // For non-scene-changes, confidence represents "how close" (0 = very far from threshold)
    let confidence: number;
    if (isSceneChange) {
      confidence = Math.min(1.0, rawScore / (intraThresh2 * 2));
    } else {
      confidence = intraThresh2 > 0 ? Math.min(1.0, rawScore / intraThresh2) : 0;
    }

    return { isSceneChange, confidence };
  }

  /**
   * Reset double-buffer state (e.g., after a seek or when starting fresh)
   */
  resetBufferState(): void {
    this.prevIsSlotA = true;
    this.prevSlotPadded = false;
  }

  /**
   * Calculate required buffer size for a padded frame
   */
  calculatePaddedSize(width: number, height: number): number {
    this.ensureInitialized();
    return this.module!._calculate_padded_size(width, height);
  }

  /**
   * Get macroblock parameters for a given frame size
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
    if (this.module) {
      // Free pre-allocated macroblock array
      this.module._free_mb_array();

      // Free double-buffered WASM frame buffers
      if (this.slotARawPtr) this.module._free(this.slotARawPtr);
      if (this.slotBRawPtr) this.module._free(this.slotBRawPtr);
      if (this.slotAPaddedPtr) this.module._free(this.slotAPaddedPtr);
      if (this.slotBPaddedPtr) this.module._free(this.slotBPaddedPtr);
    }

    this.slotARawPtr = 0;
    this.slotBRawPtr = 0;
    this.slotAPaddedPtr = 0;
    this.slotBPaddedPtr = 0;
    this.allocatedFrameSize = 0;
    this.allocatedPaddedSize = 0;
    this.prevSlotPadded = false;

    this.module = null;
    this.initialized = false;
  }
}
