/**
 * Motion-analysis Node worker_threads entry.
 *
 * Runs as a separate thread. Receives (prev, cur) frame pairs, runs WASM
 * motion estimation, returns rawScore. One worker = one WASM instance.
 */

import { parentPort } from 'worker_threads';
import { pathToFileURL } from 'url';
import { installMotionHandler } from '@doedja/scenecut-core';
import type {
  WasmModule,
  WasmFactory,
  WorkerMessagePort
} from '@doedja/scenecut-core';

if (!parentPort) {
  throw new Error('motion-worker must be spawned as a worker_thread');
}

const makeFactory = (glueUrl: string, wasmUrl: string): WasmFactory => {
  return async () => {
    // glueUrl here is an absolute filesystem path from the pool — convert to file:// URL for import().
    const url = glueUrl.startsWith('file:') ? glueUrl : pathToFileURL(glueUrl).href;
    const mod = await import(url) as {
      default: (cfg?: { locateFile?: (f: string) => string }) => Promise<WasmModule>;
    };
    return mod.default({ locateFile: () => wasmUrl });
  };
};

installMotionHandler(parentPort as unknown as WorkerMessagePort, makeFactory);
