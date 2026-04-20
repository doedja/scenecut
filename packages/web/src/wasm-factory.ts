/**
 * Browser WASM factory.
 *
 * The emscripten glue is built with EXPORT_ES6=1, so it's a proper ES module
 * with a default export (the Module factory function). We load it with
 * dynamic import() — works identically in the main thread, module workers,
 * and Node worker_threads.
 */

import type { WasmFactory, WasmModule } from '@doedja/scenecut-core';

export interface WebWasmFactoryOptions {
  /** URL of @doedja/scenecut-core/dist/detection.wasm.js (emscripten ES-module glue). */
  glueUrl: string;
  /** URL of @doedja/scenecut-core/dist/detection.wasm (the raw WASM binary). */
  wasmUrl: string;
}

type ModuleFactory = (config?: { locateFile?: (f: string) => string }) => Promise<WasmModule>;

export function createWebWasmFactory(opts: WebWasmFactoryOptions): WasmFactory {
  return async () => {
    const mod = await import(/* @vite-ignore */ opts.glueUrl) as {
      default?: ModuleFactory;
    } & ModuleFactory;
    const create: ModuleFactory = mod.default ?? (mod as unknown as ModuleFactory);
    if (typeof create !== 'function') {
      throw new Error(`WASM glue at ${opts.glueUrl} did not export a default factory`);
    }
    return create({ locateFile: () => opts.wasmUrl });
  };
}
