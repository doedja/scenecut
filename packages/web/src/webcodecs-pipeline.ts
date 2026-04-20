/**
 * Shared WebCodecs decode → grayscale pipeline.
 *
 * Demuxers (mp4, mkv) produce `EncodedSample`s plus a config. This file runs
 * those through a `VideoDecoder`, pulls the I420 Y-plane (or RGBA if the
 * caller is downscaling through a canvas), and delivers grayscale RawFrames.
 */

import type { RawFrame, VideoMetadata } from '@doedja/scenecut-core';

const YUV8_PLANAR = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);

export interface EncodedSample {
  /** Encoded frame bytes in the format VideoDecoder expects for this codec. */
  data: Uint8Array;
  /** Presentation time in microseconds. */
  timestamp: number;
  /** Frame duration in microseconds. */
  duration: number;
  /** True when this is an independent keyframe (sync sample). */
  isKey: boolean;
}

export interface DecodePipelineInput {
  config: VideoDecoderConfig;
  samples: Iterable<EncodedSample>;
  metadata: VideoMetadata;
  /** Native frame size (may differ from metadata.resolution if downscaling). */
  nativeWidth: number;
  nativeHeight: number;
  decodeQueueTarget?: number;
}

export async function runDecodePipeline(
  input: DecodePipelineInput,
  onFrame: (frame: RawFrame) => Promise<void> | void,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const { config, samples, metadata, nativeWidth, nativeHeight } = input;
  const queueTarget = input.decodeQueueTarget ?? 30;

  const outW = metadata.resolution.width;
  const outH = metadata.resolution.height;
  const outSize = outW * outH;
  const needsScale = outW !== nativeWidth || outH !== nativeHeight;

  const grayA = new Uint8Array(outSize);
  const grayB = new Uint8Array(outSize);
  let useA = true;

  // Grows on demand. Video frames can be in a variety of formats (I420, NV12,
  // I422, I444, RGBA, 10-bit variants), each with different allocation sizes.
  let planeBuf: Uint8Array = new Uint8Array(0);

  // Lazy canvas used as a universal fallback (RGB packed, 10-bit, etc.) and
  // when downscaling is requested.
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  const ensureCanvas = () => {
    if (!canvas || !ctx) {
      canvas = new OffscreenCanvas(outW, outH);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    }
    return ctx;
  };

  let frameNumber = 0;
  let decoderError: Error | null = null;
  // Serial chain so detector state mutates one frame at a time. The pool still
  // parallelizes WASM — only the main-thread book-keeping is serialized.
  let chainTail: Promise<void> = Promise.resolve();

  const decoder = new VideoDecoder({
    output: (videoFrame: VideoFrame) => {
      const ts = Number(videoFrame.timestamp) / 1_000_000;
      chainTail = chainTail.then(async () => {
        try {
          if (signal?.aborted || decoderError) { videoFrame.close(); return; }

          const gray = useA ? grayA : grayB;
          useA = !useA;

          const format = videoFrame.format;
          const canReadYPlane = !needsScale && format !== null && YUV8_PLANAR.has(format);

          if (canReadYPlane) {
            // Fast path: read native layout, Y plane is the first plane for
            // all YUV planar formats. Zero conversion to grayscale.
            const needed = videoFrame.allocationSize();
            if (planeBuf.length < needed) planeBuf = new Uint8Array(needed);
            let layout: PlaneLayout[];
            try {
              layout = await videoFrame.copyTo(planeBuf);
            } catch {
              videoFrame.close();
              throw new Error(`VideoFrame.copyTo failed in native format ${format}`);
            }
            const yLayout = layout[0];
            const yStride = yLayout.stride;
            const yOffset = yLayout.offset;
            if (yStride === nativeWidth && yOffset === 0) {
              gray.set(planeBuf.subarray(0, outSize));
            } else {
              for (let y = 0; y < nativeHeight; y++) {
                const srcRow = yOffset + y * yStride;
                gray.set(planeBuf.subarray(srcRow, srcRow + nativeWidth), y * nativeWidth);
              }
            }
            videoFrame.close();
          } else {
            // Universal fallback — works for RGB, 10-bit, BGRA, or any format
            // drawImage can paint. Also handles downscaling.
            const c = ensureCanvas();
            c.drawImage(videoFrame, 0, 0, outW, outH);
            videoFrame.close();
            const img = c.getImageData(0, 0, outW, outH);
            const src = img.data;
            for (let i = 0, j = 0; i < src.length; i += 4, j++) {
              gray[j] = (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) | 0;
            }
          }

          await onFrame({
            data: gray,
            width: outW,
            height: outH,
            stride: outW,
            pts: ts,
            frameNumber
          });
          if (onProgress && frameNumber % 15 === 0) {
            onProgress(frameNumber, metadata.totalFrames);
          }
          frameNumber++;
        } catch (err) {
          decoderError = err as Error;
        }
      });
    },
    error: (err) => {
      decoderError = err instanceof Error ? err : new Error(String(err));
    }
  });

  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`VideoDecoder does not support this configuration (codec: ${config.codec})`);
  }
  decoder.configure(config);

  for (const sample of samples) {
    if (signal?.aborted) { decoder.close(); throw new Error('Detection aborted'); }
    if (decoderError) throw decoderError;

    decoder.decode(new EncodedVideoChunk({
      type: sample.isKey ? 'key' : 'delta',
      timestamp: sample.timestamp,
      duration: sample.duration,
      data: sample.data
    }));

    while (decoder.decodeQueueSize > queueTarget) {
      await new Promise<void>(r => setTimeout(r, 0));
      if (signal?.aborted) { decoder.close(); throw new Error('Detection aborted'); }
    }
  }

  await decoder.flush();
  decoder.close();
  await chainTail;
  if (decoderError) throw decoderError;
}
