/**
 * Result exporters — shared by the Node CLI and the browser app.
 *
 * Every function takes a DetectionResult (and in some cases the input
 * filename) and returns a serialized string ready to write to disk / blob.
 */

import type { DetectionResult } from './types';
import { formatTimecode } from './frame-processor';

const p2 = (n: number) => n.toString().padStart(2, '0');

/** Seconds → SMPTE-like non-drop timecode (HH:MM:SS:FF). */
export function secondsToSmpte(seconds: number, fps: number): string {
  const fpsInt = Math.max(1, Math.round(fps));
  const totalFrames = Math.max(0, Math.round(seconds * fpsInt));
  const ff = totalFrames % fpsInt;
  const totalSec = Math.floor(totalFrames / fpsInt);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(ff)}`;
}

export function formatJson(r: DetectionResult): string {
  return JSON.stringify(r, null, 2);
}

export function formatCsv(r: DetectionResult): string {
  const header = 'frame,timestamp,timecode,confidence,duration,frameCount\n';
  const rows = r.scenes.map(s => [
    s.frameNumber,
    s.timestamp,
    s.timecode ?? '',
    s.confidence?.toFixed(4) ?? '',
    s.duration?.toFixed(3) ?? '',
    s.frameCount ?? ''
  ].join(',')).join('\n');
  return header + rows + '\n';
}

export function formatAegisub(r: DetectionResult): string {
  return `# keyframe format v1\nfps ${r.metadata.fps}\n`
    + r.scenes.map(s => s.frameNumber).join('\n') + '\n';
}

export function formatTimecodeList(r: DetectionResult): string {
  return r.scenes.map(s => s.timecode ?? formatTimecode(s.timestamp)).join('\n') + '\n';
}

/** CMX3600 EDL — Premiere, Resolve, Avid, almost every NLE. */
export function formatEdl(r: DetectionResult, title: string): string {
  const fps = r.metadata.fps;
  const totalDur = r.metadata.duration;
  const lines: string[] = [];
  lines.push(`TITLE: ${title.slice(0, 70).toUpperCase()}`);
  lines.push('FCM: NON-DROP FRAME');
  lines.push('');
  for (let i = 0; i < r.scenes.length; i++) {
    const scene = r.scenes[i];
    const next = r.scenes[i + 1];
    const startTc = secondsToSmpte(scene.timestamp, fps);
    const endTc = secondsToSmpte(next ? next.timestamp : totalDur, fps);
    const num = String(i + 1).padStart(3, '0');
    lines.push(`${num}  AX       V     C        ${startTc} ${endTc} ${startTc} ${endTc}`);
    lines.push(`* FROM CLIP NAME: scene_${num}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Premiere Pro "Import Markers" CSV. */
export function formatPremiereMarkers(r: DetectionResult): string {
  const fps = r.metadata.fps;
  const rows = ['Marker Name,Description,In,Out,Duration,Marker Type'];
  for (let i = 0; i < r.scenes.length; i++) {
    const scene = r.scenes[i];
    const tc = secondsToSmpte(scene.timestamp, fps);
    const conf = scene.confidence != null ? `conf ${(scene.confidence * 100).toFixed(0)}%` : '';
    rows.push(`Scene ${i + 1},"${conf}",${tc},${tc},00:00:00:00,Comment`);
  }
  return rows.join('\n') + '\n';
}

/** fps → canonical FCPXML `frameDuration` num/den pair (seconds per frame). */
export function frameDurationNumDen(fps: number): [number, number] {
  const rounded = Math.round(fps * 1000) / 1000;
  if (Math.abs(rounded - 23.976) < 0.01) return [1001, 24000];
  if (Math.abs(rounded - 24) < 0.001)    return [100, 2400];
  if (Math.abs(rounded - 25) < 0.001)    return [100, 2500];
  if (Math.abs(rounded - 29.97) < 0.01)  return [1001, 30000];
  if (Math.abs(rounded - 30) < 0.001)    return [100, 3000];
  if (Math.abs(rounded - 50) < 0.001)    return [100, 5000];
  if (Math.abs(rounded - 59.94) < 0.01)  return [1001, 60000];
  if (Math.abs(rounded - 60) < 0.001)    return [100, 6000];
  return [1000, Math.max(1000, Math.round(fps * 1000))];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rationalSnap(seconds: number, num: number, den: number): string {
  const frames = Math.max(0, Math.round(seconds * (den / num)));
  return `${frames * num}/${den}s`;
}

/** Final Cut Pro X XML with markers on the clip. */
export function formatFcpxml(r: DetectionResult, inputFilename: string): string {
  const fps = r.metadata.fps;
  const w = r.metadata.resolution.width;
  const h = r.metadata.resolution.height;
  const [num, den] = frameDurationNumDen(fps);
  const frameDur = `${num}/${den}s`;
  const totalDur = rationalSnap(r.metadata.duration, num, den);
  const name = escapeXml(inputFilename);
  const markers = r.scenes.map((s, i) => {
    const start = rationalSnap(s.timestamp, num, den);
    const conf = s.confidence != null ? ` (${(s.confidence * 100).toFixed(0)}%)` : '';
    return `                    <marker start="${start}" duration="${frameDur}" value="Scene ${i + 1}${escapeXml(conf)}"/>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
    <resources>
        <format id="r1" frameDuration="${frameDur}" width="${w}" height="${h}"/>
        <asset id="r2" name="${name}" start="0s" duration="${totalDur}" format="r1" hasVideo="1" videoSources="1">
            <media-rep kind="original-media" src="file://./${name}"/>
        </asset>
    </resources>
    <library>
        <event name="Scenecut">
            <project name="${name} scenes">
                <sequence format="r1" duration="${totalDur}" tcStart="0s" tcFormat="NDF">
                    <spine>
                        <asset-clip ref="r2" offset="0s" duration="${totalDur}" start="0s" name="${name}">
${markers}
                        </asset-clip>
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
`;
}
