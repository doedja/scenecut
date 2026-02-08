/**
 * FFmpeg Decoder - Extract frames from video files
 *
 * Uses fluent-ffmpeg to extract grayscale frames for scene detection
 */

import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { RawFrame, VideoMetadata, FrameImageOptions } from '../types';
import { FrameBuffer } from './frame-buffer';
import { Readable } from 'stream';
import * as path from 'path';
import * as fs from 'fs';

// Set FFmpeg and FFprobe paths from installers
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

/**
 * Ring Buffer - Fixed-size circular buffer for streaming data
 * Eliminates repeated Buffer.concat() allocations and GC pressure
 */
class RingBuffer {
  private buffer: Buffer;
  private writePos: number = 0;
  private readPos: number = 0;
  private availableBytes: number = 0;
  private capacity: number;

  constructor(size: number = 8 * 1024 * 1024) { // 8MB default
    this.buffer = Buffer.allocUnsafe(size);
    this.capacity = size;
  }

  /**
   * Write data to the ring buffer
   */
  write(chunk: Buffer): void {
    const chunkSize = chunk.length;

    if (chunkSize > this.capacity - this.availableBytes) {
      throw new Error('RingBuffer overflow: chunk too large for available space');
    }

    // Write in two parts if wrapping around
    const endSpace = this.capacity - this.writePos;

    if (chunkSize <= endSpace) {
      // No wrap-around needed
      chunk.copy(this.buffer, this.writePos);
      this.writePos += chunkSize;
    } else {
      // Wrap-around: split write
      chunk.copy(this.buffer, this.writePos, 0, endSpace);
      chunk.copy(this.buffer, 0, endSpace, chunkSize);
      this.writePos = chunkSize - endSpace;
    }

    // Wrap write position if at end
    if (this.writePos >= this.capacity) {
      this.writePos = 0;
    }

    this.availableBytes += chunkSize;
  }

  /**
   * Read data from the ring buffer (allocates new buffer)
   */
  read(size: number): Buffer {
    if (size > this.availableBytes) {
      throw new Error('RingBuffer underflow: not enough data available');
    }

    const result = Buffer.allocUnsafe(size);
    this.readIntoBuffer(result, 0, size);
    return result;
  }

  /**
   * Read data directly into a pre-allocated Uint8Array (zero-allocation)
   */
  readInto(target: Uint8Array, offset: number, size: number): void {
    if (size > this.availableBytes) {
      throw new Error('RingBuffer underflow: not enough data available');
    }

    const endSpace = this.capacity - this.readPos;

    if (size <= endSpace) {
      // No wrap-around needed
      for (let i = 0; i < size; i++) {
        target[offset + i] = this.buffer[this.readPos + i];
      }
      this.readPos += size;
    } else {
      // Wrap-around: split read
      for (let i = 0; i < endSpace; i++) {
        target[offset + i] = this.buffer[this.readPos + i];
      }
      const remaining = size - endSpace;
      for (let i = 0; i < remaining; i++) {
        target[offset + endSpace + i] = this.buffer[i];
      }
      this.readPos = remaining;
    }

    // Wrap read position if at end
    if (this.readPos >= this.capacity) {
      this.readPos = 0;
    }

    this.availableBytes -= size;
  }

  /**
   * Internal: read into a Node.js Buffer
   */
  private readIntoBuffer(result: Buffer, offset: number, size: number): void {
    const endSpace = this.capacity - this.readPos;

    if (size <= endSpace) {
      this.buffer.copy(result, offset, this.readPos, this.readPos + size);
      this.readPos += size;
    } else {
      this.buffer.copy(result, offset, this.readPos, this.capacity);
      this.buffer.copy(result, offset + endSpace, 0, size - endSpace);
      this.readPos = size - endSpace;
    }

    if (this.readPos >= this.capacity) {
      this.readPos = 0;
    }

    this.availableBytes -= size;
  }

  /**
   * Get number of bytes available to read
   */
  available(): number {
    return this.availableBytes;
  }

  /**
   * Reset the ring buffer
   */
  reset(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.availableBytes = 0;
  }
}

export interface DecoderOptions {
  /** Pixel format for extraction (default: 'gray') */
  pixelFormat?: 'gray' | 'yuv420p';
  /** Maximum frames to buffer in memory */
  maxBufferFrames?: number;
  /** Skip every N frames for testing */
  skipFrames?: number;
}

export class FFmpegDecoder {
  private videoPath: string;
  private options: Required<DecoderOptions>;
  private metadata: VideoMetadata | null = null;
  private frameBuffer: FrameBuffer;

  constructor(videoPath: string, options: DecoderOptions = {}) {
    this.videoPath = videoPath;
    this.options = {
      pixelFormat: options.pixelFormat || 'gray',
      maxBufferFrames: options.maxBufferFrames || 2,
      skipFrames: options.skipFrames || 0
    };
    this.frameBuffer = new FrameBuffer(this.options.maxBufferFrames);
  }

  /**
   * Get video metadata (with richer codec/format info)
   */
  async getMetadata(): Promise<VideoMetadata> {
    if (this.metadata) {
      return this.metadata;
    }

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(this.videoPath, (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to read video metadata: ${err.message}`));
          return;
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        if (!videoStream) {
          reject(new Error('No video stream found'));
          return;
        }

        const fps = this.parseFps(videoStream.r_frame_rate || videoStream.avg_frame_rate || '30/1');
        const duration = parseFloat(String(metadata.format.duration || 0));
        const totalFrames = Math.floor(duration * fps);

        this.metadata = {
          totalFrames,
          duration,
          fps,
          resolution: {
            width: videoStream.width || 0,
            height: videoStream.height || 0
          },
          codec: (videoStream as any).codec_name || undefined,
          pixelFormat: (videoStream as any).pix_fmt || undefined,
          bitrate: metadata.format.bit_rate ? parseInt(String(metadata.format.bit_rate)) : undefined
        };

        resolve(this.metadata);
      });
    });
  }

  /**
   * Parse frame rate from FFmpeg format (e.g., "30000/1001")
   */
  private parseFps(fpsString: string): number {
    const parts = fpsString.split('/');
    if (parts.length === 2) {
      return parseInt(parts[0]) / parseInt(parts[1]);
    }
    return parseFloat(fpsString);
  }

  /**
   * Extract frames as grayscale data
   *
   * Uses pre-allocated alternating buffers to eliminate double allocation.
   * Auto-sizes ring buffer based on video resolution.
   *
   * @param onFrame Callback for each frame
   * @param onProgress Optional progress callback
   * @param signal Optional AbortSignal for cancellation
   */
  async extractFrames(
    onFrame: (frame: RawFrame) => Promise<void> | void,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const metadata = await this.getMetadata();
    const { width, height } = metadata.resolution;

    return new Promise((resolve, reject) => {
      let frameNumber = 0;
      const frameSize = width * height; // Grayscale: 1 byte per pixel

      // Auto-size ring buffer based on resolution (min 4MB, fits 3 frames)
      const ringBufferSize = Math.max(4 * 1024 * 1024, frameSize * 3);
      const ringBuffer = new RingBuffer(ringBufferSize);

      // Pre-allocate two alternating frame buffers (eliminates double allocation)
      const frameBufferA = new Uint8Array(frameSize);
      const frameBufferB = new Uint8Array(frameSize);
      let useBufferA = true;

      const command = ffmpeg.default(this.videoPath)
        .outputOptions([
          '-f', 'image2pipe',
          '-pix_fmt', 'gray',
          '-vcodec', 'rawvideo'
        ])
        .on('error', (err: Error) => {
          reject(new Error(`FFmpeg error: ${err.message}`));
        })
        .on('end', () => {
          resolve();
        });

      const stream = command.pipe() as Readable;

      // Listen for abort signal
      if (signal) {
        const onAbort = () => {
          stream.destroy();
          reject(new Error('Detection aborted'));
        };
        if (signal.aborted) {
          stream.destroy();
          reject(new Error('Detection aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      stream.on('data', async (chunk: Buffer) => {
        // Write chunk to ring buffer
        ringBuffer.write(chunk);

        // Process complete frames
        while (ringBuffer.available() >= frameSize) {
          // Skip frames if requested
          if (this.options.skipFrames > 0 && frameNumber % (this.options.skipFrames + 1) !== 0) {
            // Still need to consume the data from the ring buffer
            ringBuffer.read(frameSize);
            frameNumber++;
            continue;
          }

          // Read directly into pre-allocated buffer (zero-allocation)
          const targetBuffer = useBufferA ? frameBufferA : frameBufferB;
          ringBuffer.readInto(targetBuffer, 0, frameSize);
          useBufferA = !useBufferA;

          // Create RawFrame (reuses the pre-allocated buffer - no copy)
          const frame: RawFrame = {
            data: targetBuffer,
            width,
            height,
            stride: width,
            pts: frameNumber / metadata.fps,
            frameNumber
          };

          // Call callback
          try {
            await onFrame(frame);
          } catch (err) {
            stream.destroy();
            reject(err);
            return;
          }

          // Progress callback
          if (onProgress && frameNumber % 30 === 0) {
            onProgress(frameNumber, metadata.totalFrames);
          }

          frameNumber++;
        }
      });

      stream.on('error', (err) => {
        reject(new Error(`Stream error: ${err.message}`));
      });
    });
  }

  /**
   * Extract a single frame at specific frame number
   */
  async extractFrame(frameNumber: number): Promise<RawFrame> {
    const metadata = await this.getMetadata();
    const { width, height } = metadata.resolution;
    const timestamp = frameNumber / metadata.fps;

    return new Promise((resolve, reject) => {
      const ringBuffer = new RingBuffer();
      const frameSize = width * height;

      const command = ffmpeg.default(this.videoPath)
        .seekInput(timestamp)
        .outputOptions([
          '-vframes', '1',
          '-f', 'image2pipe',
          '-pix_fmt', 'gray',
          '-vcodec', 'rawvideo'
        ])
        .on('error', (err: Error) => {
          reject(new Error(`FFmpeg error: ${err.message}`));
        });

      const stream = command.pipe() as Readable;

      stream.on('data', (chunk: Buffer) => {
        ringBuffer.write(chunk);

        if (ringBuffer.available() >= frameSize) {
          const frameData = ringBuffer.read(frameSize);

          const frame: RawFrame = {
            data: new Uint8Array(frameData),
            width,
            height,
            stride: width,
            pts: timestamp,
            frameNumber
          };

          resolve(frame);
        }
      });

      stream.on('error', (err) => {
        reject(new Error(`Stream error: ${err.message}`));
      });
    });
  }

  /**
   * Extract multiple frame images in a single FFmpeg invocation
   * Uses FFmpeg's select filter to avoid N+1 process spawning
   *
   * @param frameNumbers Array of frame numbers to extract
   * @param options Image extraction options
   */
  async extractFrameImages(
    frameNumbers: number[],
    options: FrameImageOptions
  ): Promise<string[]> {
    const metadata = await this.getMetadata();

    // Ensure output directory exists
    if (!fs.existsSync(options.outputDir)) {
      fs.mkdirSync(options.outputDir, { recursive: true });
    }

    const format = options.format || 'jpg';
    const quality = options.quality || 85;
    const template = options.filenameTemplate || 'scene_{frame}';

    // Build FFmpeg select filter expression
    // select='eq(n,100)+eq(n,200)+eq(n,300)'
    const selectExpr = frameNumbers.map(n => `eq(n\\,${n})`).join('+');

    return new Promise((resolve, reject) => {
      const outputPaths: string[] = [];

      // Generate output filenames
      for (const frameNum of frameNumbers) {
        const timestamp = frameNum / metadata.fps;
        const filename = template
          .replace('{frame}', String(frameNum))
          .replace('{timestamp}', timestamp.toFixed(3));
        outputPaths.push(path.join(options.outputDir, `${filename}.${format}`));
      }

      // Use FFmpeg with select filter and output pattern
      const outputPattern = path.join(
        options.outputDir,
        `${template.replace('{frame}', '%d').replace('{timestamp}', '%d')}.${format}`
      );

      const outputOptions: string[] = [
        '-vf', `select='${selectExpr}',setpts=N/TB`,
        '-vsync', 'vfr'
      ];

      if (format === 'jpg') {
        outputOptions.push('-qscale:v', String(Math.round((100 - quality) / 3.33)));
      }

      if (options.width) {
        outputOptions.push('-vf', `select='${selectExpr}',scale=${options.width}:-1,setpts=N/TB`);
      }

      ffmpeg.default(this.videoPath)
        .outputOptions(outputOptions)
        .output(outputPattern)
        .on('error', (err: Error) => {
          reject(new Error(`FFmpeg frame extraction error: ${err.message}`));
        })
        .on('end', () => {
          resolve(outputPaths);
        })
        .run();
    });
  }

  /**
   * Get the frame buffer
   */
  getFrameBuffer(): FrameBuffer {
    return this.frameBuffer;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.frameBuffer.clear();
  }
}
