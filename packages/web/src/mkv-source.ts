/**
 * Matroska / WebM FrameSource.
 *
 * Minimal EBML parser, extracts H.264 / H.265 video tracks and their encoded
 * samples, then feeds the shared WebCodecs decode pipeline. The codec data
 * inside an MKV block is byte-for-byte identical to what's in an MP4 sample
 * for AVC / HEVC (length-prefixed NAL units), so no re-packing is needed.
 *
 * Supported: H.264, H.265 (HEVC), VP9, AV1 — whatever VideoDecoder accepts
 * with the CodecPrivate passed through as `description`. No-lacing blocks
 * only. Lacing is rare in real-world content.
 */

import type { FrameSource, RawFrame, VideoMetadata } from '@doedja/scenecut-core';
import type { EncodedSample } from './webcodecs-pipeline';
import { runDecodePipeline } from './webcodecs-pipeline';

/* ======================================================================
 * EBML primitives
 * ==================================================================== */

class EbmlReader {
  pos = 0;
  constructor(public buf: Uint8Array) {}

  eof(): boolean { return this.pos >= this.buf.length; }

  /** Read a VINT — returns its unmasked value and byte length. */
  readVint(): { value: number; length: number } {
    const first = this.buf[this.pos];
    if (first === 0) throw new Error(`invalid VINT leading byte 0 at ${this.pos}`);
    let mask = 0x80;
    let length = 1;
    while (!(first & mask)) { mask >>= 1; length++; if (length > 8) throw new Error('VINT length > 8'); }
    let value = first & (mask - 1);
    for (let i = 1; i < length; i++) {
      value = value * 256 + this.buf[this.pos + i];
    }
    this.pos += length;
    return { value, length };
  }

  /** Read an element ID — the raw VINT bytes including the length marker. */
  readId(): number {
    const first = this.buf[this.pos];
    let mask = 0x80;
    let length = 1;
    while (!(first & mask)) { mask >>= 1; length++; if (length > 4) throw new Error('element ID too long'); }
    let id = 0;
    for (let i = 0; i < length; i++) {
      id = id * 256 + this.buf[this.pos + i];
    }
    this.pos += length;
    return id;
  }

  readUint(length: number): number {
    let v = 0;
    for (let i = 0; i < length; i++) v = v * 256 + this.buf[this.pos + i];
    this.pos += length;
    return v;
  }

  readInt(length: number): number {
    if (length === 0) return 0;
    const signByte = this.buf[this.pos];
    let v = signByte & 0x7F;
    for (let i = 1; i < length; i++) v = v * 256 + this.buf[this.pos + i];
    this.pos += length;
    if (signByte & 0x80) v -= Math.pow(2, length * 8 - 1);
    return v;
  }

  readFloat(length: number): number {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, length);
    this.pos += length;
    if (length === 4) return view.getFloat32(0, false);
    if (length === 8) return view.getFloat64(0, false);
    if (length === 0) return 0;
    throw new Error(`invalid float length: ${length}`);
  }

  readString(length: number): string {
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + length));
    this.pos += length;
    return s.replace(/\0+$/, '');
  }

  readBytes(length: number): Uint8Array {
    // Return a copy so later reuse of the underlying buffer is safe.
    const v = new Uint8Array(this.buf.subarray(this.pos, this.pos + length));
    this.pos += length;
    return v;
  }

  skip(length: number): void { this.pos += length; }
}

/* ======================================================================
 * MKV element IDs (only the ones we care about)
 * ==================================================================== */

const ID_EBML           = 0x1A45DFA3;
const ID_SEGMENT        = 0x18538067;
const ID_INFO           = 0x1549A966;
const ID_TIMESTAMP_SCALE = 0x2AD7B1;
const ID_DURATION       = 0x4489;
const ID_TRACKS         = 0x1654AE6B;
const ID_TRACK_ENTRY    = 0xAE;
const ID_TRACK_NUMBER   = 0xD7;
const ID_TRACK_TYPE     = 0x83;
const ID_CODEC_ID       = 0x86;
const ID_CODEC_PRIVATE  = 0x63A2;
const ID_DEFAULT_DUR    = 0x23E383;
const ID_VIDEO          = 0xE0;
const ID_PIXEL_WIDTH    = 0xB0;
const ID_PIXEL_HEIGHT   = 0xBA;
const ID_CLUSTER        = 0x1F43B675;
const ID_CLUSTER_TIME   = 0xE7;
const ID_SIMPLE_BLOCK   = 0xA3;
const ID_BLOCK_GROUP    = 0xA0;
const ID_BLOCK          = 0xA1;
const ID_REFERENCE_BLOCK = 0xFB;
const ID_BLOCK_DURATION = 0x9B;

interface MkvVideoTrack {
  number: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  width: number;
  height: number;
  defaultDurationNs?: number;
}

interface MkvParsed {
  timestampScale: number;       // ns per unit (default 1_000_000)
  durationInScale: number;      // in timestampScale units
  video: MkvVideoTrack;
  samples: EncodedSample[];
}

function parseMkv(bytes: Uint8Array): MkvParsed {
  const r = new EbmlReader(bytes);

  // ---- EBML header ----
  if (r.readId() !== ID_EBML) throw new Error('not an EBML file (missing EBML header)');
  const ebmlSize = r.readVint().value;
  r.skip(ebmlSize);

  // ---- Segment ----
  if (r.readId() !== ID_SEGMENT) throw new Error('missing Segment');
  const segSizeVint = r.readVint();
  // Unknown size in streams: the first byte of the VINT would be 0xFF. Use rest of buffer.
  const segSize = segSizeVint.length === 1 && bytes[r.pos - 1] === 0xFF
    ? bytes.length - r.pos
    : segSizeVint.value;
  const segEnd = Math.min(bytes.length, r.pos + segSize);

  let timestampScale = 1_000_000; // 1 ms per unit by default
  let durationInScale = 0;
  const tracks: MkvVideoTrack[] = [];
  let video: MkvVideoTrack | null = null;
  const samples: EncodedSample[] = [];

  while (r.pos < segEnd && !r.eof()) {
    const id = r.readId();
    const sizeVint = r.readVint();
    const size = sizeVint.length === 1 && bytes[r.pos - 1] === 0xFF
      ? segEnd - r.pos   // unknown-size cluster: extends to end of segment
      : sizeVint.value;
    const end = Math.min(segEnd, r.pos + size);

    if (id === ID_INFO) {
      while (r.pos < end) {
        const id2 = r.readId();
        const size2 = r.readVint().value;
        const end2 = r.pos + size2;
        if (id2 === ID_TIMESTAMP_SCALE) timestampScale = r.readUint(size2);
        else if (id2 === ID_DURATION) durationInScale = r.readFloat(size2);
        else r.skip(size2);
        r.pos = end2;
      }
    } else if (id === ID_TRACKS) {
      while (r.pos < end) {
        const id2 = r.readId();
        const size2 = r.readVint().value;
        const end2 = r.pos + size2;
        if (id2 === ID_TRACK_ENTRY) {
          const t = parseTrackEntry(r, end2);
          if (t) tracks.push(t);
        } else {
          r.skip(size2);
        }
        r.pos = end2;
      }
      video = tracks[0] ?? null;
    } else if (id === ID_CLUSTER) {
      if (video) parseCluster(r, end, video, timestampScale, samples);
      else r.skip(size);
    } else {
      r.skip(size);
    }

    r.pos = end;
  }

  if (!video) throw new Error('no video track found in MKV/WebM file');
  return { timestampScale, durationInScale, video, samples };
}

function parseTrackEntry(r: EbmlReader, end: number): MkvVideoTrack | null {
  let number = 0;
  let type = 0;
  let codecId = '';
  let codecPrivate: Uint8Array | null = null;
  let width = 0;
  let height = 0;
  let defaultDurationNs: number | undefined;

  while (r.pos < end) {
    const id = r.readId();
    const size = r.readVint().value;
    const next = r.pos + size;
    switch (id) {
      case ID_TRACK_NUMBER: number = r.readUint(size); break;
      case ID_TRACK_TYPE:   type = r.readUint(size); break;
      case ID_CODEC_ID:     codecId = r.readString(size); break;
      case ID_CODEC_PRIVATE:codecPrivate = r.readBytes(size); break;
      case ID_DEFAULT_DUR:  defaultDurationNs = r.readUint(size); break;
      case ID_VIDEO: {
        while (r.pos < next) {
          const id2 = r.readId();
          const size2 = r.readVint().value;
          const end2 = r.pos + size2;
          if (id2 === ID_PIXEL_WIDTH) width = r.readUint(size2);
          else if (id2 === ID_PIXEL_HEIGHT) height = r.readUint(size2);
          else r.skip(size2);
          r.pos = end2;
        }
        break;
      }
      default: r.skip(size);
    }
    r.pos = next;
  }

  // Type 1 = video
  if (type !== 1) return null;
  return { number, codecId, codecPrivate, width, height, defaultDurationNs };
}

function parseCluster(r: EbmlReader, end: number, video: MkvVideoTrack, tsScale: number, out: EncodedSample[]) {
  let clusterTime = 0;
  while (r.pos < end) {
    const id = r.readId();
    const sizeVint = r.readVint();
    // Unknown size for contained elements — should not happen in practice.
    const size = sizeVint.length === 1 && r.buf[r.pos - 1] === 0xFF ? (end - r.pos) : sizeVint.value;
    const next = r.pos + size;

    if (id === ID_CLUSTER_TIME) {
      clusterTime = r.readUint(size);
    } else if (id === ID_SIMPLE_BLOCK) {
      parseBlock(r, next, clusterTime, tsScale, video, out, /* fromSimpleBlock */ true, /* blockDurationMs */ -1);
    } else if (id === ID_BLOCK_GROUP) {
      parseBlockGroup(r, next, clusterTime, tsScale, video, out);
    } else {
      r.skip(size);
    }
    r.pos = next;
  }
}

function parseBlockGroup(
  r: EbmlReader, end: number, clusterTime: number, tsScale: number,
  video: MkvVideoTrack, out: EncodedSample[]
) {
  // BlockGroup contains one Block. It may also contain BlockDuration and
  // ReferenceBlock. Presence of ReferenceBlock means the Block is NOT a key.
  let blockStart = -1;
  let blockEnd = -1;
  let hasReference = false;
  let durationTs = -1;
  while (r.pos < end) {
    const id = r.readId();
    const size = r.readVint().value;
    const next = r.pos + size;
    if (id === ID_BLOCK) { blockStart = r.pos; blockEnd = next; r.skip(size); }
    else if (id === ID_REFERENCE_BLOCK) { hasReference = true; r.skip(size); }
    else if (id === ID_BLOCK_DURATION) { durationTs = r.readUint(size); }
    else r.skip(size);
    r.pos = next;
  }
  if (blockStart >= 0) {
    const saved = r.pos;
    r.pos = blockStart;
    parseBlock(r, blockEnd, clusterTime, tsScale, video, out, /* fromSimpleBlock */ false, durationTs * tsScale / 1000);
    // Override keyframe flag: Block inside BlockGroup without ReferenceBlock is a keyframe.
    if (!hasReference && out.length > 0) {
      out[out.length - 1].isKey = true;
    }
    r.pos = saved;
  }
}

function parseBlock(
  r: EbmlReader, end: number, clusterTime: number, tsScale: number,
  video: MkvVideoTrack, out: EncodedSample[],
  fromSimpleBlock: boolean, blockDurationUs: number
) {
  // Header: track number (VINT) | int16 BE relative time | 1 byte flags
  const track = r.readVint().value;
  const relTime = r.readInt(2);
  const flags = r.readUint(1);
  const lacing = (flags >> 1) & 0x03;
  if (lacing !== 0) {
    // Skip laced blocks — rare in real-world encoded video.
    r.pos = end;
    return;
  }
  if (track !== video.number) {
    r.pos = end;
    return;
  }
  const data = r.readBytes(end - r.pos);
  const absScaleUnits = clusterTime + relTime;
  // timestamp in microseconds: (units * tsScale_ns) / 1000
  const ts = Math.round((absScaleUnits * tsScale) / 1000);
  const isKey = fromSimpleBlock ? !!(flags & 0x80) : false;
  const dur = blockDurationUs > 0
    ? blockDurationUs
    : (video.defaultDurationNs ? video.defaultDurationNs / 1000 : 0);

  out.push({ data, timestamp: ts, duration: dur, isKey });
}

/* ======================================================================
 * Codec string derivation
 * ==================================================================== */

function toHex2(n: number) { return n.toString(16).padStart(2, '0'); }

function reverse32(n: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) r = (r << 1) | ((n >> i) & 1);
  return r >>> 0;
}

function avcCodecString(codecPrivate: Uint8Array): string {
  // AVCDecoderConfigurationRecord — same layout as MP4 avcC box contents.
  // profile(1) @ byte 1, profile_compat(1) @ byte 2, level(1) @ byte 3
  const profile = codecPrivate[1];
  const compat  = codecPrivate[2];
  const level   = codecPrivate[3];
  return `avc1.${toHex2(profile)}${toHex2(compat)}${toHex2(level)}`;
}

function hevcCodecString(codecPrivate: Uint8Array): string {
  // HEVCDecoderConfigurationRecord (ISO/IEC 14496-15)
  const b0 = codecPrivate[1];
  const space = (b0 >> 6) & 0x03;
  const tier  = (b0 >> 5) & 0x01;
  const profile = b0 & 0x1F;
  const compat32 =
    ((codecPrivate[2] & 0xFF) * 0x1000000) +
    ((codecPrivate[3] & 0xFF) * 0x10000) +
    ((codecPrivate[4] & 0xFF) * 0x100) +
     (codecPrivate[5] & 0xFF);
  const compatHex = reverse32(compat32).toString(16);
  const level = codecPrivate[12];
  const constraint = codecPrivate[6].toString(16).toUpperCase();
  const spacePrefix = space === 0 ? '' : ['', 'A', 'B', 'C'][space];
  const tierChar = tier ? 'H' : 'L';
  return `hev1.${spacePrefix}${profile}.${compatHex}.${tierChar}${level}.${constraint}`;
}

function av1CodecString(codecPrivate: Uint8Array): string {
  // AV1CodecConfigurationRecord
  const b1 = codecPrivate[1];
  const seqProfile = b1 >> 5;
  const seqLevelIdx0 = b1 & 0x1F;
  const b2 = codecPrivate[2];
  const seqTier0 = (b2 >> 7) & 0x01;
  const highBitDepth = (b2 >> 6) & 0x01;
  // Short form; monochrome / subsampling / colourspace fields left at defaults for broad acceptance
  const bitDepth = highBitDepth ? 10 : 8;
  const tierChar = seqTier0 ? 'H' : 'M';
  return `av01.${seqProfile}.${String(seqLevelIdx0).padStart(2, '0')}${tierChar}.${String(bitDepth).padStart(2, '0')}`;
}

function vp9CodecString(codecPrivate: Uint8Array | null): string {
  // VP9CodecConfigurationRecord is the only reliable source; if missing, use a generic string.
  if (!codecPrivate || codecPrivate.length < 4) return 'vp09.00.10.08';
  const profile = codecPrivate[0];
  const level = codecPrivate[1];
  const bitDepth = codecPrivate[2];
  return `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(bitDepth).padStart(2, '0')}`;
}

function configFor(track: MkvVideoTrack): VideoDecoderConfig {
  const cp = track.codecPrivate ?? new Uint8Array();
  const codedWidth = track.width;
  const codedHeight = track.height;

  switch (track.codecId) {
    case 'V_MPEG4/ISO/AVC':
      return { codec: avcCodecString(cp), codedWidth, codedHeight, description: cp };
    case 'V_MPEGH/ISO/HEVC':
      return { codec: hevcCodecString(cp), codedWidth, codedHeight, description: cp };
    case 'V_AV1':
      return { codec: av1CodecString(cp), codedWidth, codedHeight, description: cp };
    case 'V_VP9':
      return { codec: vp9CodecString(cp), codedWidth, codedHeight };
    case 'V_VP8':
      return { codec: 'vp8', codedWidth, codedHeight };
    default:
      throw new Error(`unsupported MKV codec: ${track.codecId}`);
  }
}

/* ======================================================================
 * FrameSource
 * ==================================================================== */

export interface MkvSourceOptions {
  maxDimension?: number;
  decodeQueueTarget?: number;
}

export function isMkvLikeFile(file: File | Blob): boolean {
  if (file instanceof File) {
    if (/\.(mkv|webm|mka)$/i.test(file.name)) return true;
    if (file.type && /(matroska|webm)/i.test(file.type)) return true;
    return false;
  }
  return !!file.type && /(matroska|webm)/i.test(file.type);
}

export class MkvSource implements FrameSource {
  private file: File | Blob;
  private options: MkvSourceOptions;
  private metadata: VideoMetadata | null = null;
  private parsed: MkvParsed | null = null;

  constructor(file: File | Blob, options: MkvSourceOptions = {}) {
    this.file = file;
    this.options = options;
  }

  async getMetadata(): Promise<VideoMetadata> {
    if (this.metadata) return this.metadata;
    await this.load();
    const { video, durationInScale, timestampScale, samples } = this.parsed!;
    const durationSec = (durationInScale * timestampScale) / 1e9;

    // FPS: prefer DefaultDuration, else fall back to sample-count / duration.
    const fps = video.defaultDurationNs && video.defaultDurationNs > 0
      ? 1e9 / video.defaultDurationNs
      : (samples.length > 0 && durationSec > 0 ? samples.length / durationSec : 30);

    const target = this.targetResolution(video.width, video.height);
    this.metadata = {
      totalFrames: samples.length,
      duration: durationSec,
      fps,
      resolution: target,
      codec: video.codecId
    };
    return this.metadata;
  }

  async extractFrames(
    onFrame: (frame: RawFrame) => Promise<void> | void,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const meta = await this.getMetadata();
    const { video, samples } = this.parsed!;
    // WebCodecs handles B-frame reordering internally when fed DTS-ordered
    // samples, which is exactly what MKV blocks give us.
    const config = configFor(video);

    await runDecodePipeline(
      {
        config,
        samples,
        metadata: meta,
        nativeWidth: video.width,
        nativeHeight: video.height,
        decodeQueueTarget: this.options.decodeQueueTarget
      },
      onFrame,
      onProgress,
      signal
    );
  }

  destroy(): void {
    this.parsed = null;
    this.metadata = null;
  }

  private async load(): Promise<void> {
    if (this.parsed) return;
    // Matroska commonly places Cues at the end and requires random access. For
    // simplicity we buffer the whole file and parse synchronously. Typical
    // anime episode MKVs are <1 GB; well within browser memory.
    const ab = await this.file.arrayBuffer();
    this.parsed = parseMkv(new Uint8Array(ab));
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
