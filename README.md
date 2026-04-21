# scenecut

Fast, accurate scene change detection. Xvid motion estimation compiled to WebAssembly, an online smoother, per-video adaptive calibration, and a parallel worker pool. Runs in **Node.js** (CLI + library) and in the **browser** (static site, no uploads).

## Repo layout

Monorepo, three libraries and one app:

```
packages/
  core/   @doedja/scenecut-core   shared detector + WASM + exporters (no I/O)
  node/   @doedja/scenecut        node library + CLI (ffmpeg-based)
  web/    @doedja/scenecut-web    browser library (WebCodecs + MKV demuxer)
apps/
  web/    scenecut-web-app        static site — drop videos, get keyframes
```

Most users just install `@doedja/scenecut` and never touch core or web directly.

## CLI

```bash
npm install -g @doedja/scenecut

# default — writes Aegisub keyframes next to the input
scenecut input.mkv

# NLE exports
scenecut video.mkv -f edl              # CMX3600 EDL — Premiere, Resolve, Avid
scenecut video.mkv -f fcpxml           # Final Cut Pro X timeline with markers
scenecut video.mkv -f premiere         # Premiere Import Markers CSV

# technical formats
scenecut video.mp4 -f json -o scenes.json
scenecut video.mp4 -f csv  -o scenes.csv
scenecut video.mp4 -f timecode

# parallel worker pool (v3)
scenecut video.mkv -w true             # auto (cpus - 1, capped at 8)
scenecut video.mkv -w 4                # pin to 4 workers

# other
scenecut anime.mkv -s high -v          # higher sensitivity, verbose
scenecut long-movie.mkv -t 120         # abort after 2 minutes
scenecut video.mp4 --thumbnails ./thumbs
```

### Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--format` | `-f` | see format list below | `aegisub` |
| `--output` | `-o` | Output path | `{filename}_keyframes.{ext}` |
| `--sensitivity` | `-s` | `low` \| `medium` \| `high` | `low` |
| `--workers` | `-w` | `true` \| number \| `off` | `off` |
| `--timeout` | `-t` | Abort after N seconds | off |
| `--thumbnails` | | Scene thumbnail directory | — |
| `--quiet` | `-q` | Suppress progress | — |
| `--verbose` | `-v` | Show per-scene detail | — |

### Formats

| Format | Extension | Where it fits |
|--------|-----------|---------------|
| `edl` | `.edl` | CMX3600 — Premiere, DaVinci Resolve, Avid |
| `fcpxml` | `.fcpxml` | Final Cut Pro X timeline with scene markers |
| `premiere` | `.markers.csv` | Premiere Pro `File → Import Markers` |
| `aegisub` | `.txt` | Aegisub keyframes (frame numbers) |
| `timecode` (`tc`) | `.txt` | Plain `HH:MM:SS.mmm` list per line |
| `csv` | `.csv` | Generic CSV (frame, timestamp, timecode, confidence, duration) |
| `json` | `.json` | Full result with metadata and stats |

### Sensitivity

| Level | Base threshold | When to use |
|-------|---------------|-------------|
| `low`    | sSAD ≥ 150 | Hard cuts only. Default. Robust on compressed/noisy footage. |
| `medium` | sSAD ≥ 90  | Balanced. |
| `high`   | sSAD ≥ 50  | Catches subtle transitions. More false positives on noise. |

The base threshold is a starting point. During the first ~2 seconds of video, scenecut measures the noise floor and nudges the threshold upward if the content is noisier than expected, capped at 4× the base.

## Node library

```js
const { detectSceneChanges } = require('@doedja/scenecut');

const result = await detectSceneChanges('input.mp4', {
  sensitivity: 'low',
  workers: true,
  onProgress: (p) => console.log(`${p.percent}% — ${p.fps?.toFixed(1)} fps`),
  onScene:    (s) => console.log(`cut @ ${s.timecode} conf=${s.confidence?.toFixed(2)}`)
});

console.log(`${result.scenes.length} scenes`);
```

```ts
interface NodeDetectionOptions {
  sensitivity?: 'low' | 'medium' | 'high';             // default: 'low'
  searchRange?: 'auto' | 'small' | 'medium' | 'large'; // default: 'auto'
  workers?: number | boolean;                          // default: off
  onProgress?: (p: Progress) => void;
  onScene?: (s: SceneInfo) => void;
  signal?: AbortSignal;
}
```

`workers: true` sizes the pool to `cpus - 1` (clamped to `[1, 8]`). Pass a number to pin it. Pass a pre-built pool via `pool:` to share across calls.

Exporters are available as named imports too:

```js
const { formatEdl, formatFcpxml, formatPremiereMarkers } = require('@doedja/scenecut');
const edl = formatEdl(result, 'my-clip');
```

### Result

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
  metadata: { totalFrames, duration, fps, resolution, codec?, pixelFormat?, bitrate? };
  stats:    { processingTime, framesPerSecond };
}
```

### Cancellation

```js
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 60_000);
await detectSceneChanges('input.mp4', { signal: ctrl.signal });
```

## Browser app

Static site at `apps/web/`. Drop one or many videos, everything runs locally — files never leave your tab. The app supports **batch / queue processing** — add multiple files, pick per-file from the queue list, export in any NLE format.

### Decode paths

| Input | Path | Speed |
|-------|------|-------|
| MP4 / MOV / M4V | mp4box.js demuxer → `VideoDecoder` → I420 Y-plane | fast (~near-CPU-bound) |
| MKV / WebM / MKA | custom EBML demuxer → `VideoDecoder` → I420 Y-plane | fast |
| Anything else the browser can play | `<video>` + `requestVideoFrameCallback` → canvas readback | capped at ~2–4× real-time |

WebCodecs codec support: H.264, H.265/HEVC, AV1, VP9, VP8. Motion estimation runs in a Web Worker pool (auto-sized to `navigator.hardwareConcurrency - 1`, capped at 4).

### Run locally

```bash
bun install
bun run build:core:wasm        # needs emscripten SDK
bun run dev:app
```

Then open the printed URL (typically http://localhost:5173).

### Deploy — Cloudflare Pages

See [Deploying to Cloudflare Pages](#deploying-to-cloudflare-pages) below.

### Browser library

```js
import {
  detectSceneChanges,
  createWebWasmFactory,
  createWebMotionPool
} from '@doedja/scenecut-web';

const wasmFactory = createWebWasmFactory({
  glueUrl: new URL('./wasm/detection.wasm.js', location.href).href,
  wasmUrl: new URL('./wasm/detection.wasm', location.href).href
});

const pool = createWebMotionPool({
  glueUrl: '...', wasmUrl: '...',
  createWorker: () => new Worker(
    new URL('./motion-worker.ts', import.meta.url),
    { type: 'module' }
  )
});

const result = await detectSceneChanges(file, {
  wasmFactory,
  pool,
  sensitivity: 'low',
  onScene: (s) => console.log(s)
});
```

## Deploying to Cloudflare Pages

Cloudflare Pages auto-redeploys on every push once connected.

1. **Connect the repo** in the Cloudflare dashboard: *Workers & Pages → Create → Pages → Connect to Git* and select this repo.
2. **Build settings**:
   - Framework preset: `None`
   - Build command: `npm install -g bun && bun install && bun run build:site`
   - Build output directory: `apps/web/dist`
   - Root directory: `/` (leave blank)
3. **Environment variables**:
   - `NODE_VERSION = 20` (or higher)
4. **Save and deploy.**

The `build:site` script compiles `@doedja/scenecut-core` (TS only, no WASM rebuild), then `@doedja/scenecut-web`, then the app. The WASM binaries live committed in `apps/web/public/wasm/` so the build image never needs emscripten.

A `_headers` file lives in `apps/web/public/` for cache + security defaults; Pages picks it up automatically.

## How it works

1. **Decode**. FFmpeg (Node) or mp4box/EBML + `VideoDecoder` (browser) produces grayscale frames.
2. **Fused fast pass** (JS). One walk over sampled pixels computes (a) MAD vs. previous frame for quick-reject, (b) drift vs. an EMA reference for fade detection, (c) updates the EMA in place.
3. **Gate**. If both MAD and drift are below thresholds, WASM is skipped (≈80% of frames on typical content).
4. **Motion estimation** (WASM). Xvid MEanalysis with diamond + subpel refinement, SIMD SAD. Returns a raw sSAD score. With a pool, runs in parallel across threads.
5. **Sigmoid calibration**. rawScore → p_cut ∈ [0, 1]. 0.5 at threshold, ≥ 0.95 at 2× threshold.
6. **Fade rescue**. Borderline p_cut + elevated drift → re-calibrate against a lower threshold. No extra WASM call.
7. **Adaptive warmup**. First ~2 s of raw scores set the noise floor; threshold shifts up on noisy content, capped at 4×.
8. **Smoother** (online NMS). Refractory window ~0.25 s; only the highest-probability cut per window survives.

## Performance

Measured on an M-series Mac, 1080p h.264 24 fps anime (24-min episode):

- **Single-threaded**: ~170 fps sustained.
- **Worker pool (4 threads)**: ~400–550 fps (2.5–3.3× speedup, depends on cut density).
- **Browser (WebCodecs + 4-worker pool)**: comparable to the Node CLI for H.264/H.265 MP4/MKV.
- **Memory**: ~200–300 MB single-threaded; add ~80 MB per worker.
- **Skips WASM** for ~80% of frames via the quick-reject + drift gate.

## Build from source

```bash
bun install

# one shot: builds core (WASM + TS), node, web, app
bun run build

# or granular
bun run build:core:wasm      # requires emcc (Emscripten SDK)
bun run build:core:ts
bun run build:node
bun run build:web
bun run build:app
```

Requirements:
- Node.js ≥ 18
- Bun (or swap `bun` for `npm`/`pnpm` with minor command adjustments)
- Emscripten SDK (only to rebuild WASM)
- FFmpeg (bundled via `@ffmpeg-installer/ffmpeg` for the node package — no separate install)

## License

GPL-2.0 — derived from [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) (dubhater) and the Xvid motion estimation algorithm.

## Credits

- vapoursynth-wwxd by [dubhater](https://github.com/dubhater)
- Xvid motion estimation ([xvid.com](https://www.xvid.com))
- mp4box.js, for MP4 demuxing in the browser
