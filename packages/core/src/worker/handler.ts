/**
 * Worker-side message handler. A worker script imports this and calls
 * `installMotionHandler(port, factoryFromUrls)` to wire up message processing.
 *
 * `port` abstracts the postMessage / onmessage surface so both Web Workers
 * (self) and Node worker_threads (parentPort) work through the same code.
 */

import { WasmBridge } from '../wasm-bridge';
import type { WasmFactory } from '../types';
import type {
  WorkerAnalyzeMessage,
  WorkerInboundMessage,
  WorkerOutboundMessage
} from './protocol';

export interface WorkerMessagePort {
  postMessage(msg: WorkerOutboundMessage, transfer?: readonly ArrayBuffer[]): void;
  on?: (type: 'message', cb: (ev: WorkerInboundMessage) => void) => void;
  addEventListener?: (type: 'message', cb: (ev: MessageEvent<WorkerInboundMessage>) => void) => void;
}

export type FactoryFromUrls = (glueUrl: string, wasmUrl: string) => WasmFactory;

export function installMotionHandler(port: WorkerMessagePort, factoryFromUrls: FactoryFromUrls): void {
  let bridge: WasmBridge | null = null;

  const handle = async (msg: WorkerInboundMessage) => {
    try {
      if (msg.type === 'init') {
        const factory = factoryFromUrls(msg.glueUrl, msg.wasmUrl);
        bridge = new WasmBridge(factory);
        await bridge.init();
        port.postMessage({ type: 'ready' });
        return;
      }

      if (!bridge) {
        port.postMessage({ type: 'error', message: 'worker not initialized' });
        return;
      }

      if (msg.type === 'analyze') {
        const analyzeMsg = msg as WorkerAnalyzeMessage;
        const result = bridge.detectSceneChangeStateless(
          analyzeMsg.prev,
          analyzeMsg.cur,
          analyzeMsg.width,
          analyzeMsg.height,
          analyzeMsg.intraCount,
          analyzeMsg.fcode,
          analyzeMsg.intraThresh,
          analyzeMsg.intraThresh2
        );
        port.postMessage(
          { type: 'analyzed', id: analyzeMsg.id, rawScore: result.rawScore },
          [analyzeMsg.prev.buffer as ArrayBuffer, analyzeMsg.cur.buffer as ArrayBuffer]
        );
      }
    } catch (err) {
      port.postMessage({
        type: 'error',
        id: (msg as WorkerAnalyzeMessage).id,
        message: (err as Error).message ?? 'worker error'
      });
    }
  };

  // Normalize the event subscription surface
  if (port.addEventListener) {
    port.addEventListener('message', (ev) => { void handle(ev.data); });
  } else if (port.on) {
    port.on('message', (data) => { void handle(data); });
  } else {
    throw new Error('port supports neither addEventListener nor on');
  }
}
