/**
 * VideoElementSource — a FrameSource that drives an <video> element via
 * requestVideoFrameCallback. Works with any format the browser can decode.
 *
 * Frames come out grayscale (Rec. 601 luma) at native resolution (or
 * downscaled if maxDimension is set). Two alternating buffers are kept so the
 * detector's prev/cur pair stays valid across frames.
 */

import type { FrameSource, RawFrame, VideoMetadata } from '@doedja/scenecut-core';

export interface VideoElementSourceOptions {
  /**
   * Assumed fps, used to size the detector's warmup and minGap. Actual
   * per-frame timestamps come from rVFC mediaTime regardless. Default 30.
   */
  fps?: number;
  /**
   * If set, downscale frames whose longest side exceeds this, preserving
   * aspect ratio. Major speedup on 4K content. Default: no downscaling.
   */
  maxDimension?: number;
  /**
   * playbackRate hint. Browsers typically cap at ~16×; values above still
   * decode as fast as possible. Default 16.
   */
  playbackRate?: number;
}

export class VideoElementSource implements FrameSource {
  private file: File | Blob;
  private options: Required<Omit<VideoElementSourceOptions, 'maxDimension'>> & { maxDimension: number };
  private video: HTMLVideoElement | null = null;
  private objectUrl: string | null = null;
  private metadata: VideoMetadata | null = null;

  constructor(file: File | Blob, options: VideoElementSourceOptions = {}) {
    this.file = file;
    this.options = {
      fps: options.fps ?? 30,
      maxDimension: options.maxDimension ?? Infinity,
      playbackRate: options.playbackRate ?? 16
    };
  }

  async getMetadata(): Promise<VideoMetadata> {
    if (this.metadata) return this.metadata;
    const video = await this.loadVideo();
    const { width, height } = this.targetResolution(video.videoWidth, video.videoHeight);
    const duration = video.duration;
    const fps = this.options.fps;
    this.metadata = {
      totalFrames: Math.floor(duration * fps),
      duration,
      fps,
      resolution: { width, height }
    };
    return this.metadata;
  }

  async extractFrames(
    onFrame: (frame: RawFrame) => Promise<void> | void,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const meta = await this.getMetadata();
    const video = await this.loadVideo();
    const { width, height } = meta.resolution;
    const frameSize = width * height;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

    const grayA = new Uint8Array(frameSize);
    const grayB = new Uint8Array(frameSize);
    let useA = true;
    let frameNumber = 0;

    if (typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback !== 'function') {
      throw new Error('requestVideoFrameCallback is not supported in this browser');
    }

    return new Promise<void>((resolve, reject) => {
      let ended = false;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        video.pause();
        resolve();
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        video.pause();
        reject(err);
      };

      const onAbort = () => fail(new Error('Detection aborted'));
      if (signal) {
        if (signal.aborted) { fail(new Error('Detection aborted')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      video.addEventListener('ended', () => { ended = true; });
      video.addEventListener('error', () => fail(new Error('Video element error')));

      const step = async (_now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => {
        if (settled) return;
        try {
          ctx.drawImage(video, 0, 0, width, height);
          const img = ctx.getImageData(0, 0, width, height);
          const src = img.data;
          const gray = useA ? grayA : grayB;
          useA = !useA;
          // RGBA → Rec. 601 luma
          for (let i = 0, j = 0; i < src.length; i += 4, j++) {
            gray[j] = (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) | 0;
          }
          const frame: RawFrame = {
            data: gray,
            width,
            height,
            stride: width,
            pts: metadata.mediaTime,
            frameNumber
          };
          await onFrame(frame);
          if (onProgress && frameNumber % 15 === 0) {
            onProgress(frameNumber, meta.totalFrames);
          }
          frameNumber++;
          if (ended) { finish(); return; }
          video.requestVideoFrameCallback(step);
        } catch (err) {
          fail(err);
        }
      };

      video.playbackRate = this.options.playbackRate;
      video.requestVideoFrameCallback(step);
      video.play().catch(fail);
    });
  }

  destroy(): void {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.video = null;
    this.metadata = null;
  }

  private async loadVideo(): Promise<HTMLVideoElement> {
    if (this.video) return this.video;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    this.objectUrl = URL.createObjectURL(this.file);
    video.src = this.objectUrl;
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Failed to load video')); };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
    this.video = video;
    return video;
  }

  private targetResolution(nativeW: number, nativeH: number): { width: number; height: number } {
    const longest = Math.max(nativeW, nativeH);
    if (!isFinite(this.options.maxDimension) || longest <= this.options.maxDimension) {
      return { width: nativeW, height: nativeH };
    }
    const scale = this.options.maxDimension / longest;
    return {
      width: Math.round(nativeW * scale),
      height: Math.round(nativeH * scale)
    };
  }
}
