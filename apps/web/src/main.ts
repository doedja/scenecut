import './style.css';
import {
  detectSceneChanges,
  createWebWasmFactory,
  createWebMotionPool,
  formatTimecode,
  formatJson,
  formatCsv,
  formatAegisub,
  formatTimecodeList,
  formatEdl,
  formatFcpxml,
  formatPremiereMarkers,
  type DetectionResult,
  type SceneInfo,
  type Progress,
  type MotionWorkerPool
} from '@doedja/scenecut-web';

/* ==================================================================
 * Asset URLs (WASM glue + binary). Vite serves from /wasm/ in public.
 * ================================================================ */

const wasmBase = new URL(`${import.meta.env.BASE_URL}wasm/`, window.location.href).href;
const glueUrl = `${wasmBase}detection.wasm.js`;
const wasmUrl = `${wasmBase}detection.wasm`;
const wasmFactory = createWebWasmFactory({ glueUrl, wasmUrl });

async function wasmAvailable(): Promise<boolean> {
  try {
    const r = await fetch(glueUrl, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

let pool: MotionWorkerPool | null = null;
function getPool(): MotionWorkerPool {
  if (!pool) {
    pool = createWebMotionPool({
      glueUrl, wasmUrl,
      createWorker: () => new Worker(new URL('./motion-worker.ts', import.meta.url), { type: 'module' })
    });
  }
  return pool;
}

/* ==================================================================
 * Types and state
 * ================================================================ */

type Sensitivity = 'low' | 'medium' | 'high';
type Status = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

interface QueueItem {
  id: string;
  file: File;
  status: Status;
  progress: Progress | null;
  result: DetectionResult | null;
  scenes: SceneInfo[];             // accumulated during `running` for the table
  error: string | null;
  abort: AbortController | null;
  startTime: number;
  finishTime: number;
  // Settings snapshot at the time detection starts; stays valid for the run.
  settingsSnapshot?: { sensitivity: Sensitivity; maxDim: number };
}

interface AppState {
  queue: QueueItem[];
  selectedId: string | null;
  settings: { sensitivity: Sensitivity; maxDim: number };
  preview: { objectUrl: string | null; loadedForId: string | null };
}

const state: AppState = {
  queue: [],
  selectedId: null,
  settings: { sensitivity: 'medium', maxDim: 0 },
  preview: { objectUrl: null, loadedForId: null }
};

function isRunning(): boolean {
  return state.queue.some(i => i.status === 'running');
}

/* ==================================================================
 * DOM references
 * ================================================================ */

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
};

const emptyState  = $<HTMLElement>('#empty-state');
const activeState = $<HTMLElement>('#active-state');

const dropzone  = $<HTMLElement>('#dropzone');
const fileInput = $<HTMLInputElement>('#file-input');
const browseBtn = $<HTMLButtonElement>('#browse-btn');
const dropOverlay = $<HTMLElement>('#drop-overlay');

const queueCount = $<HTMLElement>('#queue-count');
const queueList  = $<HTMLUListElement>('#queue-list');
const addMoreBtn = $<HTMLButtonElement>('#add-more-btn');
const clearDoneBtn = $<HTMLButtonElement>('#clear-done-btn');
const clearAllBtn  = $<HTMLButtonElement>('#clear-all-btn');

const preview      = $<HTMLElement>('#preview');
const video        = $<HTMLVideoElement>('#video');
const metaName     = $<HTMLElement>('#meta-name');
const metaSize     = $<HTMLElement>('#meta-size');
const metaRes      = $<HTMLElement>('#meta-res');
const metaDur      = $<HTMLElement>('#meta-dur');

const detectBtn = $<HTMLButtonElement>('#detect-btn');
const cancelBtn = $<HTMLButtonElement>('#cancel-btn');

const resultsEl    = $<HTMLElement>('#results');
const resultsFile  = $<HTMLElement>('#results-file');
const sceneTbody   = $<HTMLTableSectionElement>('#scene-tbody');
const resultsEmpty = $<HTMLElement>('#results-empty');

const toast = $<HTMLElement>('#toast');

/* ==================================================================
 * Settings (segmented radios) — apply to future queue items
 * ================================================================ */

function bindSegmented(group: string, onChange: (value: string) => void) {
  const container = document.querySelector(`.segmented[data-group="${group}"]`);
  if (!container) return;
  const segs = Array.from(container.querySelectorAll<HTMLButtonElement>('.seg'));
  for (const seg of segs) {
    seg.addEventListener('click', () => {
      for (const s of segs) {
        s.classList.remove('is-active');
        s.setAttribute('aria-checked', 'false');
      }
      seg.classList.add('is-active');
      seg.setAttribute('aria-checked', 'true');
      onChange(seg.dataset.value ?? '');
    });
  }
}

bindSegmented('sensitivity', v => { state.settings.sensitivity = v as Sensitivity; });
bindSegmented('maxDim',      v => { state.settings.maxDim = Number(v) || 0; });

/* ==================================================================
 * File input + drop handling
 * ================================================================ */

function isVideoFile(f: File): boolean {
  if (f.type.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|webm|mkv|mka|avi|3gp|3g2|ogv|ogg)$/i.test(f.name);
}

function filesFromEvent(e: DragEvent): File[] {
  const list = e.dataTransfer?.files;
  if (!list) return [];
  return Array.from(list).filter(isVideoFile);
}

function openPicker() { fileInput.click(); }

browseBtn.addEventListener('click', e => { e.stopPropagation(); openPicker(); });
addMoreBtn.addEventListener('click', openPicker);
fileInput.addEventListener('change', () => {
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  const videos = files.filter(isVideoFile);
  if (videos.length > 0) addFiles(videos);
  fileInput.value = '';
});

// Dropzone specifically (empty state)
function bindDropzone(target: HTMLElement, onFiles: (files: File[]) => void) {
  target.addEventListener('click', openPicker);
  target.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });
  target.addEventListener('dragover', e => {
    e.preventDefault();
    target.classList.add('is-over');
  });
  target.addEventListener('dragleave', () => target.classList.remove('is-over'));
  target.addEventListener('drop', e => {
    e.preventDefault();
    target.classList.remove('is-over');
    const files = filesFromEvent(e);
    if (files.length > 0) onFiles(files);
  });
}

bindDropzone(dropzone, addFiles);

// Global drop overlay — drop anywhere on the page
let dragDepth = 0;
document.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  dropOverlay.classList.add('is-visible');
  dropOverlay.hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropOverlay.classList.remove('is-visible');
    setTimeout(() => { if (dragDepth === 0) dropOverlay.hidden = true; }, 160);
  }
});
document.addEventListener('dragover', e => {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', e => {
  dragDepth = 0;
  dropOverlay.classList.remove('is-visible');
  dropOverlay.hidden = true;
  if (!e.dataTransfer?.files?.length) return;
  const files = Array.from(e.dataTransfer.files).filter(isVideoFile);
  if (files.length === 0) { notify('no video files dropped', 'error'); return; }
  e.preventDefault();
  addFiles(files);
});

/* ==================================================================
 * Queue management
 * ================================================================ */

function addFiles(files: File[]) {
  for (const f of files) {
    const item: QueueItem = {
      id: newId(),
      file: f,
      status: 'pending',
      progress: null,
      result: null,
      scenes: [],
      error: null,
      abort: null,
      startTime: 0,
      finishTime: 0
    };
    state.queue.push(item);
  }
  if (state.queue.length > 0 && emptyState.hidden === false) {
    emptyState.hidden = true;
    activeState.hidden = false;
  }
  // If nothing is selected, select the first new item.
  if (!state.selectedId && state.queue.length > 0) {
    selectItem(state.queue[0].id);
  }
  renderQueue();
  updateDetectButton();
  notify(`${files.length} file${files.length === 1 ? '' : 's'} queued`);
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function removeItem(id: string) {
  const item = state.queue.find(i => i.id === id);
  if (!item) return;
  if (item.status === 'running') return; // guarded in UI too
  state.queue = state.queue.filter(i => i.id !== id);
  if (state.selectedId === id) {
    state.selectedId = state.queue[0]?.id ?? null;
    updatePreview();
    updateResults();
  }
  renderQueue();
  updateDetectButton();
  if (state.queue.length === 0) {
    emptyState.hidden = false;
    activeState.hidden = true;
    resultsEl.hidden = true;
  }
}

clearDoneBtn.addEventListener('click', () => {
  const kept: QueueItem[] = [];
  for (const item of state.queue) {
    if (item.status === 'done' || item.status === 'cancelled' || item.status === 'error') continue;
    kept.push(item);
  }
  state.queue = kept;
  if (state.selectedId && !state.queue.find(i => i.id === state.selectedId)) {
    state.selectedId = state.queue[0]?.id ?? null;
    updatePreview();
    updateResults();
  }
  renderQueue();
  updateDetectButton();
  if (state.queue.length === 0) {
    emptyState.hidden = false;
    activeState.hidden = true;
    resultsEl.hidden = true;
  }
});

clearAllBtn.addEventListener('click', () => {
  for (const item of state.queue) item.abort?.abort();
  state.queue = [];
  state.selectedId = null;
  renderQueue();
  updateDetectButton();
  emptyState.hidden = false;
  activeState.hidden = true;
  resultsEl.hidden = true;
  if (state.preview.objectUrl) URL.revokeObjectURL(state.preview.objectUrl);
  state.preview = { objectUrl: null, loadedForId: null };
  updatePreview();
});

function selectItem(id: string) {
  state.selectedId = id;
  renderQueue();
  updatePreview();
  updateResults();
}

function updatePreview() {
  const item = currentSelected();
  if (!item) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;

  if (state.preview.loadedForId !== item.id) {
    if (state.preview.objectUrl) URL.revokeObjectURL(state.preview.objectUrl);
    state.preview.objectUrl = URL.createObjectURL(item.file);
    state.preview.loadedForId = item.id;
    video.src = state.preview.objectUrl;
    video.load();

    metaName.textContent = truncateMid(item.file.name, 40);
    metaName.title = item.file.name;
    metaSize.textContent = formatBytes(item.file.size);
    metaRes.textContent = '—';
    metaDur.textContent = '—';

    video.addEventListener('loadedmetadata', () => {
      metaRes.textContent = `${video.videoWidth}×${video.videoHeight}`;
      metaDur.textContent = formatDuration(video.duration);
    }, { once: true });
  }
}

function updateResults() {
  const item = currentSelected();
  if (!item || item.status === 'pending') { resultsEl.hidden = true; return; }

  resultsEl.hidden = false;
  resultsFile.textContent = item.file.name;

  sceneTbody.innerHTML = '';
  if (item.scenes.length === 0) {
    resultsEmpty.hidden = false;
    return;
  }
  resultsEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < item.scenes.length; i++) {
    frag.appendChild(buildSceneRow(item.scenes[i], i + 1));
  }
  sceneTbody.appendChild(frag);
}

function currentSelected(): QueueItem | null {
  return state.queue.find(i => i.id === state.selectedId) ?? null;
}

/* ==================================================================
 * Queue rendering (DOM diff-lite — full re-render, keeps it simple)
 * ================================================================ */

function renderQueue() {
  queueCount.textContent = String(state.queue.length);
  queueList.innerHTML = '';

  const frag = document.createDocumentFragment();
  state.queue.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.dataset.id = item.id;
    li.dataset.status = item.status;
    if (state.selectedId === item.id) li.classList.add('is-selected');

    li.innerHTML = `
      <span class="qi-dot" aria-hidden="true"></span>
      <span class="qi-num">${String(idx + 1).padStart(3, '0')}</span>
      <span class="qi-name" title="${escapeAttr(item.file.name)}">${escapeAttr(truncateMid(item.file.name, 60))}</span>
      <span class="qi-bar"><span class="qi-fill"></span></span>
      <span class="qi-stat"></span>
      <button type="button" class="qi-remove" title="remove" aria-label="remove">×</button>
    `;

    const fill = li.querySelector<HTMLElement>('.qi-fill')!;
    const stat = li.querySelector<HTMLElement>('.qi-stat')!;

    if (item.status === 'pending') {
      stat.textContent = `pending · ${formatBytes(item.file.size)}`;
      fill.style.width = '0%';
    } else if (item.status === 'running') {
      const pct = item.progress?.percent ?? 0;
      const fps = item.progress?.fps ?? 0;
      const eta = item.progress?.eta ?? null;
      const cuts = item.progress?.scenesDetected ?? item.scenes.length;
      fill.style.width = `${pct}%`;
      const etaStr = eta != null && isFinite(eta) ? `eta ${formatDuration(eta)}` : 'eta —';
      stat.textContent = `${pct}% · ${fps.toFixed(0)} fps · ${etaStr} · ${cuts} cuts`;
    } else if (item.status === 'done') {
      fill.style.width = '100%';
      const time = item.result?.stats
        ? formatDuration(item.result.stats.processingTime)
        : '—';
      stat.innerHTML = `<span class="accent">done</span> · ${item.scenes.length} cuts · ${time}`;
    } else if (item.status === 'error') {
      stat.textContent = item.error ?? 'error';
      fill.style.width = '100%';
    } else {
      stat.textContent = 'cancelled';
      fill.style.width = '0%';
    }

    li.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('qi-remove')) return;
      selectItem(item.id);
    });
    li.querySelector<HTMLButtonElement>('.qi-remove')!.addEventListener('click', e => {
      e.stopPropagation();
      removeItem(item.id);
    });

    frag.appendChild(li);
  });
  queueList.appendChild(frag);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ==================================================================
 * Detection
 * ================================================================ */

detectBtn.addEventListener('click', () => { void runQueue(); });
cancelBtn.addEventListener('click', () => {
  // Cancel the currently running item; remaining pending items stay pending.
  for (const item of state.queue) {
    if (item.status === 'running') item.abort?.abort();
  }
});

async function runQueue() {
  if (isRunning()) return;
  const pending = state.queue.filter(i => i.status === 'pending');
  if (pending.length === 0) {
    notify('nothing to detect', 'error');
    return;
  }
  if (!(await wasmAvailable())) {
    notify('WASM not built — run `bun run build:core:wasm` (needs emscripten)', 'error');
    return;
  }
  updateDetectButton();

  try {
    for (const item of state.queue) {
      if (item.status !== 'pending') continue;
      await detectOne(item);
    }
  } finally {
    updateDetectButton();
  }
}

async function detectOne(item: QueueItem) {
  item.status = 'running';
  item.abort = new AbortController();
  item.scenes = [];
  item.result = null;
  item.error = null;
  item.startTime = Date.now();
  item.settingsSnapshot = { ...state.settings };

  renderQueue();
  if (state.selectedId === item.id) updateResults();

  try {
    const result = await detectSceneChanges(item.file, {
      wasmFactory,
      pool: getPool(),
      sensitivity: item.settingsSnapshot.sensitivity,
      maxDimension: item.settingsSnapshot.maxDim > 0 ? item.settingsSnapshot.maxDim : undefined,
      signal: item.abort.signal,
      onProgress: (p) => {
        item.progress = p;
        paintQueueItem(item);
      },
      onScene: (s) => {
        item.scenes.push(s);
        if (state.selectedId === item.id) appendSceneRowLive(s, item.scenes.length);
      }
    });
    item.result = result;
    item.status = 'done';
    item.finishTime = Date.now();
    notify(`${item.file.name} · ${result.scenes.length} scenes`);
  } catch (err) {
    const e = err as { message?: string; name?: string };
    const wasAborted = e?.message === 'Detection aborted'
      || e?.name === 'AbortError'
      || (item.abort?.signal.aborted && !e?.message);
    if (wasAborted) {
      item.status = 'cancelled';
      item.error = 'cancelled';
    } else {
      item.status = 'error';
      item.error = e?.message || 'detection failed';
      console.error(err);
      notify(`${item.file.name}: ${item.error}`, 'error');
    }
  } finally {
    item.abort = null;
    renderQueue();
    if (state.selectedId === item.id) updateResults();
  }
}

function paintQueueItem(item: QueueItem) {
  const li = queueList.querySelector<HTMLElement>(`[data-id="${item.id}"]`);
  if (!li) return;
  li.dataset.status = item.status;
  const fill = li.querySelector<HTMLElement>('.qi-fill')!;
  const stat = li.querySelector<HTMLElement>('.qi-stat')!;
  if (item.status === 'running') {
    const pct = item.progress?.percent ?? 0;
    const fps = item.progress?.fps ?? 0;
    const eta = item.progress?.eta ?? null;
    const cuts = item.progress?.scenesDetected ?? item.scenes.length;
    fill.style.width = `${pct}%`;
    const etaStr = eta != null && isFinite(eta) ? `eta ${formatDuration(eta)}` : 'eta —';
    stat.textContent = `${pct}% · ${fps.toFixed(0)} fps · ${etaStr} · ${cuts} cuts`;
  }
}

function appendSceneRowLive(s: SceneInfo, index: number) {
  resultsEmpty.hidden = true;
  sceneTbody.appendChild(buildSceneRow(s, index));
}

function buildSceneRow(s: SceneInfo, index: number): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset.frame = String(s.frameNumber);
  tr.dataset.time = String(s.timestamp);
  tr.innerHTML = `
    <td class="col-num">${String(index).padStart(3, '0')}</td>
    <td class="col-frame">${s.frameNumber}</td>
    <td class="col-time">${s.timecode ?? formatTimecode(s.timestamp)}</td>
    <td class="col-dur">${s.duration != null ? formatDuration(s.duration) : '—'}</td>
  `;
  tr.addEventListener('click', () => seekTo(s, tr));
  return tr;
}

function seekTo(scene: SceneInfo, row: HTMLTableRowElement) {
  if (!state.preview.objectUrl) return;
  video.currentTime = scene.timestamp;
  sceneTbody.querySelectorAll<HTMLElement>('tr.is-current').forEach(r => r.classList.remove('is-current'));
  row.classList.add('is-current');
  video.pause();
}

function updateDetectButton() {
  const pendingCount = state.queue.filter(i => i.status === 'pending').length;
  const running = isRunning();
  detectBtn.disabled = pendingCount === 0 || running;
  const label = detectBtn.querySelector<HTMLElement>('.btn-label');
  if (label) {
    if (running) label.textContent = 'running…';
    else if (pendingCount === 0) label.textContent = 'detect queue';
    else if (pendingCount === 1) label.textContent = 'detect 1 file';
    else label.textContent = `detect ${pendingCount} files`;
  }
  cancelBtn.hidden = !running;
}

/* ==================================================================
 * Export
 * ================================================================ */

type ExportFormat = 'json' | 'csv' | 'aegisub' | 'timecode' | 'edl' | 'fcpxml' | 'premiere';

const exportNav = document.querySelector('.export')!;
exportNav.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  if (target.tagName !== 'BUTTON') return;
  const fmt = target.dataset.export as ExportFormat | undefined;
  if (!fmt) return;
  const item = currentSelected();
  if (!item?.result || item.result.scenes.length === 0) {
    notify('nothing to export yet', 'error');
    return;
  }
  exportAs(fmt, item);
});

function exportAs(fmt: ExportFormat, item: QueueItem) {
  const r = item.result!;
  const base = item.file.name.replace(/\.[^/.]+$/, '') || 'scenes';
  let content: string;
  let filename: string;
  let mime: string;

  switch (fmt) {
    case 'json':
      content = formatJson(r);
      filename = `${base}.scenes.json`;
      mime = 'application/json';
      break;
    case 'csv':
      content = formatCsv(r);
      filename = `${base}.scenes.csv`;
      mime = 'text/csv';
      break;
    case 'aegisub':
      content = formatAegisub(r);
      filename = `${base}.keyframes.txt`;
      mime = 'text/plain';
      break;
    case 'timecode':
      content = formatTimecodeList(r);
      filename = `${base}.timecodes.txt`;
      mime = 'text/plain';
      break;
    case 'edl':
      content = formatEdl(r, base);
      filename = `${base}.edl`;
      mime = 'text/plain';
      break;
    case 'fcpxml':
      content = formatFcpxml(r, item.file.name);
      filename = `${base}.fcpxml`;
      mime = 'application/xml';
      break;
    case 'premiere':
      content = formatPremiereMarkers(r);
      filename = `${base}.markers.csv`;
      mime = 'text/csv';
      break;
  }

  downloadBlob(new Blob([content], { type: mime }), filename);
  notify(`exported ${filename}`);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ==================================================================
 * Toast
 * ================================================================ */

let toastTimer: number | null = null;
function notify(msg: string, kind: 'info' | 'error' = 'info') {
  toast.textContent = msg;
  toast.classList.toggle('is-error', kind === 'error');
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, kind === 'error' ? 4500 : 2800);
}

/* ==================================================================
 * Formatting helpers
 * ================================================================ */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  if (m > 0) return `${m}m ${r}s`;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${r}s`;
}

function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 3) / 2);
  return s.slice(0, half) + '…' + s.slice(s.length - half);
}

/* ==================================================================
 * Smooth anchor scrolling
 * ================================================================ */

document.querySelectorAll<HTMLAnchorElement>('[data-scroll]').forEach(a => {
  a.addEventListener('click', e => {
    const id = a.getAttribute('href')?.replace('#', '');
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
