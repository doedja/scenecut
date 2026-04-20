/**
 * Message protocol shared between main thread and motion-analysis workers.
 * Platform-neutral: Web Workers and Node worker_threads both use it.
 */

export interface WorkerInitMessage {
  type: 'init';
  glueUrl: string;
  wasmUrl: string;
}

export interface WorkerReadyMessage {
  type: 'ready';
}

export interface WorkerAnalyzeMessage {
  type: 'analyze';
  id: number;
  width: number;
  height: number;
  intraCount: number;
  fcode: number;
  intraThresh: number;
  intraThresh2: number;
  prev: Uint8Array;
  cur: Uint8Array;
}

export interface WorkerAnalyzeResponse {
  type: 'analyzed';
  id: number;
  rawScore: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  id?: number;
  message: string;
}

export type WorkerInboundMessage = WorkerInitMessage | WorkerAnalyzeMessage;
export type WorkerOutboundMessage = WorkerReadyMessage | WorkerAnalyzeResponse | WorkerErrorMessage;
