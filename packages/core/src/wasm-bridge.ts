/**
 * WASM Bridge — JS⇄WASM interface with double-buffering.
 *
 * The WASM module is injected via a factory so this file stays platform-
 * agnostic. Node passes a factory that requires the emscripten JS glue; the
 * browser passes one that uses `import()` + `locateFile`.
 */

import { WasmModule, WasmFactory, RawFrame } from './types';

export interface SceneChangeResult {
  pCut: number;
  rawScore: number;
  threshold: number;
}

/**
 * Sigmoid calibration of rawScore → p_cut.
 *   p = 1 / (1 + exp(-(rawScore - threshold) / sigma))
 * With sigma = threshold/3: p = 0.5 at threshold, p ≈ 0.95 at 2×, p ≈ 0.05 at 0.
 */
export function calibratePCut(rawScore: number, threshold: number): number {
  if (threshold <= 0) return rawScore > 0 ? 1 : 0;
  const sigma = threshold / 3;
  const z = (rawScore - threshold) / sigma;
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export class WasmBridge {
  private factory: WasmFactory;
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

  constructor(factory: WasmFactory) {
    this.factory = factory;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.module = await this.factory();
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

  /**
   * Stateless scene-change analysis — pads both frames every call instead of
   * reusing the previously padded buffer. Used by worker pool members, where
   * consecutive calls are not guaranteed to be consecutive frames.
   */
  detectSceneChangeStateless(
    prev: Uint8Array,
    cur: Uint8Array,
    width: number,
    height: number,
    intraCount: number,
    fcode: number,
    intraThresh: number,
    intraThresh2: number
  ): SceneChangeResult {
    this.ensureInitialized();

    const frameSize = width * height;
    if (!this.slotARawPtr || this.allocatedFrameSize !== frameSize) {
      this.allocateBuffers(width, height);
    }

    const m = this.module!;
    m.HEAPU8.set(prev, this.slotARawPtr);
    m._pad_frame(this.slotARawPtr, this.slotAPaddedPtr, width, height);
    m.HEAPU8.set(cur, this.slotBRawPtr);
    m._pad_frame(this.slotBRawPtr, this.slotBPaddedPtr, width, height);

    const rawScore = m._MEanalysis_js(
      this.slotAPaddedPtr,
      this.slotBPaddedPtr,
      width, height,
      intraCount, fcode, intraThresh, intraThresh2
    );

    if (rawScore === -1) {
      throw new Error(`WASM memory allocation failed during scene detection. Frame size: ${width}x${height}.`);
    }

    const pCut = calibratePCut(rawScore, intraThresh2);
    return { pCut, rawScore, threshold: intraThresh2 };
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
