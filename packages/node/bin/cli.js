#!/usr/bin/env node

/**
 * Keyframes CLI - Simple command-line interface for scene detection
 *
 * Usage:
 *   keyframes input.mp4
 *   keyframes input.mkv --output results.json
 *   keyframes video.mp4 --sensitivity high
 */

const {
  detectSceneChanges,
  extractSceneImages,
  formatJson,
  formatCsv,
  formatAegisub,
  formatTimecodeList,
  formatEdl,
  formatFcpxml,
  formatPremiereMarkers
} = require('../dist/scenecut.cjs.js');
const path = require('path');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);

// Help text
const HELP = `
Scenecut - Scene change detection for videos

Usage:
  scenecut <video-file> [options]

Examples:
  scenecut input.mp4
  scenecut video.mkv --output keyframes.txt --format aegisub
  scenecut movie.mp4 --sensitivity high --format timecode
  scenecut video.mp4 --format csv --output scenes.csv
  scenecut video.mp4 --thumbnails ./thumbs --timeout 120

Options:
  --output, -o <file>       Output file (default: {filename}_keyframes.txt)
  --format, -f <format>     Output format (default: aegisub)
  --sensitivity, -s <level> Sensitivity: low|medium|high (default: medium)
  --search-range <range>    ME search range: auto|small|medium|large (default: small)
                            Wider ranges miss cuts that narrow ranges catch;
                            widen only if fast pans produce too many false cuts.
  --workers, -w <n>         Parallel WASM workers (true | number | off, default: off)
  --timeout, -t <seconds>   Abort after N seconds (default: no timeout)
  --thumbnails <dir>        Extract scene thumbnails to directory
  --v2                      Experimental: flash suppression + adaptive threshold
                            (single-thread). Fewer false cuts on flashing scenes,
                            better recall on dark/low-contrast cuts.
  --flash-suppress          Experimental: suppress flash/fade false cuts only
  --adaptive                Experimental: adaptive threshold only
  --quiet, -q               Suppress progress output
  --verbose, -v             Show detailed output
  --help, -h                Show this help

Formats:
  json                      JSON with full metadata, confidence, and duration
  csv                       CSV with frame,timestamp,timecode,confidence,duration
  aegisub (or txt)          Aegisub keyframes format (frame numbers)
  timecode (or tc)          Simple timecode list (HH:MM:SS.mmm)
  edl                       CMX3600 EDL — Premiere, Resolve, Avid
  fcpxml                    Final Cut Pro X — timeline with scene markers
  premiere                  Premiere Pro Import Markers CSV

Video Formats:
  Supports MP4, MKV, AVI, WebM, MOV, and any format FFmpeg supports

Output:
  Results are saved to the output file and printed to stdout
`;

// Show help
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

// Parse arguments
let videoPath = null;
let outputPath = null; // Will be derived from video filename if not specified
let outputFormat = 'aegisub'; // Default to Aegisub format
let sensitivity = 'medium';
let searchRange = 'small';
let quiet = false;
let verbose = false;
let timeout = 0;
let thumbnailDir = null;
let workers = false;
let flashSuppress = false;
let adaptiveThreshold = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--output' || arg === '-o') {
    outputPath = args[++i];
  } else if (arg === '--format' || arg === '-f') {
    outputFormat = args[++i];
  } else if (arg === '--sensitivity' || arg === '-s') {
    sensitivity = args[++i];
  } else if (arg === '--search-range') {
    searchRange = args[++i];
  } else if (arg === '--timeout' || arg === '-t') {
    timeout = parseInt(args[++i], 10);
  } else if (arg === '--workers' || arg === '-w') {
    const v = args[++i];
    if (v === 'true' || v === 'on' || v === 'auto') workers = true;
    else if (v === 'false' || v === 'off' || v === '0') workers = false;
    else { const n = parseInt(v, 10); workers = Number.isFinite(n) && n > 0 ? n : true; }
  } else if (arg === '--thumbnails') {
    thumbnailDir = args[++i];
  } else if (arg === '--v2') {
    flashSuppress = true;
    adaptiveThreshold = true;
  } else if (arg === '--flash-suppress') {
    flashSuppress = true;
  } else if (arg === '--adaptive') {
    adaptiveThreshold = true;
  } else if (arg === '--quiet' || arg === '-q') {
    quiet = true;
  } else if (arg === '--verbose' || arg === '-v') {
    verbose = true;
  } else if (!arg.startsWith('-')) {
    videoPath = arg;
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error('Run "scenecut --help" for usage');
    process.exit(1);
  }
}

// Validate video path
if (!videoPath) {
  console.error('Error: No video file specified');
  console.error('Usage: scenecut <video-file>');
  console.error('Run "scenecut --help" for more information');
  process.exit(1);
}

// Resolve video path
videoPath = path.resolve(videoPath);

if (!fs.existsSync(videoPath)) {
  console.error(`Error: Video file not found: ${videoPath}`);
  process.exit(1);
}

// Generate default output path if not specified
if (!outputPath) {
  const videoBasename = path.basename(videoPath, path.extname(videoPath));
  let extension;
  switch (outputFormat) {
    case 'json': extension = '.json'; break;
    case 'csv': extension = '.csv'; break;
    case 'edl': extension = '.edl'; break;
    case 'fcpxml': extension = '.fcpxml'; break;
    case 'premiere':
    case 'premiere-csv': extension = '.markers.csv'; break;
    default: extension = '.txt';
  }
  outputPath = `${videoBasename}_keyframes${extension}`;
}

// Get file info
const stats = fs.statSync(videoPath);
const fileSize = (stats.size / (1024 * 1024)).toFixed(2);

// Main processing function
async function run() {
  if (!quiet) {
    console.log('Scenecut - Scene Detection');
    console.log('='.repeat(60));
    console.log(`Input:  ${videoPath}`);
    console.log(`Size:   ${fileSize} MB`);
    console.log(`Output: ${path.resolve(outputPath)}`);
    if (timeout > 0) {
      console.log(`Timeout: ${timeout}s`);
    }
    if (thumbnailDir) {
      console.log(`Thumbnails: ${path.resolve(thumbnailDir)}`);
    }
    console.log('='.repeat(60));
    console.log();
  }

  const startTime = Date.now();
  let lastProgressTime = startTime;
  let lastProgressFrame = 0;
  let sceneCount = 0;

  // Set up AbortController for timeout
  let controller = null;
  let timeoutHandle = null;
  if (timeout > 0) {
    controller = new AbortController();
    timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeout * 1000);
  }

  try {
    const options = {
      sensitivity,
      searchRange,
      workers,
      flashSuppress,
      adaptiveThreshold,
      signal: controller ? controller.signal : undefined,
      onProgress: (progress) => {
        if (quiet) return;

        const now = Date.now();
        // Update every 3 seconds
        if (now - lastProgressTime > 3000 || progress.percent === 100) {
          const fps = progress.fps || 0;
          const progressBar = createProgressBar(progress.percent);
          const etaStr = progress.eta ? ` ETA: ${formatTime(progress.eta)}` : '';
          const scenesStr = progress.scenesDetected ? ` [${progress.scenesDetected} scenes]` : '';

          process.stdout.write(
            `\r${progressBar} ${progress.percent.toString().padStart(3)}% ` +
            `[${fps.toFixed(1)} fps]${etaStr}${scenesStr}${' '.repeat(10)}`
          );

          lastProgressTime = now;
          lastProgressFrame = progress.currentFrame;
        }
      },
      onScene: (scene) => {
        sceneCount++;
        if (verbose && !quiet) {
          const confidenceStr = scene.confidence != null ? ` (confidence: ${(scene.confidence * 100).toFixed(0)}%)` : '';
          console.log();
          console.log(`  Scene ${sceneCount}: Frame ${scene.frameNumber} at ${scene.timecode}${confidenceStr}`);
        }
      }
    };

    let results;
    if (thumbnailDir) {
      results = await extractSceneImages(videoPath, options, {
        outputDir: thumbnailDir,
        format: 'jpg',
        quality: 85
      });
    } else {
      results = await detectSceneChanges(videoPath, options);
    }

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    const endTime = Date.now();
    const elapsed = (endTime - startTime) / 1000;

    if (!quiet) {
      console.log('\n');
      console.log('='.repeat(60));
      console.log('Complete!');
      console.log('='.repeat(60));
      console.log(`Scenes detected:  ${results.scenes.length}`);
      console.log(`Processing time:  ${formatTime(elapsed)}`);
      console.log(`Processing speed: ${(results.metadata.totalFrames / elapsed).toFixed(1)} fps`);
      if (results.metadata.codec) {
        console.log(`Video codec:      ${results.metadata.codec}`);
      }
      if (results.metadata.pixelFormat) {
        console.log(`Pixel format:     ${results.metadata.pixelFormat}`);
      }
      if (results.metadata.bitrate) {
        console.log(`Bitrate:          ${(results.metadata.bitrate / 1000).toFixed(0)} kbps`);
      }
      console.log('='.repeat(60));
    }

    // Format output
    const videoBasename = path.basename(videoPath, path.extname(videoPath));
    const inputFilename = path.basename(videoPath);
    let output;
    let targetExt;
    switch (outputFormat) {
      case 'csv':          output = formatCsv(results);              targetExt = '.csv';         break;
      case 'txt':
      case 'aegisub':      output = formatAegisub(results);          targetExt = '.txt';         break;
      case 'tc':
      case 'timecode':     output = formatTimecodeList(results);     targetExt = '.txt';         break;
      case 'edl':          output = formatEdl(results, videoBasename); targetExt = '.edl';       break;
      case 'fcpxml':       output = formatFcpxml(results, inputFilename); targetExt = '.fcpxml'; break;
      case 'premiere-csv':
      case 'premiere':     output = formatPremiereMarkers(results);  targetExt = '.markers.csv'; break;
      default:             output = formatJson(results);             targetExt = '.json';        break;
    }
    // If -o was given, rewrite its extension to match the chosen format.
    const knownExts = ['.markers.csv', '.json', '.csv', '.txt', '.edl', '.fcpxml'];
    for (const ext of knownExts) {
      if (outputPath.endsWith(ext)) {
        outputPath = outputPath.slice(0, -ext.length) + targetExt;
        break;
      }
    }

    // Save to file
    fs.writeFileSync(outputPath, output);

    if (!quiet) {
      console.log(`Results saved to: ${path.resolve(outputPath)}`);

      if (verbose) {
        console.log();
        // Print scene list
        console.log('Scene List:');
        results.scenes.forEach((scene, i) => {
          const confidenceStr = scene.confidence != null ? ` (${(scene.confidence * 100).toFixed(0)}%)` : '';
          const durationStr = scene.duration != null ? ` [${formatTime(scene.duration)}]` : '';
          console.log(`  ${(i + 1).toString().padStart(3)}. Frame ${scene.frameNumber.toString().padStart(6)} at ${scene.timecode}${confidenceStr}${durationStr}`);
        });
      }
    } else {
      // In quiet mode, just print the output
      console.log(output);
    }

    process.exit(0);

  } catch (error) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (error.message === 'Detection aborted') {
      console.error();
      console.error('Detection aborted (timeout or cancellation).');
      process.exit(2);
    }

    console.error();
    console.error('Error:', error.message);
    if (verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Helper functions
function createProgressBar(percent) {
  const width = 30;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + ']';
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  } else if (m > 0) {
    return `${m}m ${s}s`;
  } else {
    return `${s}s`;
  }
}

// Run
run();
