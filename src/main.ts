import './styles.css';
import { Engine } from './engine';
import { History } from './history';
import { FACTORY_PRESETS, randomState, variantOf } from './presets';
import { cloneState, defaultState, findPair, parsePresetFile, sanitizeState, toPresetFile, type GlitchState } from './model';
import { freshSeed } from './prng';
import { Knob } from './ui/knob';
import { CABLE_COLORS, RewirePanel } from './ui/rewire';
import { StagesPanel } from './ui/stages';
import { makeSampleImage } from './sample';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE_KEY = 'glitch-editor:state:v1';

/* ------------------------------ state ------------------------------ */
let state: GlitchState = loadStored() ?? defaultState();
const history = new History();
let editBefore: GlitchState | null = null;

function loadStored(): GlitchState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? sanitizeState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
let storeTimer = 0;
function store(): void {
  clearTimeout(storeTimer);
  storeTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: ignore */
    }
  }, 300);
}

/**
 * All state mutations go through here.
 *  live: during a drag (render only)   end: drag finished (commit to history)
 *  once: discrete action (commit + full UI sync)
 */
function edit(fn: (s: GlitchState) => void, phase: 'live' | 'end' | 'once'): void {
  if (phase === 'once') {
    const before = cloneState(state);
    fn(state);
    if (JSON.stringify(before) !== JSON.stringify(state)) history.push(before);
    afterChange(true);
    return;
  }
  if (phase === 'live') {
    if (!editBefore) editBefore = cloneState(state);
    fn(state);
    afterChange(false);
    return;
  }
  fn(state);
  if (editBefore && JSON.stringify(editBefore) !== JSON.stringify(state)) history.push(editBefore);
  editBefore = null;
  afterChange(true);
}

function replaceState(next: GlitchState, record = true): void {
  if (record) history.push(cloneState(state));
  state = sanitizeState(next);
  afterChange(true);
}

/* ------------------------------ engine & screen ------------------------------ */
let engine: Engine;
try {
  engine = new Engine();
} catch (err) {
  document.body.innerHTML = `<div class="fatal"><h1>Este navegador no tiene WebGL2</h1><p>${(err as Error).message}</p><p>Prueba con una versión reciente de Chrome, Edge, Firefox o Safari.</p></div>`;
  throw err;
}
const screen = $<HTMLCanvasElement>('screen');
const ctx = screen.getContext('2d', { willReadFrequently: false })!;
engine.onBusy = (b) => $('busy').classList.toggle('on', b);

let showOriginal = false;
let frame = 0;
function requestRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!engine.hasImage) return;
    if (showOriginal) engine.drawOriginal(ctx);
    else engine.renderPreview(state, ctx);
  });
}

/* ------------------------------ UI components ------------------------------ */
const toastEl = $('toast');
let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

const effectKnob = new Knob({
  label: 'EFFECT', min: 0, max: 100, def: 50, value: state.effect, size: 'lg',
  info: 'Intensidad global de todos los puentes.',
  onInput: (v) => edit((s) => { s.effect = v; }, 'live'),
  onChange: () => edit(() => {}, 'end'),
});
const filterKnob = new Knob({
  label: 'FILTER', min: 0, max: 100, def: 50, value: state.filter, size: 'lg',
  info: 'Carácter del glitch: su efecto depende de cada par de pines (ver Recablear).',
  onInput: (v) => edit((s) => { s.filter = v; }, 'live'),
  onChange: () => edit(() => {}, 'end'),
});
$('knob-effect').append(effectKnob.el);
$('knob-filter').append(filterKnob.el);

const host = { state: () => state, edit, toast };
const rewire = new RewirePanel(host);
document.body.append(rewire.el);
const stages = new StagesPanel(host);
$('stages').append(stages.el);

const presetSelect = $<HTMLSelectElement>('preset-select');
presetSelect.innerHTML = `<option value="">Presets de fábrica…</option>` + FACTORY_PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
presetSelect.addEventListener('change', () => {
  const i = Number(presetSelect.value);
  if (presetSelect.value !== '' && FACTORY_PRESETS[i]) {
    replaceState(cloneState(FACTORY_PRESETS[i].state));
    toast(`Preset: ${FACTORY_PRESETS[i].name}`);
  }
  presetSelect.value = '';
});

const seedInput = $<HTMLInputElement>('seed');
seedInput.addEventListener('change', () => {
  const v = Math.max(0, Math.min(999999, Math.round(Number(seedInput.value) || 0)));
  edit((s) => { s.seed = v; }, 'once');
});
$('btn-dice').addEventListener('click', () => edit((s) => { s.seed = freshSeed(); }, 'once'));

/** Push state into every widget. `full` = also rebuild things that would break a drag. */
function afterChange(full: boolean): void {
  requestRender();
  store();
  stages.syncLeds();
  updatePair();
  if (!full) return;
  effectKnob.set(state.effect);
  filterKnob.set(state.filter);
  seedInput.value = String(state.seed);
  stages.sync();
  if (rewire.isOpen) rewire.sync();
  ($('btn-undo') as HTMLButtonElement).disabled = !history.canUndo;
  ($('btn-redo') as HTMLButtonElement).disabled = !history.canRedo;
}

function updatePair(): void {
  const label = $('pair-label');
  const name = $('pair-name');
  if (!state.cables.length) {
    label.innerHTML = '<span class="pair-off">SIN PUENTE</span>';
    name.textContent = 'toca para recablear';
    return;
  }
  label.innerHTML = state.cables
    .map((c, i) => `<span style="color:${CABLE_COLORS[i % CABLE_COLORS.length]}">${findPair(c.a, c.b)!.a}+${findPair(c.a, c.b)!.b}</span>`)
    .join('<i>·</i>');
  name.textContent = state.cables.length === 1 ? findPair(state.cables[0].a, state.cables[0].b)!.name : `${state.cables.length} cables`;
}

/* ------------------------------ import ------------------------------ */
async function importBlob(blob: Blob, name = 'imagen'): Promise<void> {
  if (!blob.type.startsWith('image/')) {
    toast('Eso no es una imagen');
    return;
  }
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    await setImage(bmp);
    toast(`${name} · ${engine.original!.width}×${engine.original!.height}`);
  } catch {
    toast('No se pudo leer la imagen (¿formato no soportado?)');
  }
}

async function setImage(bmp: ImageBitmap): Promise<void> {
  await engine.setImage(bmp);
  document.body.classList.add('has-image');
  $('empty').hidden = true;
  if (engine.downscaledFrom) {
    const [w, h] = engine.downscaledFrom;
    toast(`Imagen reducida de ${w}×${h} a ${engine.original!.width}×${engine.original!.height} (límite de la GPU)`);
  }
  requestRender();
}

const fileInput = $<HTMLInputElement>('file');
const pickFile = () => fileInput.click();
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void importBlob(f, f.name);
  fileInput.value = '';
});
$('btn-import').addEventListener('click', pickFile);
$('btn-empty').addEventListener('click', pickFile);
$('btn-sample').addEventListener('click', async () => {
  await setImage(await makeSampleImage());
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) void importBlob(f, f.name);
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const f = item?.getAsFile();
  if (f) void importBlob(f, 'imagen pegada');
});

/* ------------------------------ capture & gallery ------------------------------ */
interface Shot {
  state: GlitchState;
  thumb: string;
}
const shots: Shot[] = [];
const GALLERY = 6;

function renderGallery(): void {
  const g = $('gallery');
  g.innerHTML = '';
  for (let i = 0; i < GALLERY; i++) {
    const s = shots[i];
    const slot = document.createElement('div');
    slot.className = 'shot' + (s ? ' filled' : '');
    if (s) {
      slot.innerHTML = `
        <button class="shot-img" data-load="${i}" aria-label="Recuperar captura ${i + 1}" title="Recuperar estos ajustes"><img src="${s.thumb}" alt=""></button>
        <button class="shot-dl" data-dl="${i}" aria-label="Descargar captura ${i + 1} a resolución completa" title="Descargar PNG a resolución completa">
          <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg></button>`;
    }
    g.append(slot);
  }
}
$('gallery').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const load = t.closest('[data-load]');
  const dl = t.closest('[data-dl]');
  if (dl) void exportImage('image/png', shots[Number(dl.getAttribute('data-dl'))].state);
  else if (load) {
    replaceState(cloneState(shots[Number(load.getAttribute('data-load'))].state));
    toast('Ajustes de la captura recuperados');
  }
});

async function capture(): Promise<void> {
  if (!engine.hasImage) return toast('Importa una imagen primero');
  const img = await engine.renderThumb(state);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  shots.unshift({ state: cloneState(state), thumb: c.toDataURL('image/jpeg', 0.85) });
  shots.length = Math.min(shots.length, GALLERY);
  renderGallery();
  $('viewer').classList.remove('flash');
  void $('viewer').offsetWidth;
  $('viewer').classList.add('flash');
}
$('btn-capture').addEventListener('click', () => void capture());

/* ------------------------------ export ------------------------------ */
async function exportImage(type: 'image/png' | 'image/jpeg', s: GlitchState = state): Promise<void> {
  if (!engine.hasImage) return toast('Importa una imagen primero');
  const prog = $('progress');
  const msg = $('progress-msg');
  prog.hidden = false;
  try {
    const { blob, w, h } = await engine.exportFull(s, type, (m) => (msg.textContent = `Renderizando · ${m}…`));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `glitch-${s.seed}-${Date.now().toString(36)}.${type === 'image/png' ? 'png' : 'jpg'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Exportado ${w}×${h} · ${(blob.size / 1e6).toFixed(1)} MB`);
  } catch (err) {
    toast(`Error al exportar: ${(err as Error).message}`);
  } finally {
    prog.hidden = true;
  }
}
$('btn-png').addEventListener('click', () => void exportImage('image/png'));
$('btn-jpg').addEventListener('click', () => void exportImage('image/jpeg'));

/* ------------------------------ presets file ------------------------------ */
$('btn-preset-save').addEventListener('click', () => {
  const name = `glitch-${state.seed}`;
  const blob = new Blob([JSON.stringify(toPresetFile(name, state), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
const presetFile = $<HTMLInputElement>('preset-file');
$('btn-preset-load').addEventListener('click', () => presetFile.click());
presetFile.addEventListener('change', async () => {
  const f = presetFile.files?.[0];
  presetFile.value = '';
  if (!f) return;
  try {
    const { name, state: s } = parsePresetFile(await f.text());
    replaceState(s);
    toast(`Preset cargado: ${name}`);
  } catch {
    toast('Ese archivo no es un preset válido');
  }
});

/* ------------------------------ randomize / variants / A-B ------------------------------ */
$('btn-random').addEventListener('click', () => replaceState(randomState(freshSeed())));

const variantsEl = $('variants');
let variantRun = 0;
async function showVariants(): Promise<void> {
  if (!engine.hasImage) return toast('Importa una imagen primero');
  variantsEl.hidden = false;
  const run = ++variantRun;
  const grid = $('variant-grid');
  grid.innerHTML = '';
  const base = cloneState(state);
  const cands = Array.from({ length: 8 }, () => variantOf(base, freshSeed() * 7919 + 13));
  const cells = cands.map((v, i) => {
    const b = document.createElement('button');
    b.className = 'variant loading';
    b.setAttribute('aria-label', `Variante ${i + 1}`);
    b.innerHTML = `<canvas></canvas><span>${v.cables.map((c) => `${c.a}+${c.b}`).join(' · ') || '—'}</span>`;
    b.addEventListener('click', () => {
      replaceState(cloneState(v));
      variantsEl.hidden = true;
    });
    grid.append(b);
    return b;
  });
  for (let i = 0; i < cands.length; i++) {
    const img = await engine.renderThumb(cands[i]);
    if (run !== variantRun) return;
    const c = cells[i].querySelector('canvas')!;
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    cells[i].classList.remove('loading');
  }
}
$('btn-variants').addEventListener('click', () => void showVariants());
$('btn-var-more').addEventListener('click', () => void showVariants());
variantsEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t === variantsEl || t.closest('[data-act="close"]')) variantsEl.hidden = true;
});

function setAB(on: boolean): void {
  if (showOriginal === on) return;
  showOriginal = on;
  $('badge').hidden = !on;
  $('btn-ab').classList.toggle('pressed', on);
  requestRender();
}
const ab = $('btn-ab');
ab.addEventListener('pointerdown', (e) => {
  ab.setPointerCapture(e.pointerId);
  setAB(true);
});
ab.addEventListener('pointerup', () => setAB(false));
ab.addEventListener('pointercancel', () => setAB(false));

/* ------------------------------ misc buttons & keys ------------------------------ */
const openRewire = () => rewire.open();
$('btn-rewire').addEventListener('click', openRewire);
$('btn-pair').addEventListener('click', openRewire);
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
const rack = $('rack');
$('btn-rack').addEventListener('click', () => {
  const open = !rack.classList.contains('open');
  rack.classList.toggle('open', open);
  $('btn-rack').setAttribute('aria-expanded', String(open));
  $('btn-rack').textContent = open ? 'Cerrar' : 'Etapas';
});

function undo(): void {
  const prev = history.undo(state);
  if (prev) {
    state = sanitizeState(prev);
    afterChange(true);
  }
}
function redo(): void {
  const next = history.redo(state);
  if (next) {
    state = sanitizeState(next);
    afterChange(true);
  }
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === 'Escape') {
    variantsEl.hidden = true;
    return;
  }
  if (rewire.isOpen || !variantsEl.hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'b' && !e.repeat) setAB(true);
  else if (k === 'w') openRewire();
  else if (k === 'r') replaceState(randomState(freshSeed()));
  else if (k === 'v') void showVariants();
  else if (k === 'i') pickFile();
  else if (e.key === ' ' && !t.matches('button')) {
    e.preventDefault();
    void capture();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'b') setAB(false);
});

renderGallery();
afterChange(true);

/* ------------------------------ debug / test API ------------------------------ */
async function hashPixels(img: ImageData): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', img.data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
Object.assign(window, {
  __glitch: {
    loadSample: async () => setImage(await makeSampleImage()),
    getState: () => cloneState(state),
    setState: (s: unknown) => replaceState(sanitizeState(s)),
    hash: async (s?: unknown) => hashPixels(await engine.renderPreviewPixels(s ? sanitizeState(s) : state)),
    exportSize: async (type: 'image/png' | 'image/jpeg' = 'image/png') => {
      const r = await engine.exportFull(state, type);
      return { w: r.w, h: r.h, bytes: r.blob.size, original: [engine.original!.width, engine.original!.height] };
    },
    presetRoundTrip: () => parsePresetFile(JSON.stringify(toPresetFile('t', state))).state,
  },
});
