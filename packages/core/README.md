# @doedja/scenecut-core

Shared scene-detection internals. Platform-agnostic WASM (Xvid motion estimation), the detector orchestrator, the online smoother, and the file-format exporters. No I/O — you supply a `FrameSource` and a `WasmFactory`.

**You probably don't want to install this directly.** It ships transitively with:

- [`@doedja/scenecut`](https://www.npmjs.com/package/@doedja/scenecut) — Node CLI + library
- [`@doedja/scenecut-web`](https://www.npmjs.com/package/@doedja/scenecut-web) — browser library

This package exists so those two can share one detector implementation.

## What's exported

- `SceneDetector` — the orchestrator. Accepts a `WasmFactory` + options, and a `FrameSource` at detection time.
- `WasmBridge` — thin wrapper around the emscripten module with double-buffered frames.
- `SceneSmoother` — online non-max suppression with a refractory gap.
- `MotionWorkerPool` — platform-neutral worker pool abstraction.
- `installMotionHandler` — the worker-side message handler you install in your worker script.
- Exporters: `formatJson`, `formatCsv`, `formatAegisub`, `formatTimecodeList`, `formatEdl`, `formatFcpxml`, `formatPremiereMarkers`, `secondsToSmpte`, `frameDurationNumDen`.
- Helpers: `formatTimecode`, `calibratePCut`, `calculateFcode`, `calculateThresholds`, `validateFrame`.

The compiled WASM is at:
- `@doedja/scenecut-core/dist/detection.wasm.js` (ES-module glue)
- `@doedja/scenecut-core/dist/detection.wasm` (binary)

Shortcut imports:
```ts
import glueUrl from '@doedja/scenecut-core/wasm?url';        // via Vite
import wasmUrl from '@doedja/scenecut-core/wasm-binary?url';
```

## Source

[github.com/doedja/scenecut](https://github.com/doedja/scenecut)

## License

GPL-2.0 — derived from [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) (dubhater) and the Xvid motion estimation algorithm.
