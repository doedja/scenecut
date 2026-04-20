/**
 * FFmpeg Decoder — extracts grayscale frames from video files.
 */

import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { Readable } from 'stream';
import * as path from 'path';
import * as fs from 'fs';
import type { RawFrame, VideoMetadata, FrameSource } from '@doedja/scenecut-core';
import type { FrameImageOptions } from './types';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

/** Fixed-size circular buffer. Eliminates repeated Buffer.concat() churn. */
class RingBuffer {
  private buffer: Buffer;
  private writePos = 0;
  private readPos = 0;
  private availableBytes = 0;
  private capacity: number;

  constructor(size: number = 8 * 1024 * 1024) {
    this.buffer = Buffer.allocUnsafe(size);
    this.capacity = size;
  }

  write(chunk: Buffer): void {
    const chunkSize = chunk.length;
    if (chunkSize > this.capacity - this.availableBytes) {
      throw new Error('RingBuffer overflow: chunk too large for available space');
    }
    const endSpace = this.capacity - this.writePos;
    if (chunkSize <= endSpace) {
      chunk.copy(this.buffer, this.writePos);
      this.writePos += chunkSize;
    } else {
      chunk.copy(this.buffer, this.writePos, 0, endSpace);
      chunk.copy(this.buffer, 0, endSpace, chunkSize);
      this.writePos = chunkSize - endSpace;
    }
    if (this.writePos >= this.capacity) this.writePos = 0;
    this.availableBytes += chunkSize;
  }

  read(size: number): Buffer {
    if (size > this.availableBytes) {
      throw new Error('RingBuffer underflow');
    }
    const result = Buffer.allocUnsafe(size);
    const endSpace = this.capacity - this.readPos;
    if (size <= endSpace) {
      this.buffer.copy(result, 0, this.readPos, this.readPos + size);
      this.readPos += size;
    } else {
      this.buffer.copy(result, 0, this.readPos, this.capacity);
      this.buffer.copy(result, endSpace, 0, size - endSpace);
      this.readPos = size - endSpace;
    }
    if (this.readPos >= this.capacity) this.readPos = 0;
    this.availableBytes -= size;
    return result;
  }

  readInto(target: Uint8Array, offset: number, size: number): void {
    if (size > this.availableBytes) {
      throw new Error('RingBuffer underflow');
    }
    const endSpace = this.capacity - this.readPos;
    if (size <= endSpace) {
      for (let i = 0; i < size; i++) target[offset + i] = this.buffer[this.readPos + i];
      this.readPos += size;
    } else {
      for (let i = 0; i < endSpace; i++) target[offset + i] = this.buffer[this.readPos + i];
      const remaining = size - endSpace;
      for (let i = 0; i < remaining; i++) target[offset + endSpace + i] = this.buffer[i];
      this.readPos = remaining;
    }
    if (this.readPos >= this.capacity) this.readPos = 0;
    this.availableBytes -= size;
  }

  available(): number { return this.availableBytes; }
}

export interface DecoderOptions {
  pixelFormat?: 'gray' | 'yuv420p';
  maxBufferFrames?: number;
  skipFrames?: number;
}

export class FFmpegDecoder implements FrameSource {
  private videoPath: string;
  private options: Required<DecoderOptions>;
  private metadata: VideoMetadata | null = null;

  constructor(videoPath: string, options: DecoderOptions = {}) {
    this.videoPath = videoPath;
    this.options = {
      pixelFormat: options.pixelFormat || 'gray',
      maxBufferFrames: options.maxBufferFrames || 2,
      skipFrames: options.skipFrames || 0
    };
  }

  async getMetadata(): Promise<VideoMetadata> {
    if (this.metadata) return this.metadata;

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
          codec: (videoStream as unknown as { codec_name?: string }).codec_name,
          pixelFormat: (videoStream as unknown as { pix_fmt?: string }).pix_fmt,
          bitrate: metadata.format.bit_rate ? parseInt(String(metadata.format.bit_rate)) : undefined
        };
        resolve(this.metadata);
      });
    });
  }

  private parseFps(fpsString: string): number {
    const parts = fpsString.split('/');
    if (parts.length === 2) return parseInt(parts[0]) / parseInt(parts[1]);
    return parseFloat(fpsString);
  }

  async extractFrames(
    onFrame: (frame: RawFrame) => Promise<void> | void,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const metadata = await this.getMetadata();
    const { width, height } = metadata.resolution;

    return new Promise((resolve, reject) => {
      let frameNumber = 0;
      const frameSize = width * height;
      const ringBufferSize = Math.max(4 * 1024 * 1024, frameSize * 3);
      const ringBuffer = new RingBuffer(ringBufferSize);
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
        .on('end', () => resolve());

      const stream = command.pipe() as Readable;

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
        ringBuffer.write(chunk);
        while (ringBuffer.available() >= frameSize) {
          if (this.options.skipFrames > 0 && frameNumber % (this.options.skipFrames + 1) !== 0) {
            ringBuffer.read(frameSize);
            frameNumber++;
            continue;
          }
          const targetBuffer = useBufferA ? frameBufferA : frameBufferB;
          ringBuffer.readInto(targetBuffer, 0, frameSize);
          useBufferA = !useBufferA;

          const frame: RawFrame = {
            data: targetBuffer,
            width,
            height,
            stride: width,
            pts: frameNumber / metadata.fps,
            frameNumber
          };
          try {
            await onFrame(frame);
          } catch (err) {
            stream.destroy();
            reject(err);
            return;
          }
          if (onProgress && frameNumber % 30 === 0) {
            onProgress(frameNumber, metadata.totalFrames);
          }
          frameNumber++;
        }
      });

      stream.on('error', (err: Error) => {
        reject(new Error(`Stream error: ${err.message}`));
      });
    });
  }

  async extractFrameImages(
    frameNumbers: number[],
    options: FrameImageOptions
  ): Promise<string[]> {
    const metadata = await this.getMetadata();

    if (!fs.existsSync(options.outputDir)) {
      fs.mkdirSync(options.outputDir, { recursive: true });
    }

    const format = options.format || 'jpg';
    const quality = options.quality || 85;
    const template = options.filenameTemplate || 'scene_{frame}';
    const selectExpr = frameNumbers.map(n => `eq(n\\,${n})`).join('+');

    return new Promise((resolve, reject) => {
      const outputPaths: string[] = [];
      for (const frameNum of frameNumbers) {
        const timestamp = frameNum / metadata.fps;
        const filename = template
          .replace('{frame}', String(frameNum))
          .replace('{timestamp}', timestamp.toFixed(3));
        outputPaths.push(path.join(options.outputDir, `${filename}.${format}`));
      }
      const outputPattern = path.join(
        options.outputDir,
        `${template.replace('{frame}', '%d').replace('{timestamp}', '%d')}.${format}`
      );
      const scaleFilter = options.width ? `,scale=${options.width}:-1` : '';
      const outputOptions: string[] = [
        '-vf', `select='${selectExpr}'${scaleFilter},setpts=N/TB`,
        '-vsync', 'vfr'
      ];
      if (format === 'jpg') {
        outputOptions.push('-qscale:v', String(Math.round((100 - quality) / 3.33)));
      }
      ffmpeg.default(this.videoPath)
        .outputOptions(outputOptions)
        .output(outputPattern)
        .on('error', (err: Error) => reject(new Error(`FFmpeg frame extraction error: ${err.message}`)))
        .on('end', () => resolve(outputPaths))
        .run();
    });
  }

  destroy(): void {
    // No persistent state to tear down.
  }
}
