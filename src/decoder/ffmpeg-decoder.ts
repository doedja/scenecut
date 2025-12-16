/**
 * FFmpeg Decoder - Extract frames from video files
 *
 * Uses fluent-ffmpeg to extract grayscale frames for scene detection
 */

import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { RawFrame, VideoMetadata } from '../types';
import { FrameBuffer } from './frame-buffer';
import { Readable } from 'stream';

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
   * Read data from the ring buffer
   */
  read(size: number): Buffer {
    if (size > this.availableBytes) {
      throw new Error('RingBuffer underflow: not enough data available');
    }

    const result = Buffer.allocUnsafe(size);
    const endSpace = this.capacity - this.readPos;

    if (size <= endSpace) {
      // No wrap-around needed
      this.buffer.copy(result, 0, this.readPos, this.readPos + size);
      this.readPos += size;
    } else {
      // Wrap-around: split read
      this.buffer.copy(result, 0, this.readPos, this.capacity);
      this.buffer.copy(result, endSpace, 0, size - endSpace);
      this.readPos = size - endSpace;
    }

    // Wrap read position if at end
    if (this.readPos >= this.capacity) {
      this.readPos = 0;
    }

    this.availableBytes -= size;
    return result;
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
   * Get video metadata
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
          }
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
   * @param onFrame Callback for each frame
   * @param onProgress Optional progress callback
   */
  async extractFrames(
    onFrame: (frame: RawFrame) => Promise<void> | void,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    const metadata = await this.getMetadata();
    const { width, height } = metadata.resolution;

    return new Promise((resolve, reject) => {
      let frameNumber = 0;
      const ringBuffer = new RingBuffer(); // 8MB ring buffer
      const frameSize = width * height; // Grayscale: 1 byte per pixel

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

      stream.on('data', async (chunk: Buffer) => {
        // Write chunk to ring buffer (no allocation, no copying)
        ringBuffer.write(chunk);

        // Process complete frames
        while (ringBuffer.available() >= frameSize) {
          const frameData = ringBuffer.read(frameSize);

          // Skip frames if requested
          if (this.options.skipFrames > 0 && frameNumber % (this.options.skipFrames + 1) !== 0) {
            frameNumber++;
            continue;
          }

          // Create RawFrame
          const frame: RawFrame = {
            data: new Uint8Array(frameData),
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
