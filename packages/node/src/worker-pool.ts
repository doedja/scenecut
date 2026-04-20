/**
 * Node worker_threads pool factory.
 *
 * Spawns N Worker instances pointing at the compiled motion-worker entry,
 * wraps each as a WorkerAdapter, and returns a MotionWorkerPool. Node passes
 * absolute filesystem paths instead of URLs — the worker converts them to
 * file:// for dynamic import().
 */

import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
  MotionWorkerPool,
  type WorkerAdapter,
  type WorkerInitMessage,
  type WorkerAnalyzeMessage,
  type WorkerOutboundMessage
} from '@doedja/scenecut-core';

const nodeRequire = createRequire(typeof __filename === 'string'
  ? __filename
  : fileURLToPath(import.meta.url));

function resolveWorkerEntry(): string {
  try {
    return nodeRequire.resolve('@doedja/scenecut/dist/motion-worker.mjs');
  } catch {
    const pkg = nodeRequire.resolve('@doedja/scenecut/package.json');
    return path.join(path.dirname(pkg), 'dist', 'motion-worker.mjs');
  }
}

function resolveWasmAsset(suffix: string): string {
  try {
    return nodeRequire.resolve(`@doedja/scenecut-core/${suffix}`);
  } catch {
    const pkg = nodeRequire.resolve('@doedja/scenecut-core/package.json');
    const base = path.join(path.dirname(pkg), 'dist');
    return suffix === 'wasm' ? path.join(base, 'detection.wasm.js') : path.join(base, 'detection.wasm');
  }
}

export interface CreateNodePoolOptions {
  /** Number of workers. Defaults to os.cpus().length - 1 (clamped to [1, 8]). */
  size?: number;
}

function defaultSize(): number {
  const cores = os.cpus()?.length ?? 4;
  return Math.max(1, Math.min(8, cores - 1));
}

function wrapWorker(w: Worker): WorkerAdapter {
  return {
    postMessage(msg: WorkerInitMessage | WorkerAnalyzeMessage, transfer?: readonly ArrayBuffer[]) {
      if (transfer && transfer.length) {
        w.postMessage(msg, transfer as ArrayBuffer[]);
      } else {
        w.postMessage(msg);
      }
    },
    onMessage(cb: (msg: WorkerOutboundMessage) => void) {
      w.on('message', (data: WorkerOutboundMessage) => cb(data));
    },
    onError(cb: (err: Error) => void) {
      w.on('error', cb);
      w.on('messageerror', () => cb(new Error('worker messageerror')));
    },
    async terminate() {
      await w.terminate();
    }
  };
}

export function createNodeMotionPool(opts: CreateNodePoolOptions = {}): MotionWorkerPool {
  const size = opts.size ?? defaultSize();
  const workerEntry = resolveWorkerEntry();
  const glueUrl = resolveWasmAsset('wasm');
  const wasmUrl = resolveWasmAsset('wasm-binary');
  return new MotionWorkerPool({
    size,
    glueUrl,
    wasmUrl,
    createWorker: () => wrapWorker(new Worker(workerEntry))
  });
}
