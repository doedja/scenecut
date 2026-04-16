/**
 * WASM Bridge — JS⇄WASM interface with double-buffering.
 *
 * Exposes MEanalysis as raw score + sigmoid-calibrated p_cut ∈ [0,1].
 * Keeps prev frame in WASM memory across calls to halve frame-copy cost.
 */

import { WasmModule, RawFrame } from '../types';
import * as path from 'path';
import * as fs from 'fs';

export interface SceneChangeResult {
  /** p_cut ∈ [0,1] — calibrated probability this frame is a cut. */
  pCut: number;
  /** Raw sSAD score from WASM. */
  rawScore: number;
  /** Threshold used, for calibration in smoother. */
  threshold: number;
}

/**
 * Sigmoid calibration of rawScore → p_cut.
 *
 *   p = 1 / (1 + exp(-(rawScore - threshold) / sigma))
 *
 * sigma = threshold/3 places:
 *   - p = 0.5 exactly at the boolean decision boundary (rawScore = threshold)
 *   - p ≈ 0.95 at 2× threshold (strong cut)
 *   - p ≈ 0.05 at 0 (no motion)
 *
 * This replaces the old ad-hoc ratio normalization, which had a kink at the
 * threshold and saturated abruptly.
 */
export function calibratePCut(rawScore: number, threshold: number): number {
  if (threshold <= 0) return rawScore > 0 ? 1 : 0;
  const sigma = threshold / 3;
  const z = (rawScore - threshold) / sigma;
  // Numerically stable sigmoid
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export class WasmBridge {
  private module: WasmModule | null = null;
  private initialized: boolean = false;

  private slotARawPtr: number = 0;
  private slotBRawPtr: number = 0;
  private slotAPaddedPtr: number = 0;
  private slotBPaddedPtr: number = 0;
  private prevIsSlotA: boolean = true;
  private prevSlotPadded: boolean = false;

  private allocatedFrameSize: number = 0;
  private allocatedPaddedSize: number = 0;

  async init(): Promise<void> {
    if (this.initialized) return;

    const wasmPath = path.join(__dirname, '../dist/detection.wasm.js');
    if (!fs.existsSync(wasmPath)) {
      throw new Error(
        `WASM module not found at ${wasmPath}. Run 'npm run build:wasm' to compile it.`
      );
    }
    const createWasmModule = require(wasmPath);
    this.module = await createWasmModule();
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.module) {
      throw new Error('WASM module not initialized. Call init() first.');
    }
  }

  allocateBuffers(width: number, height: number): void {
    this.ensureInitialized();

    const frameSize = width * height;
    const paddedSize = this.module!._calculate_padded_size(width, height);

    if (frameSize !== this.allocatedFrameSize) {
      if (this.slotARawPtr) this.module!._free(this.slotARawPtr);
      if (this.slotBRawPtr) this.module!._free(this.slotBRawPtr);
      this.slotARawPtr = this.module!._malloc(frameSize);
      this.slotBRawPtr = this.module!._malloc(frameSize);
      this.allocatedFrameSize = frameSize;
    }

    if (paddedSize !== this.allocatedPaddedSize) {
      if (this.slotAPaddedPtr) this.module!._free(this.slotAPaddedPtr);
      if (this.slotBPaddedPtr) this.module!._free(this.slotBPaddedPtr);
      this.slotAPaddedPtr = this.module!._malloc(paddedSize);
      this.slotBPaddedPtr = this.module!._malloc(paddedSize);
      this.allocatedPaddedSize = paddedSize;
    }

    this.prevIsSlotA = true;
    this.prevSlotPadded = false;

    const mbResult = this.module!._allocate_mb_array(width, height);
    if (mbResult === 0) {
      throw new Error('Failed to pre-allocate macroblock array in WASM');
    }
  }

  detectSceneChange(
    prevFrame: RawFrame,
    curFrame: RawFrame,
    intraCount: number,
    fcode: number,
    intraThresh: number,
    intraThresh2: number
  ): SceneChangeResult {
    this.ensureInitialized();

    if (prevFrame.width !== curFrame.width || prevFrame.height !== curFrame.height) {
      throw new Error('Frame dimensions must match');
    }

    if (!this.slotARawPtr || this.allocatedFrameSize !== prevFrame.data.length) {
      this.allocateBuffers(prevFrame.width, prevFrame.height);
    }

    const prevRawPtr = this.prevIsSlotA ? this.slotARawPtr : this.slotBRawPtr;
    const prevPaddedPtr = this.prevIsSlotA ? this.slotAPaddedPtr : this.slotBPaddedPtr;
    const curRawPtr = this.prevIsSlotA ? this.slotBRawPtr : this.slotARawPtr;
    const curPaddedPtr = this.prevIsSlotA ? this.slotBPaddedPtr : this.slotAPaddedPtr;

    if (!this.prevSlotPadded) {
      this.module!.HEAPU8.set(prevFrame.data, prevRawPtr);
      this.module!._pad_frame(prevRawPtr, prevPaddedPtr, prevFrame.width, prevFrame.height);
    }

    this.module!.HEAPU8.set(curFrame.data, curRawPtr);
    this.module!._pad_frame(curRawPtr, curPaddedPtr, curFrame.width, curFrame.height);

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

    if (rawScore === -1) {
      throw new Error(
        `WASM memory allocation failed during scene detection. ` +
        `Frame size: ${prevFrame.width}x${prevFrame.height}.`
      );
    }

    this.prevIsSlotA = !this.prevIsSlotA;
    this.prevSlotPadded = true;

    const pCut = calibratePCut(rawScore, intraThresh2);
    return { pCut, rawScore, threshold: intraThresh2 };
  }

  resetBufferState(): void {
    this.prevIsSlotA = true;
    this.prevSlotPadded = false;
  }

  calculatePaddedSize(width: number, height: number): number {
    this.ensureInitialized();
    return this.module!._calculate_padded_size(width, height);
  }

  getMBParam(width: number, height: number) {
    const mb_width = Math.ceil(width / 16);
    const mb_height = Math.ceil(height / 16);
    const edge_size = 64;
    return {
      width, height, mb_width, mb_height,
      edged_width: 16 * mb_width + 2 * edge_size,
      edged_height: 16 * mb_height + 2 * edge_size,
      edge_size
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  destroy(): void {
    if (this.module) {
      this.module._free_mb_array();
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
