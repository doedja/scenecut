# scenecut

Fast, accurate scene change detection for Node.js using Xvid's motion estimation algorithm compiled to WebAssembly.

## Features

- **Fast**: WebAssembly-accelerated motion estimation with SIMD, double-buffered frame pipeline, and quick-reject filtering
- **Accurate**: Uses Xvid's proven motion estimation algorithm with configurable thresholds that actually work
- **Confidence scoring**: Each scene change includes a 0-1 confidence score from the motion estimator
- **Fade/dissolve detection**: Catches gradual transitions that per-frame analysis misses
- **Temporal smoothing**: Optional sliding window filter to suppress false positives and flash frames
- **Multiple output formats**: Aegisub keyframes, timecodes, CSV (with confidence + duration), JSON
- **Scene duration**: Each scene includes duration and frame count
- **Cancellable**: AbortController support with `--timeout` for long videos
- **Batch thumbnails**: Extract scene images in a single FFmpeg pass
- **Cross-platform**: Works on Windows, Linux, and macOS

## Installation

### Global Installation (CLI)

```bash
npm install -g @doedja/scenecut
```

### Local Installation (API)

```bash
npm install @doedja/scenecut
```

## CLI Usage

### Basic Usage

```bash
# Simple - detects scenes and saves to Aegisub format (default)
scenecut "input.mkv"

# Specify custom output filename
scenecut "video.mkv" -o keyframes.txt

# For timecode output
scenecut "video.mp4" --format timecode -o timecodes.txt

# JSON format with full metadata, confidence, and duration
scenecut "movie.avi" --format json

# CSV format for spreadsheet analysis
scenecut "movie.avi" --format csv -o scenes.csv

# High sensitivity for subtle scene changes
scenecut "anime.mkv" --sensitivity high --verbose

# Abort after 2 minutes
scenecut "long-movie.mkv" --timeout 120

# Extract scene thumbnails
scenecut "video.mp4" --thumbnails ./thumbs
```

### CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--format` | `-f` | Output format: `aegisub`, `json`, `csv`, `timecode` | `aegisub` |
| `--output` | `-o` | Output file path | `{filename}_keyframes.txt` |
| `--sensitivity` | `-s` | Detection sensitivity: `low`, `medium`, `high` | `low` |
| `--timeout` | `-t` | Abort after N seconds | no timeout |
| `--thumbnails` | | Extract scene thumbnails to directory | - |
| `--quiet` | `-q` | Suppress progress output | `false` |
| `--verbose` | `-v` | Show detailed output including confidence | `false` |
| `--help` | `-h` | Show help message | - |

### Sensitivity Levels

| Level | IntraThresh | IntraThresh2 | Use case |
|-------|------------|-------------|----------|
| `low` | 3000 | 150 | Fewer detections, only hard cuts (default) |
| `medium` | 2000 | 90 | Balanced |
| `high` | 1000 | 50 | More detections, catches subtle transitions |

## Output Formats

### Aegisub Format (`.txt`)

Aegisub keyframes format for subtitle timing:

```
# keyframe format v1
fps 23.976
0
143
287
```

**Aegisub Workflow:**
1. Generate keyframes: `scenecut "video.mkv" -f aegisub -o keyframes.txt`
2. In Aegisub: **Video** > **Open Keyframes** > Select `keyframes.txt`
3. Keyframes appear as visual markers on the timeline for precise subtitle timing

### CSV Format (`.csv`)

Includes confidence scores and scene durations:

```csv
frame,timestamp,timecode,confidence,duration,frameCount
0,0.0,00:00:00.000,1.0000,5.964,143
143,5.964,00:00:05.964,0.7234,6.006,144
287,11.970,00:00:11.970,0.8912,4.171,100
```

### JSON Format (`.json`)

Complete metadata with confidence, duration, and codec info:

```json
{
  "scenes": [
    {
      "frameNumber": 0,
      "timestamp": 0.0,
      "timecode": "00:00:00.000",
      "confidence": 1.0,
      "duration": 5.964,
      "frameCount": 143
    },
    {
      "frameNumber": 143,
      "timestamp": 5.964,
      "timecode": "00:00:05.964",
      "confidence": 0.7234,
      "duration": 6.006,
      "frameCount": 144
    }
  ],
  "metadata": {
    "totalFrames": 3000,
    "duration": 125.08,
    "fps": 23.976,
    "resolution": { "width": 1920, "height": 1080 },
    "codec": "h264",
    "pixelFormat": "yuv420p",
    "bitrate": 5000000
  },
  "stats": {
    "processingTime": 28.5,
    "framesPerSecond": 105.2
  }
}
```

### Timecode Format (`.txt`)

Simple timecode list (HH:MM:SS.mmm):

```
00:00:00.000
00:00:05.964
00:00:11.970
```

## Programmatic API

### Basic Usage

```javascript
const { detectSceneChanges } = require('@doedja/scenecut');

const results = await detectSceneChanges('input.mp4');

console.log(`Found ${results.scenes.length} scenes`);
results.scenes.forEach(scene => {
  console.log(`Scene at ${scene.timecode} (confidence: ${(scene.confidence * 100).toFixed(0)}%, duration: ${scene.duration?.toFixed(1)}s)`);
});
```

### Advanced Usage

```javascript
const { detectSceneChanges } = require('@doedja/scenecut');

const controller = new AbortController();

// Auto-cancel after 60 seconds
setTimeout(() => controller.abort(), 60000);

const results = await detectSceneChanges('input.mp4', {
  sensitivity: 'high',
  searchRange: 'medium',
  signal: controller.signal,

  // Temporal smoothing to reduce false positives
  temporalSmoothing: {
    enabled: true,
    windowSize: 5,
    minConsecutive: 2
  },

  onProgress: (progress) => {
    console.log(`${progress.percent}% | ${progress.fps?.toFixed(1)} fps | ETA: ${progress.eta?.toFixed(0)}s | ${progress.scenesDetected} scenes`);
  },

  onScene: (scene) => {
    console.log(`Scene at frame ${scene.frameNumber} (${scene.timecode}) confidence: ${scene.confidence?.toFixed(2)}`);
  }
});

console.log(`Total scenes: ${results.scenes.length}`);
console.log(`Video: ${results.metadata.codec} ${results.metadata.resolution.width}x${results.metadata.resolution.height}`);
```

### Extract Scene Thumbnails

```javascript
const { extractSceneImages } = require('@doedja/scenecut');

const results = await extractSceneImages('input.mp4', {
  sensitivity: 'low'
}, {
  outputDir: './thumbnails',
  format: 'jpg',
  quality: 85,
  filenameTemplate: 'scene_{frame}'
});
```

### API Reference

#### `detectSceneChanges(videoPath, options?)`

Detects scene changes in a video file.

**Parameters:**
- `videoPath` (string): Path to input video file
- `options` (DetectionOptions, optional):
  - `sensitivity` ('low' | 'medium' | 'high' | 'custom'): Detection sensitivity
  - `customThresholds` ({ intraThresh, intraThresh2 }): Custom threshold values (when sensitivity='custom')
  - `searchRange` ('auto' | 'small' | 'medium' | 'large'): Motion search range
  - `signal` (AbortSignal): For cancellation support
  - `temporalSmoothing` ({ enabled, windowSize, minConsecutive }): Temporal smoothing config
  - `onProgress` (function): Progress callback with fps, eta, scenesDetected
  - `onScene` (function): Callback for each detected scene

**Returns:** `Promise<DetectionResult>`

```typescript
interface DetectionResult {
  scenes: Array<{
    frameNumber: number;
    timestamp: number;        // Seconds
    timecode: string;         // HH:MM:SS.mmm
    confidence: number;       // 0-1
    duration: number;         // Seconds until next scene
    frameCount: number;       // Frames until next scene
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

#### `extractSceneImages(videoPath, options?, imageOptions?)`

Detects scenes and extracts thumbnail images in a single FFmpeg pass.

**Additional parameter:**
- `imageOptions` (FrameImageOptions):
  - `outputDir` (string): Output directory
  - `format` ('jpg' | 'png' | 'bmp'): Image format
  - `quality` (number): JPEG quality 1-100
  - `width` (number): Output width (maintains aspect ratio)
  - `filenameTemplate` (string): Use `{frame}` and `{timestamp}` placeholders

## How It Works

1. **Frame Extraction**: FFmpeg extracts grayscale frames via streaming ring buffer with zero-copy alternating buffers
2. **Quick Reject**: Sampled pixel comparison (every 64th pixel) skips nearly-identical frames without touching WASM
3. **Motion Analysis**: WebAssembly-compiled Xvid motion estimation with configurable thresholds and SIMD acceleration
4. **Confidence Scoring**: Raw sSAD scores are normalized to 0-1 confidence values
5. **Fade Detection**: Drift comparison against last keyframe catches gradual dissolves lasting 30+ frames
6. **Temporal Smoothing**: Optional sliding window filter suppresses flashes and merges detection clusters
7. **Double Buffering**: Previous frame stays in WASM memory between calls, halving memory copies

## Performance

- **Processing speed**: 80-150+ fps on 1080p video (with quick-reject, most frames skip WASM entirely)
- **Memory usage**: ~200-300 MB with pre-allocated WASM buffers and buffer pooling
- **4K support**: Auto-sized ring buffer scales to any resolution
- **Optimizations**: WASM SIMD, double-buffered frames, pre-allocated macroblock array, zero-alloc frame extraction, quick-reject filtering

## Requirements

- **Node.js**: 18.0.0 or higher
- **FFmpeg & FFprobe**: Automatically installed via `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe`

## Building from Source

```bash
# Install dependencies
npm install

# Build WASM (requires Emscripten SDK)
npm run build:wasm

# Build TypeScript + bundle
npm run build
```

## License

GPL-2.0

This project is based on:
- [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) by dubhater (GPL-2.0)
- Xvid's motion estimation algorithm (GPL-2.0)

## Credits

- Original vapoursynth-wwxd plugin: [dubhater](https://github.com/dubhater)
- Xvid motion estimation algorithm: [Xvid Team](https://www.xvid.com)
