/**
 * Node WASM factory. With EXPORT_ES6=1 the glue is a proper ES module,
 * so we load it with dynamic import(). Works from both CJS and ESM.
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import * as path from 'path';
import type { WasmFactory, WasmModule } from '@doedja/scenecut-core';

const nodeRequire = createRequire(typeof __filename === 'string'
  ? __filename
  : fileURLToPath(import.meta.url));

function resolveWasmAsset(suffix: string): string {
  try {
    return nodeRequire.resolve(`@doedja/scenecut-core/${suffix}`);
  } catch {
    const corePkg = nodeRequire.resolve('@doedja/scenecut-core/package.json');
    const base = path.join(path.dirname(corePkg), 'dist');
    return suffix === 'wasm' ? path.join(base, 'detection.wasm.js') : path.join(base, 'detection.wasm');
  }
}

export const nodeWasmFactory: WasmFactory = async () => {
  const glueFsPath = resolveWasmAsset('wasm');
  const wasmFsPath = resolveWasmAsset('wasm-binary');
  const glueUrl = pathToFileURL(glueFsPath).href;
  const mod = await import(glueUrl) as {
    default: (config?: { locateFile?: (f: string) => string }) => Promise<WasmModule>;
  };
  return mod.default({ locateFile: () => wasmFsPath });
};
