/**
 * Web Worker entry for this app. Vite bundles this into a standalone worker
 * script when referenced via `new Worker(new URL('./motion-worker.ts', import.meta.url), { type: 'module' })`.
 */

import { installMotionHandler } from '@doedja/scenecut-core';
import type { WorkerMessagePort } from '@doedja/scenecut-core';
import { createWebWasmFactory } from '@doedja/scenecut-web/wasm-factory';

installMotionHandler(self as unknown as WorkerMessagePort, (glueUrl, wasmUrl) =>
  createWebWasmFactory({ glueUrl, wasmUrl })
);
