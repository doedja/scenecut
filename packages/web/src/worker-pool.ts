/**
 * Web Worker pool factory.
 *
 * The caller creates Worker instances (so bundler semantics stay in user code
 * via `new Worker(new URL('...', import.meta.url), { type: 'module' })`) and
 * hands them to `createWebMotionPool`. We wrap each in a WorkerAdapter and
 * give back a MotionWorkerPool ready to go.
 */

import {
  MotionWorkerPool,
  type WorkerAdapter,
  type WorkerInitMessage,
  type WorkerAnalyzeMessage,
  type WorkerOutboundMessage
} from '@doedja/scenecut-core';

export interface CreateWebPoolOptions {
  /**
   * Factory that produces a fresh Worker. Called `size` times. Typical usage:
   *   createWorker: () => new Worker(new URL('./motion-worker.ts', import.meta.url), { type: 'module' })
   */
  createWorker: () => Worker;
  /** Number of workers. Defaults to navigator.hardwareConcurrency - 1 (clamped to [1, 4]). */
  size?: number;
  /** URL of the emscripten ES-module glue. */
  glueUrl: string;
  /** URL of the raw WASM binary. */
  wasmUrl: string;
}

function defaultSize(): number {
  const hw = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, hw - 1));
}

function wrapWorker(worker: Worker): WorkerAdapter {
  return {
    postMessage(msg: WorkerInitMessage | WorkerAnalyzeMessage, transfer?: readonly ArrayBuffer[]) {
      if (transfer && transfer.length) worker.postMessage(msg, transfer as ArrayBuffer[]);
      else worker.postMessage(msg);
    },
    onMessage(cb: (msg: WorkerOutboundMessage) => void) {
      worker.addEventListener('message', (ev: MessageEvent) => cb(ev.data as WorkerOutboundMessage));
    },
    onError(cb: (err: Error) => void) {
      worker.addEventListener('error', (ev: ErrorEvent) => cb(new Error(ev.message || 'worker error')));
      worker.addEventListener('messageerror', () => cb(new Error('worker messageerror')));
    },
    terminate() {
      worker.terminate();
    }
  };
}

export function createWebMotionPool(opts: CreateWebPoolOptions): MotionWorkerPool {
  const size = opts.size ?? defaultSize();
  return new MotionWorkerPool({
    size,
    glueUrl: opts.glueUrl,
    wasmUrl: opts.wasmUrl,
    createWorker: () => wrapWorker(opts.createWorker())
  });
}
