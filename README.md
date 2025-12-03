# scenecut

Fast, accurate scene change detection for Node.js using Xvid's motion estimation algorithm compiled to WebAssembly.

## Features

- **Fast**: WebAssembly-accelerated motion estimation (35-45 fps on typical hardware)
- **Accurate**: Uses Xvid's proven motion estimation algorithm from vapoursynth-wwxd
- **Multiple output formats**: Aegisub keyframes, timecodes, CSV, JSON
- **Easy to use**: Simple CLI and programmatic API
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
# Creates input_keyframes.txt
scenecut "input.mkv"

# Specify custom output filename
scenecut "video.mkv" -o keyframes.txt

# For timecode output
scenecut "video.mp4" --format timecode -o timecodes.txt

# JSON format with full metadata
scenecut "movie.avi" --format json

# CSV format for spreadsheet analysis
scenecut "movie.avi" --format csv -o scenes.csv
```

### CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--format` | `-f` | Output format: `aegisub`, `json`, `csv`, `timecode` | `aegisub` |
| `--output` | `-o` | Output file path | `{filename}_keyframes.txt` |
| `--sensitivity` | `-s` | Detection sensitivity: `low`, `medium`, `high` | `medium` |
| `--quiet` | `-q` | Suppress progress output | `false` |
| `--verbose` | `-v` | Show detailed output including each scene | `false` |
| `--help` | `-h` | Show help message | - |

### Examples

```bash
# Default - creates anime_keyframes.txt in Aegisub format
scenecut "anime.mkv"

# High sensitivity for subtle scene changes
scenecut "anime.mkv" --sensitivity high

# JSON format with full metadata
scenecut "video.mp4" --format json -o results.json

# Verbose mode with detailed scene information
scenecut "movie.mkv" --verbose
```

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
2. In Aegisub: **Video** → **Open Keyframes** → Select `keyframes.txt`
3. Keyframes appear as visual markers on the timeline for precise subtitle timing

### Timecode Format (`.txt`)

Simple timecode list (HH:MM:SS.mmm):

```
00:00:00.000
00:00:05.964
00:00:11.970
```

### CSV Format (`.csv`)

Spreadsheet-compatible format:

```csv
frame,timestamp,timecode
0,0.0,00:00:00.000
143,5.964,00:00:05.964
287,11.970,00:00:11.970
```

### JSON Format (`.json`)

Complete metadata and scene information:

```json
{
  "scenes": [
    {
      "frameNumber": 0,
      "timestamp": 0.0,
      "timecode": "00:00:00.000"
    },
    {
      "frameNumber": 143,
      "timestamp": 5.964,
      "timecode": "00:00:05.964"
    }
  ],
  "metadata": {
    "totalFrames": 3000,
    "duration": 125.08,
    "fps": 23.976,
    "resolution": {
      "width": 1920,
      "height": 1080
    }
  }
}
```

## Programmatic API

### Basic Usage

```javascript
const { detectSceneChanges } = require('@doedja/scenecut');

(async () => {
  const results = await detectSceneChanges('input.mp4');

  console.log(`Found ${results.scenes.length} scenes`);
  results.scenes.forEach(scene => {
    console.log(`Scene at frame ${scene.frameNumber} (${scene.timecode})`);
  });
})();
```

### Advanced Usage with Options

```javascript
const { detectSceneChanges } = require('@doedja/scenecut');

const results = await detectSceneChanges('input.mp4', {
  sensitivity: 'high',        // 'low' | 'medium' | 'high'
  searchRange: 'medium',      // Motion search range

  // Progress callback
  onProgress: (progress) => {
    console.log(`Progress: ${progress.percent}%`);
    console.log(`Frame: ${progress.currentFrame}/${progress.totalFrames}`);
    console.log(`FPS: ${progress.fps}, ETA: ${progress.eta}s`);
  },

  // Scene detection callback
  onScene: (scene) => {
    console.log(`Scene detected at frame ${scene.frameNumber}`);
    console.log(`Timecode: ${scene.timecode}`);
  }
});

console.log('Detection complete!');
console.log(`Total scenes: ${results.scenes.length}`);
console.log(`Video duration: ${results.metadata.duration}s`);
console.log(`Resolution: ${results.metadata.resolution.width}x${results.metadata.resolution.height}`);
```

### API Reference

#### `detectSceneChanges(videoPath, options?)`

Detects scene changes in a video file.

**Parameters:**
- `videoPath` (string): Path to input video file
- `options` (object, optional):
  - `sensitivity` ('low' | 'medium' | 'high'): Detection sensitivity (default: 'medium')
  - `searchRange` ('auto' | 'small' | 'medium' | 'large'): Motion search range (default: 'medium')
  - `onProgress` (function): Callback for progress updates
  - `onScene` (function): Callback for each detected scene

**Returns:** Promise<DetectionResult>

**DetectionResult:**
```typescript
{
  scenes: Array<{
    frameNumber: number;
    timestamp: number;      // Seconds
    timecode: string;       // HH:MM:SS.mmm
  }>;
  metadata: {
    totalFrames: number;
    duration: number;       // Seconds
    fps: number;
    resolution: {
      width: number;
      height: number;
    };
  };
}
```

## Supported Video Formats

Keyframes supports any video format that FFmpeg can decode, including:

- MP4 (`.mp4`, `.m4v`)
- Matroska (`.mkv`)
- AVI (`.avi`)
- WebM (`.webm`)
- MOV (`.mov`)
- FLV (`.flv`)
- And many more...

## How It Works

Keyframes uses Xvid's motion estimation algorithm to detect scene changes:

1. **Frame Extraction**: FFmpeg extracts grayscale frames from the video
2. **Motion Analysis**: WebAssembly-compiled C code analyzes motion vectors between consecutive frames
3. **Scene Detection**: Frames with high motion complexity are identified as scene changes
4. **Output Formatting**: Results are formatted according to the requested output format

The algorithm is based on [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) by dubhater, which itself uses Xvid's motion estimation code.

## Performance

Optimized for speed and accuracy:
- **Processing speed**: 35-45 fps on 1080p video (modern hardware)
- **Memory usage**: ~200-300 MB with efficient buffer management
- **Accuracy**: Matches vapoursynth-wwxd output (100% accurate)
- **Optimizations**: WASM SIMD, pre-allocated buffers, ring buffer streaming

## Requirements

- **Node.js**: 18.0.0 or higher
- **FFmpeg**: Automatically installed via `@ffmpeg-installer/ffmpeg`

## License

GPL-2.0

This project is based on:
- [vapoursynth-wwxd](https://github.com/dubhater/vapoursynth-wwxd) by dubhater (GPL-2.0)
- Xvid's motion estimation algorithm (GPL-2.0)

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Credits

- Original vapoursynth-wwxd plugin: [dubhater](https://github.com/dubhater)
- Xvid motion estimation algorithm: [Xvid Team](https://www.xvid.com)
- JavaScript/WASM port: This project
