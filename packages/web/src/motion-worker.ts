/**
 * Motion-analysis Web Worker entry. Bundled as a module worker.
 *
 * Receives (prev, cur) frame pairs from the main thread, runs WASM motion
 * estimation, returns rawScore. One worker = one WASM instance.
 */

import { installMotionHandler } from '@doedja/scenecut-core';
import type { WorkerMessagePort } from '@doedja/scenecut-core';
import { createWebWasmFactory } from './wasm-factory';

installMotionHandler(self as unknown as WorkerMessagePort, (glueUrl, wasmUrl) =>
  createWebWasmFactory({ glueUrl, wasmUrl })
);
