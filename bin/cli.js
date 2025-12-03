#!/usr/bin/env node

/**
 * Keyframes CLI - Simple command-line interface for scene detection
 *
 * Usage:
 *   keyframes input.mp4
 *   keyframes input.mkv --output results.json
 *   keyframes video.mp4 --sensitivity high
 */

const { detectSceneChanges } = require('../dist/keyframes.cjs.js');
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

Options:
  --output, -o <file>       Output file (default: {filename}_keyframes.txt)
  --format, -f <format>     Output format: json|csv|aegisub|timecode (default: aegisub)
  --sensitivity, -s <level> Sensitivity: low|medium|high (default: medium)
  --quiet, -q               Suppress progress output
  --verbose, -v             Show detailed output
  --help, -h                Show this help

Formats:
  json                      JSON with full metadata
  csv                       CSV with frame,timestamp,timecode
  aegisub (or txt)          Aegisub keyframes format (frame numbers)
  timecode (or tc)          Simple timecode list (HH:MM:SS.mmm)

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
let quiet = false;
let verbose = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--output' || arg === '-o') {
    outputPath = args[++i];
  } else if (arg === '--format' || arg === '-f') {
    outputFormat = args[++i];
  } else if (arg === '--sensitivity' || arg === '-s') {
    sensitivity = args[++i];
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
  const extension = (outputFormat === 'json') ? '.json' :
                    (outputFormat === 'csv') ? '.csv' : '.txt';
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
    console.log('='.repeat(60));
    console.log();
  }

  const startTime = Date.now();
  let lastProgressTime = startTime;
  let lastProgressFrame = 0;
  let sceneCount = 0;

  try {
    const results = await detectSceneChanges(videoPath, {
      sensitivity,
      searchRange: 'medium',
      onProgress: (progress) => {
        if (quiet) return;

        const now = Date.now();
        // Update every 3 seconds
        if (now - lastProgressTime > 3000 || progress.percent === 100) {
          const framesSinceLastUpdate = progress.currentFrame - lastProgressFrame;
          const timeSinceLastUpdate = (now - lastProgressTime) / 1000;
          const currentFps = framesSinceLastUpdate / timeSinceLastUpdate;

          const progressBar = createProgressBar(progress.percent);
          const etaStr = progress.eta ? ` ETA: ${formatTime(progress.eta)}` : '';

          process.stdout.write(
            `\r${progressBar} ${progress.percent.toString().padStart(3)}% ` +
            `[${currentFps.toFixed(1)} fps]${etaStr}${' '.repeat(10)}`
          );

          lastProgressTime = now;
          lastProgressFrame = progress.currentFrame;
        }
      },
      onScene: (scene) => {
        sceneCount++;
        if (verbose && !quiet) {
          console.log();
          console.log(`  Scene ${sceneCount}: Frame ${scene.frameNumber} at ${scene.timecode}`);
        }
      }
    });

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
      console.log('='.repeat(60));
    }

    // Format output
    let output;
    if (outputFormat === 'csv') {
      output = formatCSV(results);
      if (outputPath.endsWith('.json')) {
        outputPath = outputPath.replace('.json', '.csv');
      }
    } else if (outputFormat === 'aegisub' || outputFormat === 'txt') {
      output = formatAegisub(results);
      if (outputPath.endsWith('.json')) {
        outputPath = outputPath.replace('.json', '.txt');
      }
    } else if (outputFormat === 'timecode' || outputFormat === 'tc') {
      output = formatTimecode(results);
      if (outputPath.endsWith('.json')) {
        outputPath = outputPath.replace('.json', '.txt');
      }
    } else {
      output = JSON.stringify(results, null, 2);
    }

    // Save to file
    fs.writeFileSync(outputPath, output);

    if (!quiet) {
      console.log(`Results saved to: ${path.resolve(outputPath)}`);
      console.log();

      // Print scene list
      console.log('Scene List:');
      results.scenes.forEach((scene, i) => {
        console.log(`  ${(i + 1).toString().padStart(3)}. Frame ${scene.frameNumber.toString().padStart(6)} at ${scene.timecode}`);
      });
    } else {
      // In quiet mode, just print the output
      console.log(output);
    }

    process.exit(0);

  } catch (error) {
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
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
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

function formatCSV(results) {
  let csv = 'frame,timestamp,timecode\n';
  results.scenes.forEach(scene => {
    csv += `${scene.frameNumber},${scene.timestamp},${scene.timecode || ''}\n`;
  });
  return csv;
}

function formatAegisub(results) {
  // Aegisub keyframes format - simple text file with frame numbers
  // One frame number per line
  let output = '# keyframe format v1\n';
  output += `fps ${results.metadata.fps}\n`;
  results.scenes.forEach(scene => {
    output += `${scene.frameNumber}\n`;
  });
  return output;
}

function formatTimecode(results) {
  // Simple timecode list - one per line
  // Can be used with various subtitle tools
  let output = '';
  results.scenes.forEach(scene => {
    output += `${scene.timecode || formatTimecodeFull(scene.timestamp)}\n`;
  });
  return output;
}

function formatTimecodeFull(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

// Run
run();
