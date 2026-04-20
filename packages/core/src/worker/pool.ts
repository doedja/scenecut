/**
 * Motion worker pool — orchestrates N workers doing WASM motion estimation
 * in parallel. Platform-neutral: Web Workers and Node worker_threads both
 * fit through the WorkerAdapter interface.
 */

import type {
  WorkerInitMessage,
  WorkerAnalyzeMessage,
  WorkerOutboundMessage
} from './protocol';

/** Platform-neutral adapter for one worker instance. */
export interface WorkerAdapter {
  /** Send a message. Transferable list is honored on web, ignored on node. */
  postMessage(msg: WorkerInitMessage | WorkerAnalyzeMessage, transfer?: readonly ArrayBuffer[]): void;
  /** Subscribe to worker output. */
  onMessage(cb: (msg: WorkerOutboundMessage) => void): void;
  /** Subscribe to terminal worker errors. */
  onError(cb: (err: Error) => void): void;
  /** Terminate the worker. */
  terminate(): Promise<void> | void;
}

export interface MotionPoolOptions {
  /** Factory creating one worker adapter. Called `size` times. */
  createWorker: () => WorkerAdapter;
  /** Number of workers. Clamped to [1, 32]. */
  size: number;
  /** URL of the emscripten ES-module glue. */
  glueUrl: string;
  /** URL of the raw WASM binary. */
  wasmUrl: string;
}

export interface AnalyzeRequest {
  width: number;
  height: number;
  intraCount: number;
  fcode: number;
  intraThresh: number;
  intraThresh2: number;
  /** Gets transferred to the worker. Caller must have copied if reuse is needed. */
  prev: Uint8Array;
  cur: Uint8Array;
}

export interface AnalyzeResult {
  rawScore: number;
}

interface PendingJob {
  id: number;
  resolve: (r: AnalyzeResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  adapter: WorkerAdapter;
  pending: Map<number, PendingJob>;
}

export class MotionWorkerPool {
  readonly size: number;
  private slots: Slot[] = [];
  private ready: Promise<void> | null = null;
  private destroyed = false;
  private rr = 0;
  private nextId = 1;

  constructor(private options: MotionPoolOptions) {
    this.size = Math.max(1, Math.min(32, options.size | 0));
  }

  /** Boot all workers and wait for 'ready'. Idempotent. */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = Promise.all(
      Array.from({ length: this.size }, () => this.spawnSlot())
    ).then(() => undefined);
    return this.ready;
  }

  private spawnSlot(): Promise<void> {
    const adapter = this.options.createWorker();
    const slot: Slot = { adapter, pending: new Map() };
    this.slots.push(slot);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('worker init timeout after 30s'));
      }, 30_000);

      adapter.onMessage((msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (msg.type === 'analyzed') {
          const job = slot.pending.get(msg.id);
          if (job) {
            slot.pending.delete(msg.id);
            job.resolve({ rawScore: msg.rawScore });
          }
          return;
        }
        if (msg.type === 'error') {
          if (msg.id != null) {
            const job = slot.pending.get(msg.id);
            if (job) {
              slot.pending.delete(msg.id);
              job.reject(new Error(msg.message));
              return;
            }
          }
          clearTimeout(timeout);
          reject(new Error(msg.message));
        }
      });

      adapter.onError((err) => {
        clearTimeout(timeout);
        // Reject any pending jobs on this slot
        for (const job of slot.pending.values()) job.reject(err);
        slot.pending.clear();
        reject(err);
      });

      adapter.postMessage({
        type: 'init',
        glueUrl: this.options.glueUrl,
        wasmUrl: this.options.wasmUrl
      });
    });
  }

  /** Submit an analysis job. The prev/cur buffers are transferred to the worker. */
  analyze(req: AnalyzeRequest): Promise<AnalyzeResult> {
    if (this.destroyed) return Promise.reject(new Error('pool destroyed'));
    if (!this.ready) return Promise.reject(new Error('pool not initialized'));

    const slot = this.slots[this.rr++ % this.slots.length];
    const id = this.nextId++;

    return new Promise<AnalyzeResult>((resolve, reject) => {
      slot.pending.set(id, { id, resolve, reject });
      const msg: WorkerAnalyzeMessage = {
        type: 'analyze',
        id,
        width: req.width,
        height: req.height,
        intraCount: req.intraCount,
        fcode: req.fcode,
        intraThresh: req.intraThresh,
        intraThresh2: req.intraThresh2,
        prev: req.prev,
        cur: req.cur
      };
      slot.adapter.postMessage(msg, [req.prev.buffer as ArrayBuffer, req.cur.buffer as ArrayBuffer]);
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const terms = this.slots.map(s => Promise.resolve(s.adapter.terminate()));
    this.slots = [];
    this.ready = null;
    await Promise.all(terms);
  }
}
