# scenecut

Fast, accurate scene change detection for Node.js. Xvid motion estimation compiled to WebAssembly, plus an online smoother and per-video adaptive calibration.

## Features

- **Xvid motion estimation** via WASM with SIMD, double-buffered frame pipeline, fused quick-reject + drift pass that skips WASM for nearly-identical frames.
- **Adaptive calibration**: a warmup pass measures per-video noise floor and shifts the decision threshold to match. Clean content stays sensitive, noisy content stops over-triggering.
- **Sigmoid-calibrated confidence**: scores are a proper probability, 0.5 at the decision boundary, saturating near 1.0 on unambiguous cuts.
- **Fade/dissolve detection** via an EMA reference frame. Drift accumulates across gradual transitions and rescues borderline motion scores — without a second WASM run.
- **Non-max suppression smoother**: an online NMS window keeps only the highest-probability cut within a refractory gap (scaled to FPS). Replaces heuristic flash rules.
- **Thumbnails**: extract one image per scene in a single FFmpeg pass.
- **Formats**: Aegisub keyframes, timecodes, CSV, JSON.
- **Cancellable**: AbortController support; `--timeout` for long videos.
- **Cross-platform**: macOS, Linux, Windows.

## Install

```bash
# CLI
npm install -g @doedja/scenecut

# Library
npm install @doedja/scenecut
```

## CLI

```bash
# Default — writes Aegisub keyframes next to the input
scenecut input.mkv

# Formats
scenecut video.mp4 -f json -o scenes.json
scenecut video.mp4 -f csv  -o scenes.csv
scenecut video.mp4 -f timecode -o timecodes.txt

# Higher sensitivity for subtle transitions
scenecut anime.mkv -s high -v

# Abort after 2 minutes
scenecut long-movie.mkv -t 120

# Scene thumbnails
scenecut video.mp4 --thumbnails ./thumbs
```

### Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--format` | `-f` | `aegisub` \| `json` \| `csv` \| `timecode` | `aegisub` |
| `--output` | `-o` | Output path | `{filename}_keyframes.txt` |
| `--sensitivity` | `-s` | `low` \| `medium` \| `high` | `low` |
| `--timeout` | `-t` | Abort after N seconds | off |
| `--thumbnails` | | Output thumbnail dir | — |
| `--quiet` | `-q` | Suppress progress | — |
| `--verbose` | `-v` | Show per-scene confidence | — |

### Sensitivity

| Level | Base threshold | When to use |
|-------|---------------|-------------|
| `low`    | sSAD ≥ 150 | Hard cuts only. Default. Robust on compressed/noisy footage. |
| `medium` | sSAD ≥ 90  | Balanced. |
| `high`   | sSAD ≥ 50  | Catches subtle transitions. More false positives on noise. |

The base threshold is the starting point. During the first ~2 seconds of video, scenecut measures the noise floor and nudges the threshold upward if the content is noisier than expected, capped at 4× the base.

## Programmatic API

```js
const { detectSceneChanges } = require('@doedja/scenecut');

const result = await detectSceneChanges('input.mp4', {
  sensitivity: 'low',      // optional — 'low' | 'medium' | 'high'
  searchRange: 'auto',     // optional — 'auto' | 'small' | 'medium' | 'large'
  onProgress: (p) => console.log(`${p.percent}% — ${p.fps?.toFixed(1)} fps`),
  onScene:    (s) => console.log(`cut @ ${s.timecode} conf=${s.confidence?.toFixed(2)}`)
});

console.log(`${result.scenes.length} scenes`);
```

### Options

```ts
interface DetectionOptions {
  sensitivity?: 'low' | 'medium' | 'high';          // default: 'low'
  searchRange?: 'auto' | 'small' | 'medium' | 'large'; // default: 'auto'
  onProgress?: (p: Progress) => void;
  onScene?: (s: SceneInfo) => void;
  format?: 'json' | 'csv' | 'edl';
  signal?: AbortSignal;
}
```

That's the full surface. Everything else — fade detection, temporal smoothing, adaptive thresholding, confidence calibration — is on by default and sized automatically from the video's fps and noise characteristics.

### Result

```ts
interface DetectionResult {
  scenes: Array<{
    frameNumber: number;
    timestamp: number;     // seconds
    timecode: string;      // HH:MM:SS.mmm
    confidence: number;    // 0–1 (sigmoid-calibrated)
    duration: number;      // seconds until next scene
    frameCount: number;
  }>;
  metadata: {
    totalFrames: number;
    duration: number;
    fps: number;
    resolution: { width: number; height: number };
    codec?: string;
    pixelFormat?: string;
    bitrate?: number;
  };
  stats: {
    processingTime: number;
    framesPerSecond: number;
  };
}
```

### Thumbnails

```js
const { extractSceneImages } = require('@doedja/scenecut');

await extractSceneImages('input.mp4',
  { sensitivity: 'low' },
  { outputDir: './thumbs', format: 'jpg', quality: 85 }
);
```

### Cancellation

```js
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 60_000);

await detectSceneChanges('input.mp4', { signal: ctrl.signal });
```

## How it works

1. **Decode**: FFmpeg streams grayscale frames via a zero-copy ring buffer into pre-allocated double buffers.
2. **Fused pass (per frame, JS)**: one walk over sampled pixels computes (a) MAD vs. previous frame for quick-reject, (b) drift vs. an EMA reference for fade detection, and (c) updates the EMA in place.
3. **Gate**: if both MAD and drift are below thresholds, WASM is skipped entirely (≈80% of frames on typical content).
4. **Motion estimation (WASM)**: Xvid's MEanalysis with diamond + subpel refinement, resolution-scaled intra-count boost, SIMD SAD. Returns a raw sSAD score.
5. **Sigmoid calibration**: rawScore → p_cut ∈ [0, 1]. 0.5 at threshold, ≥ 0.95 at 2× threshold.
6. **Fade rescue**: if p_cut is borderline but drift is elevated, the score is re-calibrated against a lower threshold. No second WASM call.
7. **Adaptive warmup**: the first ~2 s of raw scores set the noise floor. The threshold is shifted up if the content is noisier than the sensitivity default (capped at 4×).
8. **Smoother (online NMS)**: candidates are buffered over a refractory window (≈0.25 s by default). Only the highest-probability cut per window is emitted, with a small lookahead so a stronger candidate a few frames later can override an earlier weaker one.

## Performance

Measured on an M-series Mac, 1080p h.264 24 fps anime:

- **Speed**: ~170 fps sustained on 24-min 1080p episode (single-threaded JS + WASM).
- **Memory**: ~200–300 MB, mostly pre-allocated WASM buffers and the EMA reference.
- **Skips WASM** for ~80% of frames via the quick-reject + drift gate.

## Requirements

- Node.js ≥ 18
- FFmpeg and FFprobe (bundled via `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe`)

## Build from source

```bash
npm install
npm run build:wasm    # requires emcc (Emscripten SDK or `brew install emscripten`)
npm run build         # tsc + rollup
```

## License

GPL-2.0 — derived from [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) (dubhater) and the Xvid motion estimation algorithm.

## Credits

- vapoursynth-wwxd by [dubhater](https://github.com/dubhater)
- Xvid motion estimation ([xvid.com](https://www.xvid.com))
