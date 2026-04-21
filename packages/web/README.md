# @doedja/scenecut-web

Browser scene change detection. Xvid motion estimation in WebAssembly, decoded via WebCodecs for MP4/MOV, a custom EBML demuxer for MKV/WebM, or `<video>` + `requestVideoFrameCallback` as a universal fallback. No uploads — everything runs in the tab.

```bash
npm install @doedja/scenecut-web
```

Pairs with [`@doedja/scenecut-core`](https://www.npmjs.com/package/@doedja/scenecut-core), which ships the WASM binary and the detector. Your bundler (Vite, Rollup, esbuild) needs to serve the WASM files as static assets.

## Quick start (Vite)

```ts
import {
  detectSceneChanges,
  createWebWasmFactory,
  createWebMotionPool
} from '@doedja/scenecut-web';

// Serve these from your public folder (copy from node_modules/@doedja/scenecut-core/dist/)
const wasmBase = new URL('/wasm/', location.href).href;
const glueUrl  = `${wasmBase}detection.wasm.js`;
const wasmUrl  = `${wasmBase}detection.wasm`;

const wasmFactory = createWebWasmFactory({ glueUrl, wasmUrl });

const pool = createWebMotionPool({
  glueUrl, wasmUrl,
  createWorker: () => new Worker(
    new URL('./my-motion-worker.ts', import.meta.url),
    { type: 'module' }
  )
});

async function detect(file: File) {
  const result = await detectSceneChanges(file, {
    wasmFactory,
    pool,
    sensitivity: 'low',
    onProgress: (p) => console.log(`${p.percent}%`),
    onScene: (s) => console.log(`cut @ ${s.timecode}`)
  });
  return result.scenes;
}
```

### The motion worker

Create `my-motion-worker.ts` in your app:

```ts
import { installMotionHandler } from '@doedja/scenecut-core';
import type { WorkerMessagePort } from '@doedja/scenecut-core';
import { createWebWasmFactory } from '@doedja/scenecut-web/wasm-factory';

installMotionHandler(self as unknown as WorkerMessagePort, (glueUrl, wasmUrl) =>
  createWebWasmFactory({ glueUrl, wasmUrl })
);
```

This is the script Vite (or any module-worker-capable bundler) instantiates per worker.

## Decoder auto-selection

`detectSceneChanges` picks the fastest decode path based on the input:

| Input | Path | Speed |
|-------|------|-------|
| MP4 / MOV / M4V | mp4box.js → `VideoDecoder` → I420 Y-plane | near-CPU-bound |
| MKV / WebM / MKA | custom EBML demuxer → `VideoDecoder` → I420 Y-plane | near-CPU-bound |
| Anything else | `<video>` + `requestVideoFrameCallback` | ~2–4× real-time |

Force a backend with `decoder: 'auto' \| 'webcodecs' \| 'video'`. Default is `'auto'`.

Supported codecs via WebCodecs: H.264, H.265/HEVC, AV1, VP9, VP8. Grayscale is read straight from the I420 Y-plane — no RGB → luma conversion.

## Options

```ts
interface BrowserDetectionOptions {
  wasmFactory: WasmFactory;          // required
  pool?: MotionWorkerPool;           // recommended for speed

  sensitivity?: 'low' | 'medium' | 'high';        // default: 'low'
  searchRange?: 'auto' | 'small' | 'medium' | 'large';
  maxDimension?: number;             // downscale longest side; e.g. 1080
  decoder?: 'auto' | 'webcodecs' | 'video';       // default: 'auto'
  decodeQueueTarget?: number;        // backpressure knob for WebCodecs

  onProgress?: (p: Progress) => void;
  onScene?: (s: SceneInfo) => void;
  signal?: AbortSignal;
}
```

## Result

```ts
interface DetectionResult {
  scenes: Array<{
    frameNumber: number;
    timestamp: number;   // seconds
    timecode: string;    // HH:MM:SS.mmm
    confidence: number;  // 0–1
    duration: number;
    frameCount: number;
  }>;
  metadata: { totalFrames, duration, fps, resolution, codec? };
  stats:    { processingTime, framesPerSecond };
}
```

## Cancellation

```ts
const ctrl = new AbortController();
const result = await detectSceneChanges(file, { wasmFactory, pool, signal: ctrl.signal });
// later:
ctrl.abort();
```

## Low-level sources

If you want to drive the detector yourself, the source classes are exported:

```ts
import {
  WebCodecsSource,   // MP4 / MOV
  MkvSource,         // MKV / WebM
  VideoElementSource // fallback
} from '@doedja/scenecut-web';
```

All implement the `FrameSource` interface from `@doedja/scenecut-core`.

## Exporters

EDL, FCPXML, Premiere markers, Aegisub, CSV, JSON — all re-exported from core:

```ts
import { formatEdl, formatFcpxml, formatPremiereMarkers } from '@doedja/scenecut-web';
const edl = formatEdl(result, 'my-clip');
```

## Example app

See [`apps/web/` in the repo](https://github.com/doedja/scenecut/tree/main/apps/web) — a full batch / queue UI built on this library, deployable as a static site.

## License

GPL-2.0 — derived from [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) (dubhater) and the Xvid motion estimation algorithm.
