/**
 * MP4 / MOV FrameSource.
 *
 * Demuxes with mp4box.js, feeds encoded samples into the shared WebCodecs
 * decode pipeline. For MKV / WebM see `MkvSource`.
 */

import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import type { FrameSource, RawFrame, VideoMetadata } from '@doedja/scenecut-core';
import type { EncodedSample } from './webcodecs-pipeline';
import { runDecodePipeline } from './webcodecs-pipeline';

export interface WebCodecsSourceOptions {
  maxDimension?: number;
  decodeQueueTarget?: number;
}

/** True if this browser has a working WebCodecs VideoDecoder. */
export function isWebCodecsSupported(): boolean {
  return typeof globalThis.VideoDecoder !== 'undefined';
}

/** MP4-family extension / mime heuristic. */
export function isMp4LikeFile(file: File | Blob): boolean {
  if (file instanceof File) {
    if (/\.(mp4|m4v|mov|3gp|3g2)$/i.test(file.name)) return true;
    if (file.type && /(mp4|quicktime)/i.test(file.type)) return true;
    return false;
  }
  return !!file.type && /(mp4|quicktime)/i.test(file.type);
}

export class WebCodecsSource implements FrameSource {
  private file: File | Blob;
  private options: WebCodecsSourceOptions;
  private metadata: VideoMetadata | null = null;

  constructor(file: File | Blob, options: WebCodecsSourceOptions = {}) {
    this.file = file;
    this.options = options;
  }

  async getMetadata(): Promise<VideoMetadata> {
    if (this.metadata) return this.metadata;
    const parsed = await this.parseHeaders();
    const target = this.targetResolution(parsed.nativeWidth, parsed.nativeHeight);
    this.metadata = {
      totalFrames: parsed.totalFrames,
      duration: parsed.duration,
      fps: parsed.fps,
      resolution: target,
      codec: parsed.codec
    };
    return this.metadata;
  }

  async extractFrames(
    onFrame: (frame: RawFrame) => Promise<void> | void,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const meta = await this.getMetadata();
    const parsed = await this.parseHeaders();

    await runDecodePipeline(
      {
        config: parsed.config,
        samples: parsed.samples,
        metadata: meta,
        nativeWidth: parsed.nativeWidth,
        nativeHeight: parsed.nativeHeight,
        decodeQueueTarget: this.options.decodeQueueTarget
      },
      onFrame,
      onProgress,
      signal
    );
  }

  destroy(): void {
    this.metadata = null;
    this.headersPromise = null;
  }

  private headersPromise: Promise<{
    config: VideoDecoderConfig;
    samples: EncodedSample[];
    nativeWidth: number;
    nativeHeight: number;
    fps: number;
    duration: number;
    totalFrames: number;
    codec: string;
  }> | null = null;

  private parseHeaders() {
    if (this.headersPromise) return this.headersPromise;
    this.headersPromise = (async () => {
      const mp4boxfile = createFile();

      let resolveInfo: (v: Movie) => void;
      const infoReady = new Promise<Movie>(r => { resolveInfo = r; });

      mp4boxfile.onReady = (i: Movie) => resolveInfo(i);
      mp4boxfile.onError = (mod: string, msg: string) => {
        throw new Error(`mp4box: ${mod}: ${msg}`);
      };

      const collected: Array<{ cts: number; duration: number; is_sync: boolean; data?: Uint8Array; timescale: number }> = [];
      mp4boxfile.onSamples = (_tid: number, _u: unknown, chunk: Array<{ cts: number; duration: number; is_sync: boolean; data?: Uint8Array; timescale: number }>) => {
        for (const s of chunk) collected.push(s);
      };

      const reader = this.file.stream().getReader();
      let offset = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
        mp4boxfile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, offset));
        offset += value.byteLength;
      }
      mp4boxfile.flush();

      const movie = await infoReady;
      const videoTrack = movie.videoTracks[0];
      if (!videoTrack) throw new Error('no video track found in file');

      const description = extractDescription(mp4boxfile, videoTrack.id);

      mp4boxfile.setExtractionOptions(videoTrack.id, null, { nbSamples: 1_000_000 });
      mp4boxfile.start();
      mp4boxfile.flush();

      const duration = movie.duration / movie.timescale;
      const fps = videoTrack.nb_samples > 0 && duration > 0
        ? videoTrack.nb_samples / duration
        : 30;
      const nativeWidth = videoTrack.video?.width ?? videoTrack.track_width;
      const nativeHeight = videoTrack.video?.height ?? videoTrack.track_height;

      const samples: EncodedSample[] = collected.map(s => ({
        data: s.data!,
        timestamp: (s.cts * 1_000_000) / (s.timescale || 90_000),
        duration: (s.duration * 1_000_000) / (s.timescale || 90_000),
        isKey: !!s.is_sync
      }));

      const config: VideoDecoderConfig = {
        codec: videoTrack.codec,
        codedWidth: nativeWidth,
        codedHeight: nativeHeight,
        description,
        optimizeForLatency: false
      };

      return {
        config,
        samples,
        nativeWidth,
        nativeHeight,
        fps,
        duration,
        totalFrames: videoTrack.nb_samples,
        codec: videoTrack.codec
      };
    })();
    return this.headersPromise;
  }

  private targetResolution(nativeW: number, nativeH: number): { width: number; height: number } {
    const max = this.options.maxDimension;
    if (!max || !isFinite(max)) return { width: nativeW, height: nativeH };
    const longest = Math.max(nativeW, nativeH);
    if (longest <= max) return { width: nativeW, height: nativeH };
    const scale = max / longest;
    return { width: Math.round(nativeW * scale), height: Math.round(nativeH * scale) };
  }
}

interface Movie {
  duration: number;
  timescale: number;
  videoTracks: Array<{
    id: number;
    codec: string;
    nb_samples: number;
    timescale: number;
    track_width: number;
    track_height: number;
    video?: { width: number; height: number };
  }>;
}

function extractDescription(mp4boxfile: ReturnType<typeof createFile>, trackId: number): Uint8Array | undefined {
  const trak = mp4boxfile.getTrackById(trackId) as unknown as {
    mdia: { minf: { stbl: { stsd: { entries: unknown[] } } } };
  };
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || entries.length === 0) return undefined;

  for (const entry of entries as Array<Record<string, unknown>>) {
    const box = (entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C) as
      | { write: (stream: DataStream) => void; size?: number }
      | undefined;
    if (!box || typeof box.write !== 'function') continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer as ArrayBuffer, 8);
  }
  return undefined;
}
