# @doedja/scenecut

Fast, accurate scene change detection for Node.js. Xvid motion estimation compiled to WebAssembly, an online smoother, per-video adaptive calibration, and an optional worker pool for parallel analysis.

```bash
npm install -g @doedja/scenecut
```

## CLI

```bash
# default — writes Aegisub keyframes next to the input
scenecut input.mkv

# NLE exports
scenecut video.mkv -f edl              # CMX3600 — Premiere, Resolve, Avid
scenecut video.mkv -f fcpxml           # Final Cut Pro X timeline with markers
scenecut video.mkv -f premiere         # Premiere Pro Import Markers CSV

# technical formats
scenecut video.mp4 -f json -o scenes.json
scenecut video.mp4 -f csv
scenecut video.mp4 -f timecode

# parallel worker pool
scenecut video.mkv -w true             # auto (cpus - 1, capped at 8)
scenecut video.mkv -w 4                # pin to 4 workers

scenecut anime.mkv -s high -v          # higher sensitivity, verbose
scenecut long.mkv -t 120               # abort after 2 minutes
scenecut video.mp4 --thumbnails ./thumbs
```

### Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--format` | `-f` | see formats below | `aegisub` |
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
| `fcpxml` | `.fcpxml` | Final Cut Pro X timeline with markers |
| `premiere` | `.markers.csv` | Premiere Pro `File → Import Markers` |
| `aegisub` | `.txt` | Aegisub keyframes (frame numbers) |
| `timecode` (`tc`) | `.txt` | Plain `HH:MM:SS.mmm` list |
| `csv` | `.csv` | Generic CSV |
| `json` | `.json` | Full result with metadata and stats |

### Sensitivity

| Level | Base threshold | When to use |
|-------|---------------|-------------|
| `low`    | sSAD ≥ 150 | Hard cuts only. Default. Robust on compressed/noisy footage. |
| `medium` | sSAD ≥ 90  | Balanced. |
| `high`   | sSAD ≥ 50  | Subtle transitions. More false positives on noise. |

The base threshold is a starting point. During the first ~2 s of video, scenecut measures the noise floor and nudges the threshold upward if the content is noisier than expected, capped at 4× the base.

## Library

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

`workers: true` sizes the pool to `cpus - 1` (clamped to `[1, 8]`). Expect 2.5–3.3× speedup on 4-core machines.

Exporters are named imports too:

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
    confidence: number;  // 0–1 (sigmoid-calibrated)
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

### Thumbnails

```js
const { extractSceneImages } = require('@doedja/scenecut');

await extractSceneImages('input.mp4',
  { sensitivity: 'low' },
  { outputDir: './thumbs', format: 'jpg', quality: 85 }
);
```

## Browser?

Use [`@doedja/scenecut-web`](https://www.npmjs.com/package/@doedja/scenecut-web).

## How it works

1. **Decode**: FFmpeg streams grayscale frames via a zero-copy ring buffer.
2. **Fused fast pass** (JS): sampled MAD vs. previous + drift vs. an EMA reference, EMA updated in place.
3. **Gate**: if both MAD and drift are low, WASM is skipped (≈80% of frames).
4. **Motion estimation** (WASM): Xvid MEanalysis with diamond + subpel refinement, SIMD SAD. With a pool, runs in parallel threads.
5. **Sigmoid calibration**: rawScore → p_cut ∈ [0, 1].
6. **Fade rescue** via the EMA drift signal.
7. **Adaptive warmup**: first ~2 s sets the noise floor.
8. **Smoother** (online NMS with refractory gap).

## Performance

Measured on an M-series Mac, 1080p h.264 24 fps anime (24-min episode):

- Single-threaded: ~170 fps sustained
- Worker pool (4 threads): ~400–550 fps (2.5–3.3× speedup)
- Memory: ~200–300 MB single, ~80 MB per added worker
- Skips WASM for ~80% of frames

## Requirements

- Node.js ≥ 18
- FFmpeg (bundled via `@ffmpeg-installer/ffmpeg` — no separate install needed)

## Source

[github.com/doedja/scenecut](https://github.com/doedja/scenecut)

## License

GPL-2.0 — derived from [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) (dubhater) and the Xvid motion estimation algorithm.
