import './styles.css';
import './fonts';
import { Engine, MAX_MEGAPIXELS, PREVIEW_MAX, PREVIEW_MAX_ZOOMED } from './engine';
import { History } from './history';
import { FACTORY_PRESETS, randomState, variantOf } from './presets';
import { cloneState, defaultState, encParams, findPair, parsePresetFile, sanitizeState, toPresetFile, type GlitchState } from './model';
import { freshSeed } from './prng';
import { Knob } from './ui/knob';
import { CABLE_COLORS, RewirePanel } from './ui/rewire';
import { StagesPanel } from './ui/stages';
import { makeSampleImage } from './sample';
import { Session } from './session';
import { clampSize, cloneDoc, cloneLayer, emptyDoc, fxTargetId, layerAnimates, sanitizeDoc, flipLayer, getLayer, makeLayer, newId, pasteLayer, rotateLayer, textLayerName, type BitmapSource, type DocState, type Layer } from './doc';
import { ProjectStore, parseProjectFile, type ProjectMeta, type ProjectRecord } from './projects';
import { ContextMenu, type MenuEntry } from './ui/contextmenu';
import { ico } from './ui/icons';
import { DEFAULT_TEXT, ensureFont, loadFontFile, measureText, queryLocalFamilies, rasterText, rasterTextAt, type TextProps } from './text';
import type { SourceProvider } from './gl/renderer';
import { TextEditor } from './ui/textedit';
import { Viewport } from './ui/viewport';
import { LayersPanel } from './ui/layers';
import { hydrateIcons } from './ui/icons';
import { initCollapsibles } from './ui/collapse';
import { ExportUI } from './ui/exportui';
import { GifSearchPanel } from './ui/gifsearch';
import { sanitizeSettings } from './export/settings';
import { GifPlayer, VideoPlayer, mediaKind, type MediaPlayer } from './media/player';
import { SPEEDS, formatTime, frameSeed, spokenTime } from './media/timing';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
hydrateIcons();
/** Pre-layers versions kept the last glitch settings here: used as the first layer's effects. */
const LEGACY_STORE_KEY = 'glitch-editor:state:v1';

/* ------------------------------ state ------------------------------ */
/**
 * The layered document is the whole editing state: every layer carries its own effects
 * (`fx`). There are no global effects; the single effects editor (knobs, cables, stages,
 * presets, random, variants) always edits the active layer.
 */
let doc: DocState = emptyDoc();
const bitmaps = new Map<string, BitmapSource>();
/** Video / GIF players by bitmap key (the bitmap under the same key is the poster frame). */
const players = new Map<string, MediaPlayer>();
/** Bytes of each bitmap for the session store: the original file, or a PNG encoded on demand. */
const blobSources = new Map<string, Blob | (() => Promise<Blob>)>();
const history = new History<DocState>();
/** Saves the editing session in IndexedDB so a reload keeps everything. */
const session = new Session(
  () => ({ v: 1, doc, shots: legacyShots, fonts: fonts.files, project }),
  (k) => blobSources.get(k),
);
/** Saved projects (own IndexedDB database). */
const projects = new ProjectStore();
/** Project the document was opened from / saved as (Ctrl+S updates it). */
let project: { id: string; name: string } | null = null;
/** Document JSON at the last save / open of `project` (unsaved-changes dot). */
let savedJson = '';
/** Font file bytes by family (for saving projects that use them). */
const fontBlobs = new Map<string, Blob>();
let editBefore: string | null = null;
const snapJson = (): string => JSON.stringify(doc);

function legacyState(): GlitchState | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORE_KEY);
    return raw ? sanitizeState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
/** Effects for a brand-new image layer: the active layer's (so a stack keeps its look) or the default. */
function newLayerFx(): GlitchState {
  const a = getLayer(doc, doc.active);
  if (a?.fx && !a.text) return cloneState(a.fx);
  return legacyState() ?? defaultState();
}
/** Clean effects (nothing connected): new text layers start sharp. */
function cleanFx(): GlitchState {
  const fx = defaultState();
  fx.cables = [];
  fx.seed = freshSeed();
  return fx;
}

/**
 * All state mutations go through here.
 *  live: during a drag (render only)   end: drag finished (commit to history)
 *  once: discrete action (commit + full UI sync)
 */
type Phase = 'live' | 'end' | 'once';
function pushIfChanged(before: string): void {
  if (before !== snapJson()) history.push(JSON.parse(before) as DocState);
}
function mutate(fn: () => void, phase: Phase): void {
  if (phase === 'once') {
    const before = snapJson();
    fn();
    pushIfChanged(before);
    afterChange(true, true);
    return;
  }
  if (phase === 'live') {
    if (!editBefore) editBefore = snapJson();
    fn();
    afterChange(false, true);
    return;
  }
  fn();
  if (editBefore) pushIfChanged(editBefore);
  editBefore = null;
  afterChange(true, true);
}
/** Layer whose effects the controls edit: the selected one, else the main image. */
function fxLayer(): Layer | undefined {
  const l = getLayer(doc, fxTargetId(doc));
  if (l && !l.fx) l.fx = cleanFx();
  return l;
}
/** Shown (disabled) when no layer is selected. */
const NO_FX = cleanFx();
/** The glitch settings the knobs, cables and stages are editing right now. */
function cur(): GlitchState {
  return fxLayer()?.fx ?? NO_FX;
}
/** Edits the active layer's effects. */
function edit(fn: (s: GlitchState) => void, phase: Phase): void {
  const l = fxLayer();
  if (!l) {
    if (phase === 'once') toast('Importa una imagen para editar sus efectos');
    return;
  }
  const id = l.id;
  mutate(() => {
    const x = getLayer(doc, id);
    if (x?.fx) fn(x.fx);
  }, phase);
}
/** Replaces the active layer's effects (presets, random, variants). */
function applyToTarget(next: GlitchState): void {
  const l = fxLayer();
  if (!l) return toast('Importa una imagen primero');
  const id = l.id;
  editDoc((d) => {
    const x = getLayer(d, id);
    if (x) x.fx = sanitizeState(next);
  }, 'once');
}
/** Document / layers. */
function editDoc(fn: (d: DocState) => void, phase: Phase): void {
  mutate(() => fn(doc), phase);
}
/** Replaces the whole document (gallery shot), undoable. */
function replaceDoc(next: DocState): void {
  history.push(cloneDoc(doc));
  doc = cloneDoc(next);
  afterChange(true, true);
}

/* ------------------------------ engine & screen ------------------------------ */
/**
 * Pixels for each layer at the resolution the GPU needs: image proxy (≤1600 px) or full
 * bitmap; text rasterized at a power-of-two scale so zooming does not re-raster every step.
 */
const provider: SourceProvider = {
  source(l, pxScale) {
    if (l.text) {
      const t = l.text;
      const k = Math.min(2 ** Math.ceil(Math.log2(Math.max(pxScale, 1 / 16))), 4096 / Math.max(l.w, l.h));
      return { key: `${l.src}@${k}`, w: Math.max(1, Math.round(l.w * k)), h: Math.max(1, Math.round(l.h * k)), load: () => rasterTextAt(t, l.w, l.h, k) };
    }
    if (l.media) {
      // Live frame straight from the player (the poster bitmap below covers the reopen gap).
      const pl = players.get(l.src);
      if (pl) return { key: `${l.src}#m`, w: pl.w, h: pl.h, frame: pl.frame, stamp: pl.stamp, liveOnly: pl.playing, load: () => pl.source() };
    }
    const bm = bitmaps.get(l.src);
    if (!bm) return null;
    const proxy = bm.proxy as ImageBitmap;
    if (bm.proxyW < l.w && pxScale * l.w <= bm.proxyW * 1.05) return { key: `${l.src}#p`, w: proxy.width, h: proxy.height, load: () => proxy };
    return { key: `${l.src}#f`, w: l.w, h: l.h, load: () => bm.full as TexImageSource };
  },
};
let engine: Engine;
try {
  engine = new Engine(provider);
} catch (err) {
  document.body.innerHTML = `<div class="fatal"><h1>Este navegador no tiene WebGL2</h1><p>${(err as Error).message}</p><p>Prueba con una versión reciente de Chrome, Edge, Firefox o Safari.</p></div>`;
  throw err;
}
const screen = $<HTMLCanvasElement>('screen');
const ctx = screen.getContext('2d', { willReadFrequently: false })!;
engine.onBusy = (b) => $('busy').classList.toggle('on', b);

engine.onLayerReady = () => requestRender();
/** Adaptive preview resolution: grows when zooming in so the glitch stays sharp. */
let previewMax = PREVIEW_MAX;

let showOriginal = false;
let frame = 0;
/** Preview renders since load (the tests measure real fps with it). */
let presents = 0;
let mediaUiDirty = false;
function requestRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const has = doc.layers.length > 0;
    document.body.classList.toggle('has-image', has);
    $('empty').hidden = has;
    if (!has) {
      viewport.present();
      return;
    }
    engine.setDocSize(doc.w, doc.h, previewMax);
    engine.renderPreview(doc, null, ctx, showOriginal);
    presents++;
    if (mediaUiDirty) syncMediaBar();
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
  label: 'EFFECT', min: 0, max: 100, def: 50, value: cur().effect, size: 'md',
  info: 'Intensidad global de todos los puentes.',
  onInput: (v) => edit((s) => { s.effect = v; }, 'live'),
  onChange: () => edit(() => {}, 'end'),
});
const filterKnob = new Knob({
  label: 'FILTER', min: 0, max: 100, def: 50, value: cur().filter, size: 'md',
  info: 'Carácter del glitch: su efecto depende de cada par de pines (ver Recablear).',
  onInput: (v) => edit((s) => { s.filter = v; }, 'live'),
  onChange: () => edit(() => {}, 'end'),
});
$('knob-effect').append(effectKnob.el);
$('knob-filter').append(filterKnob.el);

const host = { state: cur, edit, toast };

/* ---- viewport (zoom / pan / transform) ---- */
function select(id: string | null): void {
  if (doc.active === id) return;
  doc.active = id;
  afterChange(true, true);
}
const viewport: Viewport = new Viewport($('stage'), {
  doc: () => doc,
  bitmaps,
  result: screen,
  resultSize: () => [screen.width, screen.height],
  select,
  layerLive: (id, patch) =>
    editDoc((d) => {
      const l = getLayer(d, id);
      if (l) Object.assign(l, patch);
    }, 'live'),
  layerEnd: () => editDoc(() => {}, 'end'),
  viewChanged,
  open: (id) => openTextEditor(id),
  contextMenu: (id, x, y) => openLayerMenu(id, x, y),
});
engine.onPresent = () => viewport.present();

const zoomPct = $('zoom-pct');
let previewTimer = 0;
function viewChanged(): void {
  textEditor?.position();
  zoomPct.textContent = `${Math.round(viewport.zoom * 100)}%`;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    // Smallest bucket that gives >= 1 preview pixel per device pixel, capped.
    const need = Math.max(doc.w, doc.h) * viewport.zoom * (window.devicePixelRatio || 1);
    const next = [PREVIEW_MAX, 2048, 3072, PREVIEW_MAX_ZOOMED].find((b) => b >= need) ?? PREVIEW_MAX_ZOOMED;
    if (next !== previewMax) {
      previewMax = next;
      requestRender();
    }
  }, 220);
}
$('view-hud').addEventListener('click', (e) => {
  const z = (e.target as HTMLElement).closest<HTMLElement>('[data-z]')?.dataset.z;
  if (z === 'in') viewport.zoomBy(1.25);
  else if (z === 'out') viewport.zoomBy(0.8);
  else if (z === 'fit') viewport.fit();
  else if (z === 'one' || z === 'pct') viewport.zoomTo(1);
});

/* ---- layers panel ---- */
function clampDocSize(w: number, h: number): [number, number] {
  return clampSize(w, h, engine.maxSize, MAX_MEGAPIXELS);
}
const layersPanel = new LayersPanel({
  doc: () => doc,
  bitmaps,
  editDoc,
  select,
  pickFiles: () => pickFile(),
  clampDocSize,
  toast,
  editText: (id, patch, phase) => void editText(id, patch, phase),
  openTextEditor: (id) => openTextEditor(id),
  addTextLayer: () => void addTextLayer(),
  extraFonts: () => fonts,
  fontsVersion: () => fonts.version,
  loadLocalFonts: () => void loadLocalFonts(),
  pickFontFile: () => fontFileInput.click(),
  rowMenu: (id, x, y) => openRowMenu(id, x, y),
});
$('layers').append(layersPanel.el);

/* ---- text layers ---- */
const fonts = { local: [] as string[], files: [] as string[], version: 0 };

/** Re-measures a text layer (its box follows the text, the center stays) and refreshes its UI raster. */
function refreshText(l: Layer): void {
  if (!l.text) return;
  const { w, h } = measureText(l.text);
  l.w = w;
  l.h = h;
  if (l.autoName !== false) l.name = textLayerName(l.text.content);
  const key = 'T|' + JSON.stringify([l.text, w, h]);
  if (!bitmaps.has(key)) {
    const c = rasterText(l.text, w, h);
    bitmaps.set(key, { full: c, proxy: c, proxyW: c.width });
  }
  l.src = key;
}

/** Changes text properties. Font changes wait for the font to load so the box is measured right. */
async function editText(id: string, patch: Partial<TextProps>, phase: Phase): Promise<void> {
  const l = getLayer(doc, id);
  if (!l?.text) return;
  if ('font' in patch || 'bold' in patch || 'italic' in patch) await ensureFont({ ...l.text, ...patch });
  editDoc((d) => {
    const x = getLayer(d, id);
    if (!x?.text) return;
    x.text = { ...x.text, ...patch };
    refreshText(x);
  }, phase);
}

/** T: new text layer in the middle of what you are looking at, ready to type. */
async function addTextLayer(): Promise<void> {
  const first = doc.layers.length === 0;
  const base = first ? emptyDoc() : doc;
  const t: TextProps = { ...DEFAULT_TEXT, size: Math.max(16, Math.round(Math.min(base.w, base.h) * 0.14)) };
  await ensureFont(t);
  let id = '';
  editDoc((d) => {
    if (first) Object.assign(d, emptyDoc(), { bg: d.bg });
    const { w, h } = measureText(t);
    const l: Layer = { ...makeLayer(d, '', w, h, ''), text: t, autoName: true, scaleX: 1, scaleY: 1, fx: cleanFx() };
    if (!first) {
      // Center of the visible area, clamped to the canvas.
      const z = viewport.zoom;
      l.x = Math.min(d.w, Math.max(0, (viewport.stage.width() / 2 - viewport.stage.x()) / z));
      l.y = Math.min(d.h, Math.max(0, (viewport.stage.height() / 2 - viewport.stage.y()) / z));
    }
    refreshText(l);
    const i = d.layers.findIndex((x) => x.id === d.active);
    d.layers.splice(i < 0 ? d.layers.length : i + 1, 0, l);
    d.active = l.id;
    id = l.id;
  }, 'once');
  if (first) viewport.fit();
  // Wait for the frame so the editor lands on the final camera.
  requestAnimationFrame(() => textEditor.open(id, true));
}

function openTextEditor(id: string): void {
  const l = getLayer(doc, id);
  if (!l?.text) return;
  if (l.locked) return toast('Capa bloqueada');
  select(id);
  textEditor.open(id);
}

const textEditor: TextEditor = new TextEditor($('stage'), viewport, {
  doc: () => doc,
  live: (id, content) => void editText(id, { content }, 'live'),
  end: (id) => {
    const l = getLayer(doc, id);
    // An empty text layer is removed when you leave the editor.
    if (l?.text && !l.text.content.trim()) {
      editDoc((d) => {
        d.layers = d.layers.filter((x) => x.id !== id);
        if (d.active === id) d.active = d.layers[d.layers.length - 1]?.id ?? null;
      }, 'end');
      return;
    }
    editDoc(() => {}, 'end');
  },
});

async function loadLocalFonts(): Promise<void> {
  try {
    const fams = await queryLocalFamilies();
    if (!fams) return toast('Este navegador no deja listar las fuentes del equipo (usa Chrome o Edge, o «Cargar fuente…»)');
    fonts.local = fams;
    fonts.version++;
    layersPanel.sync();
    toast(`${fams.length} fuentes del equipo disponibles en la lista`);
  } catch {
    toast('Permiso denegado para leer las fuentes del equipo');
  }
}

const fontFileInput = document.createElement('input');
fontFileInput.type = 'file';
fontFileInput.accept = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';
fontFileInput.hidden = true;
document.body.append(fontFileInput);
fontFileInput.addEventListener('change', async () => {
  const f = fontFileInput.files?.[0];
  fontFileInput.value = '';
  if (!f) return;
  try {
    const family = await loadFontFile(f);
    if (!fonts.files.includes(family)) fonts.files.push(family);
    fontBlobs.set(family, f);
    session.addFont(family, f);
    fonts.version++;
    const l = getLayer(doc, doc.active);
    if (l?.text) await editText(l.id, { font: family }, 'once');
    else layersPanel.sync();
    toast(`Fuente «${family}» cargada`);
  } catch {
    toast('No se pudo leer ese archivo de fuente');
  }
});

// The rewire board, twice over the same state: the full sheet (pop-up) and the inline mini chip.
const rewire = new RewirePanel(host, 'full');
document.body.append(rewire.el);
const miniRewire = new RewirePanel({ ...host, expand: () => openRewire() }, 'compact');
$('mini-rewire').append(miniRewire.el);
const stages = new StagesPanel(host);
$('stages').append(stages.el);

const presetSelect = $<HTMLSelectElement>('preset-select');
presetSelect.innerHTML = `<option value="">Presets de fábrica…</option>` + FACTORY_PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
presetSelect.addEventListener('change', () => {
  const i = Number(presetSelect.value);
  if (presetSelect.value !== '' && FACTORY_PRESETS[i]) {
    applyToTarget(cloneState(FACTORY_PRESETS[i].state));
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
function afterChange(full: boolean, docTouched = false): void {
  if (docTouched) {
    syncPlayers();
    session.schedule();
    viewport.sync();
    layersPanel.sync();
    textEditor?.position();
    syncProjectLabel();
  }
  requestRender();
  stages.syncLeds();
  updatePair();
  if (!full) {
    // Mid-drag (knob / slider in either view): move the other view's values, rebuild nothing.
    miniRewire.syncValues();
    if (rewire.isOpen) rewire.syncValues();
    return;
  }
  const g = cur();
  effectKnob.set(g.effect);
  filterKnob.set(g.filter);
  seedInput.value = String(g.seed);
  syncFxLabel();
  stages.sync();
  miniRewire.sync();
  if (rewire.isOpen) rewire.sync();
  ($('btn-undo') as HTMLButtonElement).disabled = !history.canUndo;
  ($('btn-redo') as HTMLButtonElement).disabled = !history.canRedo;
}

function updatePair(): void {
  const state = cur();
  const html = state.cables.length
    ? state.cables.map((c, i) => `<span style="color:${CABLE_COLORS[i % CABLE_COLORS.length]}">${findPair(c.a, c.b)!.a}+${findPair(c.a, c.b)!.b}</span>`).join('<i>·</i>')
    : '<span class="pair-off">SIN PUENTE</span>';
  const name = !state.cables.length ? 'toca para recablear' : state.cables.length === 1 ? findPair(state.cables[0].a, state.cables[0].b)!.name : `${state.cables.length} cables`;
  // Summary on the effects panel's button (the controls bar shows the mini chip itself).
  $('fx-pair-label').innerHTML = html;
  $('fx-pair-name').textContent = name;
}

/* ------------------------------ import ------------------------------ */
const PROXY_MAX = 1600;

/** Imports one or more files (images, animated GIFs, videos); each one becomes a new layer. */
async function importFiles(files: (File | Blob)[]): Promise<void> {
  let ok = 0;
  let known = 0;
  let last = '';
  for (const f of files) {
    const kind = await mediaKind(f as File).catch(() => null);
    if (!kind) continue;
    known++;
    const name = f instanceof File ? f.name.replace(/\.[^.]+$/, '') : kind === 'video' ? 'vídeo pegado' : 'imagen pegada';
    try {
      if (kind === 'image') {
        const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
        await addImageLayer(bmp, name, {}, f);
      } else {
        await addMediaLayer(f, kind, name);
      }
      last = kind;
      ok++;
    } catch (err) {
      // Never fail silently: say which file and why (codec, size, damaged…).
      const why = kind === 'image' ? '¿formato no soportado?' : (err as Error).message;
      toast(`No se pudo abrir «${name}»: ${why}`);
      await new Promise((r) => setTimeout(r, ok || known > 1 ? 2600 : 0));
    }
  }
  if (!known) return toast('Eso no es una imagen, un GIF ni un vídeo');
  if (ok === 1 && last !== 'image') toast(`${last === 'gif' ? 'GIF' : 'Vídeo'} añadido · Espacio = play/pausa`);
  else if (ok === 1) toast(`Capa añadida · lienzo ${doc.w}×${doc.h}`);
  else if (ok > 1) toast(`${ok} capas añadidas`);
}

/* ------------------------------ video / GIF layers ------------------------------ */
/** Opens a player for a file and wires it to the render loop and the media bar. */
async function openPlayer(blob: Blob, kind: 'video' | 'gif'): Promise<MediaPlayer> {
  const p: MediaPlayer = kind === 'video' ? await VideoPlayer.open(blob, engine.maxSize) : await GifPlayer.open(blob, engine.maxSize);
  p.onFrame = () => requestRender();
  p.onState = () => markMediaUi();
  return p;
}
/**
 * "Glitch animado" default: on, as in a real CCD whose read noise differs every frame (a fixed
 * pattern over moving footage looks like dirt on the screen). Off when the system asks for
 * reduced motion: per-frame flicker is exactly what that setting is about.
 */
const defaultAnimate = (): boolean => !matchMedia('(prefers-reduced-motion: reduce)').matches;

async function addMediaLayer(f: Blob, kind: 'video' | 'gif', name: string): Promise<Layer> {
  const player = await openPlayer(f, kind);
  const key = newId('B');
  players.set(key, player);
  // The poster is a copy: the player closes its own bitmap when disposed.
  const [w, h] = await registerBitmap(key, await createImageBitmap(player.poster), name);
  blobSources.set(key, f);
  const layer = insertLayer(key, w, h, name, { kind, animate: defaultAnimate() });
  void player.play();
  return layer;
}

/** Players follow the document: closed when no layer uses them, reopened (undo) from the stored file. */
const opening = new Set<string>();
function syncPlayers(): void {
  const want = new Map<string, 'video' | 'gif'>();
  for (const l of doc.layers) if (l.media) want.set(l.src, l.media.kind);
  for (const [k, p] of players) {
    if (want.has(k)) continue;
    p.dispose();
    players.delete(k);
  }
  for (const [k, kind] of want) if (!players.has(k) && !opening.has(k)) void reopenPlayer(k, kind);
  markMediaUi();
}
async function reopenPlayer(k: string, kind: 'video' | 'gif'): Promise<void> {
  const b = blobSources.get(k);
  if (!(b instanceof Blob)) return;
  opening.add(k);
  try {
    const p = await openPlayer(b, kind);
    if (doc.layers.some((l) => l.src === k && l.media) && !players.has(k)) {
      players.set(k, p);
      requestRender();
      markMediaUi();
    } else p.dispose();
  } catch (err) {
    toast(`No se pudo reabrir el ${kind === 'gif' ? 'GIF' : 'vídeo'}: ${(err as Error).message}`);
  } finally {
    opening.delete(k);
  }
}
/** The player the media bar drives: the selected layer's, else the first animated layer's. */
function mediaTarget(): { layer: Layer; player: MediaPlayer } | null {
  const pick = (l: Layer | undefined) => (l?.media && players.get(l.src) ? { layer: l, player: players.get(l.src)! } : null);
  return pick(getLayer(doc, doc.active)) ?? pick(getLayer(doc, fxTargetId(doc))) ?? doc.layers.map(pick).find((x) => x) ?? null;
}
/** Frames each animated layer at its current frame as a still image (capture / projects). */
async function freezeMedia(d: DocState): Promise<number> {
  let n = 0;
  for (const l of d.layers) {
    if (!l.media) continue;
    const p = players.get(l.src);
    if (p) {
      const bmp = await p.snapshot();
      const key = newId('B');
      await registerBitmap(key, bmp, l.name);
      blobSources.set(key, () => bitmapToPng(bitmaps.get(key)!.full as ImageBitmap));
      // Same pixels as on screen: the frame's noise seed becomes the still's seed.
      if (l.fx && l.media.animate) l.fx = { ...l.fx, seed: frameSeed(l.fx.seed, p.frame, true) };
      l.src = key;
      n++;
    }
    delete l.media;
  }
  return n;
}
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return players.forEach((p) => p.pause());
  players.forEach((p) => p.dispose());
  players.clear();
});

/** Decodes / limits a bitmap and registers it (full + proxy) under `key`. */
async function registerBitmap(key: string, bmp: ImageBitmap, name: string): Promise<[number, number]> {
  const [w, h] = clampSize(bmp.width, bmp.height, engine.maxSize, MAX_MEGAPIXELS);
  if (w !== bmp.width || h !== bmp.height) toast(`«${name}» reducida de ${bmp.width}×${bmp.height} a ${w}×${h} (límite de la GPU)`);
  const full = w === bmp.width && h === bmp.height ? bmp : await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const k = Math.min(1, PROXY_MAX / Math.max(w, h));
  const proxy = k < 1 ? await createImageBitmap(full, { resizeWidth: Math.round(w * k), resizeHeight: Math.round(h * k), resizeQuality: 'high' }) : full;
  bitmaps.set(key, { full, proxy, proxyW: proxy.width });
  return [w, h];
}
async function bitmapToPng(b: ImageBitmap): Promise<Blob> {
  const c = new OffscreenCanvas(b.width, b.height);
  c.getContext('2d')!.drawImage(b, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

/** Registers the bitmap and adds it as a new layer above the active one. */
async function addImageLayer(bmp: ImageBitmap, name: string, opts: { replace?: boolean } = {}, file?: Blob): Promise<Layer> {
  const key = newId('B');
  const [w, h] = await registerBitmap(key, bmp, name);
  blobSources.set(key, file ?? (() => bitmapToPng(bitmaps.get(key)!.full as ImageBitmap)));
  return insertLayer(key, w, h, name, undefined, opts.replace);
}

/** Adds a bitmap-backed layer above the active one (the first layer sets the canvas size). */
function insertLayer(key: string, w: number, h: number, name: string, media?: Layer['media'], replace = false): Layer {
  const first = replace || doc.layers.length === 0;
  let layer!: Layer;
  editDoc((d) => {
    if (first) Object.assign(d, emptyDoc(), { w, h, bg: d.bg });
    layer = { ...makeLayer(d, key, w, h, name), fx: newLayerFx() };
    if (media) layer.media = media;
    const i = d.layers.findIndex((l) => l.id === d.active);
    d.layers.splice(i < 0 ? d.layers.length : i + 1, 0, layer);
    d.active = layer.id;
  }, 'once');
  if (first) viewport.fit();
  return layer;
}

const fileInput = $<HTMLInputElement>('file');
const pickFile = () => fileInput.click();
fileInput.addEventListener('change', () => {
  const fs = [...(fileInput.files ?? [])];
  fileInput.value = '';
  if (fs.length) void importFiles(fs);
});
$('btn-import').addEventListener('click', pickFile);
$('btn-empty').addEventListener('click', pickFile);
$('btn-sample').addEventListener('click', async () => {
  await addImageLayer(await makeSampleImage(), 'Carta de ajuste');
});
/*
 * File drops (import). Only drags that carry files and did NOT start inside the page count:
 * reordering layers, moving them on the canvas or dragging a thumbnail are internal and must
 * never show the import overlay. The overlay is cleared on every way a drag can end.
 */
let internalDrag = false;
let dragDepth = 0;
const isFileDrag = (e: DragEvent): boolean => !internalDrag && !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
function endFileDrag(): void {
  dragDepth = 0;
  document.body.classList.remove('dragging');
}
window.addEventListener('dragstart', () => {
  internalDrag = true;
  endFileDrag();
});
window.addEventListener('dragend', () => {
  internalDrag = false;
  endFileDrag();
});
window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0 || e.relatedTarget === null) endFileDrag();
});
window.addEventListener('drop', (e) => {
  const files = isFileDrag(e) ? [...(e.dataTransfer?.files ?? [])] : [];
  e.preventDefault(); // never let the browser navigate to a dropped file
  internalDrag = false;
  endFileDrag();
  if (files.length) void importFiles(files);
});
// Safety nets: any of these means no file drag is in progress any more.
for (const t of ['pointerdown', 'pointermove', 'blur'] as const) window.addEventListener(t, () => document.body.classList.contains('dragging') && endFileDrag(), true);

/* ------------------------------ layer clipboard ------------------------------ */
/**
 * Ctrl+C / Ctrl+X / Ctrl+V on layers. The copied layer lives here (it references bitmaps by
 * key, which stay loaded); the system clipboard gets a token so a later Ctrl+V can tell our
 * layer apart from an image copied in another app (that one is imported instead).
 */
let clip: Layer | null = null;
let clipToken = '';
let clipPastes = 0;
let pendingCopyToken = '';
let pasteSeen = false;
const CLIP_PREFIX = 'glitch-editor/layer:';

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.matches('input, textarea, select') || t.isContentEditable);
}
function hasTextSelection(): boolean {
  return (window.getSelection()?.toString() ?? '') !== '';
}
function copyLayer(cutIt: boolean): boolean {
  const l = getLayer(doc, doc.active);
  if (!l) return false;
  clip = cloneLayer(l);
  clipPastes = 0;
  clipToken = CLIP_PREFIX + newId('C');
  pendingCopyToken = clipToken;
  // When no copy event follows (some browsers without a selection), try the async API.
  setTimeout(() => {
    if (pendingCopyToken) void navigator.clipboard?.writeText(pendingCopyToken).catch(() => {});
    pendingCopyToken = '';
  });
  if (cutIt) {
    if (l.locked) {
      toast('Capa bloqueada: copiada, no cortada');
      return true;
    }
    layersPanel.deleteActive(false);
    toast(`Capa «${l.name}» cortada`);
  } else toast(`Capa «${l.name}» copiada · Ctrl+V para pegar`);
  return true;
}
function pasteClip(): void {
  if (!clip) return toast('No hay ninguna capa copiada');
  const src = clip;
  if (!src.text && !bitmaps.has(src.src)) return toast('La imagen de la capa copiada ya no está disponible');
  editDoc((d) => {
    const empty = d.layers.length === 0;
    const l = pasteLayer(d, src, ++clipPastes);
    l.name = l.name.endsWith(' copia') ? l.name : `${l.name} copia`.slice(0, 80);
    l.autoName = l.text ? false : l.autoName;
    if (empty) {
      l.x = d.w / 2;
      l.y = d.h / 2;
    }
  }, 'once');
  if (doc.layers.length === 1) viewport.fit();
  toast('Capa pegada');
}
document.addEventListener('copy', (e) => {
  if (!pendingCopyToken || isTyping(e.target) || hasTextSelection()) return;
  e.clipboardData?.setData('text/plain', pendingCopyToken);
  e.preventDefault();
  pendingCopyToken = '';
});
document.addEventListener('cut', (e) => {
  if (!pendingCopyToken || isTyping(e.target) || hasTextSelection()) return;
  e.clipboardData?.setData('text/plain', pendingCopyToken);
  e.preventDefault();
  pendingCopyToken = '';
});
window.addEventListener('paste', (e) => {
  if (isTyping(e.target)) return;
  pasteSeen = true;
  const dt = e.clipboardData;
  const text = dt?.getData('text/plain') ?? '';
  const fs = [...(dt?.items ?? [])]
    .filter((i) => i.kind === 'file' && (i.type.startsWith('image/') || i.type.startsWith('video/')))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
  e.preventDefault();
  // Our own token, or nothing importable on the clipboard: paste the copied layer.
  if (clip && (text === clipToken || !fs.length)) return pasteClip();
  if (fs.length) void importFiles(fs);
});

/* ------------------------------ projects ------------------------------ */
/** Gallery shots of older versions, kept in the session until moved into projects. */
let legacyShots: { doc: DocState; thumb: string }[] = [];
let projectList: ProjectMeta[] = [];

async function thumbOf(d: DocState): Promise<string> {
  const img = await engine.renderThumb(d, null);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.8);
}
/** Font-file families the document's text layers use. */
function docFonts(d: DocState): string[] {
  return [...new Set(d.layers.filter((l) => l.text && fonts.files.includes(l.text.font)).map((l) => l.text!.font))];
}
function defaultProjectName(): string {
  const n = projectList.length + 1;
  const first = doc.layers.find((l) => !l.text)?.name;
  return first ? `${first}`.slice(0, 60) : `Proyecto ${n}`;
}

/** Saves the document: into its project (asNew = false) or as a new project. */
async function saveProject(asNew: boolean): Promise<void> {
  if (!doc.layers.length) return toast('No hay nada que guardar: importa una imagen primero');
  if (!projects.available) return toast('Este navegador no permite guardar proyectos');
  const json = JSON.stringify(doc);
  const snapshot = cloneDoc(doc);
  // Projects hold stills: each video / GIF layer is saved as its current frame, full resolution.
  const frozen = await freezeMedia(snapshot);
  const now = Date.now();
  const existing = !asNew && project ? await projects.get(project.id) : null;
  const rec: ProjectRecord = {
    v: 1,
    id: existing?.id ?? newId('P'),
    name: existing?.name ?? (asNew && project ? `${project.name} (2)`.slice(0, 80) : defaultProjectName()),
    created: existing?.created ?? now,
    updated: now,
    thumb: await thumbOf(snapshot),
    layers: snapshot.layers.length,
    doc: snapshot,
    fonts: docFonts(snapshot),
  };
  try {
    await projects.save(rec, (k) => blobSources.get(k), (f) => fontBlobs.get(f));
  } catch (err) {
    return toast(`No se pudo guardar el proyecto: ${(err as Error).message}`);
  }
  project = { id: rec.id, name: rec.name };
  savedJson = json;
  session.schedule();
  await refreshProjects();
  syncProjectLabel();
  $('viewer').classList.remove('flash');
  void $('viewer').offsetWidth;
  $('viewer').classList.add('flash');
  const what = frozen ? ` · fotograma ${formatTime(mediaTarget()?.player.time ?? 0)}` : '';
  toast((existing ? `Proyecto «${rec.name}» guardado` : `Guardado como proyecto «${rec.name}»`) + what);
}

/** Loads the fonts a project needs from the projects database. */
async function loadProjectFonts(families: string[], get: (f: string) => Promise<Blob | undefined>): Promise<void> {
  for (const f of families) {
    if (fonts.files.includes(f)) continue;
    const b = await get(f);
    if (!b) continue;
    try {
      const face = new FontFace(f, await b.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      fonts.files.push(f);
      fontBlobs.set(f, b);
      session.addFont(f, b);
      fonts.version++;
    } catch {
      /* unreadable font: the text falls back */
    }
  }
}

async function openProject(id: string): Promise<void> {
  const p = await projects.load(id).catch(() => null);
  if (!p) {
    toast('Ese proyecto ya no existe');
    return refreshProjects();
  }
  await loadProjectFonts(p.rec.fonts, p.font);
  const { doc: d, missing } = await hydrate(cloneDoc(p.rec.doc), p.blob);
  if (!d.layers.length && p.rec.doc.layers.length) return toast('No se pudo abrir: faltan las imágenes del proyecto');
  replaceDoc(d);
  project = { id: p.rec.id, name: p.rec.name };
  savedJson = missing ? '' : snapJson();
  viewport.fit();
  syncProjectLabel();
  renderProjects();
  toast(missing ? `Proyecto abierto, pero faltan ${missing} imagen${missing === 1 ? '' : 'es'}` : `Proyecto «${p.rec.name}» abierto`);
}

async function refreshProjects(): Promise<void> {
  projectList = await projects.list().catch(() => []);
  renderProjects();
}

function escapeHtml(x: string): string {
  return x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const dateFmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function renderProjects(): void {
  const g = $('project-grid');
  $('projects').classList.toggle('empty', projectList.length === 0);
  $('project-count').textContent = projectList.length ? String(projectList.length) : '';
  if (!projectList.length) {
    g.innerHTML = '<p class="projects-empty">Sin proyectos guardados. <b>Ctrl+S</b> guarda el documento; <b>Capturar</b> (cámara, o Espacio sin vídeo) guarda una captura como proyecto nuevo.</p>';
    return;
  }
  g.innerHTML = projectList
    .map(
      (p) => `
    <article class="pcard${project?.id === p.id ? ' current' : ''}" data-id="${escapeHtml(p.id)}">
      <button class="pcard-img" data-open aria-label="Abrir ${escapeHtml(p.name)}" title="Abrir el proyecto">${p.thumb ? `<img src="${p.thumb}" alt="" draggable="false">` : ''}</button>
      <div class="pcard-meta">
        <span class="pcard-name" title="${escapeHtml(p.name)} · doble clic para renombrar">${escapeHtml(p.name)}</span>
        <small>${p.layers} capa${p.layers === 1 ? '' : 's'} · ${dateFmt.format(p.updated)}</small>
      </div>
      <div class="pcard-acts">
        <button data-png aria-label="Descargar PNG de ${escapeHtml(p.name)}" title="Descargar PNG a resolución completa">${ico('download')}</button>
        <button data-export aria-label="Exportar archivo de ${escapeHtml(p.name)}" title="Exportar archivo .glitch (proyecto completo)">${ico('file-down')}</button>
        <button data-del class="danger" aria-label="Eliminar ${escapeHtml(p.name)}" title="Eliminar proyecto">${ico('trash')}</button>
      </div>
    </article>`,
    )
    .join('');
}

function syncProjectLabel(): void {
  const el = $('project-current');
  const dirty = !!project && snapJson() !== savedJson;
  el.textContent = project ? project.name : doc.layers.length ? 'sin guardar' : '';
  el.classList.toggle('dirty', dirty || (!project && doc.layers.length > 0));
  el.title = project ? (dirty ? 'Cambios sin guardar (Ctrl+S)' : 'Guardado') : 'Documento sin guardar (Ctrl+S)';
}

function renameProjectInline(card: HTMLElement): void {
  const id = card.dataset.id!;
  const label = card.querySelector<HTMLElement>('.pcard-name');
  const meta = projectList.find((p) => p.id === id);
  if (!label || !meta) return;
  const input = document.createElement('input');
  input.className = 'pcard-name-input';
  input.value = meta.name;
  input.maxLength = 80;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Nombre del proyecto');
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim().slice(0, 80);
    if (commit && name && name !== meta.name) {
      await projects.rename(id, name);
      if (project?.id === id) project.name = name;
      syncProjectLabel();
      session.schedule();
    }
    await refreshProjects();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') void finish(true);
    else if (e.key === 'Escape') void finish(false);
  });
  input.addEventListener('blur', () => void finish(true));
}

const deleteArmed = new Map<string, number>();
$('project-grid').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const card = t.closest<HTMLElement>('.pcard');
  if (!card) return;
  const id = card.dataset.id!;
  if (t.closest('[data-open]')) return void openProject(id);
  if (t.closest('[data-png]')) return void exportProjectPng(id);
  if (t.closest('[data-export]')) return void exportProjectFile(id);
  const del = t.closest<HTMLElement>('[data-del]');
  if (del) {
    // Two clicks to delete (no dialog): the first one arms the button for 3 s.
    if (!deleteArmed.has(id)) {
      del.classList.add('armed');
      del.title = 'Pulsa otra vez para eliminar';
      deleteArmed.set(id, window.setTimeout(() => {
        deleteArmed.delete(id);
        del.classList.remove('armed');
        del.title = 'Eliminar proyecto';
      }, 3000));
      return;
    }
    clearTimeout(deleteArmed.get(id));
    deleteArmed.delete(id);
    const name = projectList.find((p) => p.id === id)?.name ?? '';
    void projects.remove(id).then(async () => {
      if (project?.id === id) project = null;
      syncProjectLabel();
      session.schedule();
      await refreshProjects();
      toast(`Proyecto «${name}» eliminado`);
    });
  }
});
$('project-grid').addEventListener('dblclick', (e) => {
  const t = e.target as HTMLElement;
  const card = t.closest<HTMLElement>('.pcard');
  if (card && t.closest('.pcard-name')) renameProjectInline(card);
});

async function exportProjectPng(id: string): Promise<void> {
  const p = await projects.load(id);
  if (!p) return toast('Ese proyecto ya no existe');
  await loadProjectFonts(p.rec.fonts, p.font);
  const { doc: d } = await hydrate(cloneDoc(p.rec.doc), p.blob);
  await exportImage('image/png', d);
}
async function exportProjectFile(id: string): Promise<void> {
  try {
    const blob = await projects.exportFile(id);
    const name = projectList.find((p) => p.id === id)?.name ?? 'proyecto';
    download(blob, `${name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'proyecto'}.glitch`);
    toast('Proyecto exportado (ábrelo luego con el botón de abrir archivo)');
  } catch (err) {
    toast(`No se pudo exportar: ${(err as Error).message}`);
  }
}
function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const projectFile = document.createElement('input');
projectFile.type = 'file';
projectFile.accept = '.glitch,application/json';
projectFile.hidden = true;
document.body.append(projectFile);
projectFile.addEventListener('change', async () => {
  const f = projectFile.files?.[0];
  projectFile.value = '';
  if (!f) return;
  try {
    const { rec, images, fonts: fontFiles } = await parseProjectFile(await f.text());
    // Never overwrite a different project that happens to have the same id.
    if (await projects.get(rec.id)) rec.id = newId('P');
    rec.updated = Date.now();
    for (const [fam, b] of fontFiles) if (!fontBlobs.has(fam)) fontBlobs.set(fam, b);
    await projects.save(rec, (k) => images.get(k) ?? blobSources.get(k), (fam) => fontBlobs.get(fam));
    await refreshProjects();
    await openProject(rec.id);
  } catch (err) {
    toast(`No se pudo abrir el archivo: ${(err as Error).message}`);
  }
});
$('btn-save').addEventListener('click', () => void saveProject(false));
$('btn-save-new').addEventListener('click', () => void saveProject(true));
$('btn-project-import').addEventListener('click', () => projectFile.click());
$('btn-capture').addEventListener('click', () => void saveProject(true));

/* ------------------------------ export ------------------------------ */
async function exportImage(type: 'image/png' | 'image/jpeg', d: DocState = doc): Promise<void> {
  if (!d.layers.length) return toast('Importa una imagen primero');
  const prog = $('progress');
  const msg = $('progress-msg');
  prog.hidden = false;
  try {
    const { blob, w, h } = await engine.exportFull(d, null, type, (m) => (msg.textContent = `Renderizando · ${m}…`));
    download(blob, `glitch-${Date.now().toString(36)}.${type === 'image/png' ? 'png' : 'jpg'}`);
    toast(`Exportado ${w}×${h} · ${(blob.size / 1e6).toFixed(1)} MB`);
  } catch (err) {
    toast(`Error al exportar: ${(err as Error).message}`);
  } finally {
    prog.hidden = true;
  }
}

/* ------------------------------ presets file ------------------------------ */
$('btn-preset-save').addEventListener('click', () => {
  const name = `glitch-${cur().seed}`;
  const blob = new Blob([JSON.stringify(toPresetFile(name, cur()), null, 2)], { type: 'application/json' });
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
    applyToTarget(s);
    toast(`Preset cargado: ${name}`);
  } catch {
    toast('Ese archivo no es un preset válido');
  }
});

/* ------------------------------ randomize / variants / A-B ------------------------------ */
$('btn-random').addEventListener('click', () => applyToTarget(randomState(freshSeed())));

/** The document with `g` as the active layer's effects (variant thumbnails). */
function withTarget(g: GlitchState): DocState {
  const d = cloneDoc(doc);
  const l = getLayer(d, fxTargetId(d));
  if (l) l.fx = g;
  return d;
}

const variantsEl = $('variants');
let variantRun = 0;
async function showVariants(): Promise<void> {
  if (!doc.layers.length || !fxLayer()) return toast('Importa una imagen primero');
  variantsEl.hidden = false;
  const run = ++variantRun;
  const grid = $('variant-grid');
  grid.innerHTML = '';
  const base = cloneState(cur());
  const cands = Array.from({ length: 8 }, () => variantOf(base, freshSeed() * 7919 + 13));
  const cells = cands.map((v, i) => {
    const b = document.createElement('button');
    b.className = 'variant loading';
    b.setAttribute('aria-label', `Variante ${i + 1}`);
    b.innerHTML = `<canvas></canvas><span>${v.cables.map((c) => `${c.a}+${c.b}`).join(' · ') || '—'}</span>`;
    b.addEventListener('click', () => {
      applyToTarget(cloneState(v));
      variantsEl.hidden = true;
    });
    grid.append(b);
    return b;
  });
  for (let i = 0; i < cands.length; i++) {
    const img = await engine.renderThumb(withTarget(cands[i]), null);
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

/* ------------------------------ media bar (video / GIF transport) ------------------------------ */
const mb = {
  bar: $('media-bar'),
  play: $<HTMLButtonElement>('mb-play'),
  prev: $<HTMLButtonElement>('mb-prev'),
  next: $<HTMLButtonElement>('mb-next'),
  seek: $<HTMLInputElement>('mb-seek'),
  time: $('mb-time'),
  speed: $<HTMLSelectElement>('mb-speed'),
  loop: $<HTMLButtonElement>('mb-loop'),
  mute: $<HTMLButtonElement>('mb-mute'),
  vol: $<HTMLInputElement>('mb-vol'),
  anim: $<HTMLInputElement>('mb-anim'),
  note: $('mb-note'),
  kind: $('mb-kind'),
};
mb.speed.innerHTML = SPEEDS.map((v) => `<option value="${v}">${String(v).replace('.', ',')}×</option>`).join('');
let scrubbing = false;
function markMediaUi(): void {
  mediaUiDirty = true;
  if (!frame) requestAnimationFrame(() => mediaUiDirty && syncMediaBar());
}
function toggleMedia(): void {
  const t = mediaTarget();
  if (!t) return;
  if (t.player.playing) t.player.pause();
  else void t.player.play();
}
/** Pushes the target player's state into the bar (cheap: runs once per rendered frame at most). */
function syncMediaBar(): void {
  mediaUiDirty = false;
  const t = mediaTarget();
  mb.bar.hidden = !t;
  document.body.classList.toggle('has-media', !!t);
  if (!t) return;
  const { player: p, layer: l } = t;
  const playing = p.playing;
  mb.play.innerHTML = ico(playing ? 'pause' : 'play');
  mb.play.setAttribute('aria-label', playing ? 'Pausa' : 'Reproducir');
  mb.play.classList.toggle('pressed', playing);
  mb.kind.textContent = p.kind === 'gif' ? `GIF · ${p.w}×${p.h}` : `VÍDEO · ${p.w}×${p.h}`;
  const d = p.duration;
  mb.seek.max = String(d || 0);
  if (!scrubbing) mb.seek.value = String(p.time);
  mb.seek.disabled = !d;
  mb.seek.setAttribute('aria-valuetext', `${spokenTime(p.time)} de ${spokenTime(d)}`);
  mb.time.textContent = `${formatTime(p.time)} / ${formatTime(d)}`;
  const sp = String(p.speed);
  if (mb.speed.value !== sp) mb.speed.value = sp;
  mb.loop.setAttribute('aria-pressed', String(p.loop));
  mb.loop.classList.toggle('pressed', p.loop);
  const audio = p.kind === 'video' && p.hasAudio !== false;
  mb.mute.disabled = !audio;
  mb.vol.disabled = !audio;
  mb.mute.title = audio ? 'Silenciar / activar sonido (M)' : p.kind === 'gif' ? 'Los GIF no tienen sonido' : 'Este vídeo no tiene audio';
  mb.mute.innerHTML = ico(p.muted || !audio ? 'volume-x' : 'volume');
  mb.mute.setAttribute('aria-label', p.muted ? 'Activar sonido' : 'Silenciar');
  mb.mute.setAttribute('aria-pressed', String(p.muted));
  mb.vol.value = String(p.muted ? 0 : Math.round(p.volume * 100));
  mb.anim.checked = !!l.media?.animate;
  // The encoder stage (JPEG / pixel sort) does not run while playing: say so.
  const enc = !!l.fx && encParams(l.fx) !== null;
  mb.note.hidden = !(enc && playing);
}
mb.play.addEventListener('click', toggleMedia);
mb.prev.addEventListener('click', () => mediaTarget()?.player.step(-1));
mb.next.addEventListener('click', () => mediaTarget()?.player.step(1));
mb.seek.addEventListener('pointerdown', () => { scrubbing = true; });
const endScrub = () => { scrubbing = false; markMediaUi(); };
mb.seek.addEventListener('pointerup', endScrub);
mb.seek.addEventListener('pointercancel', endScrub);
mb.seek.addEventListener('change', endScrub);
mb.seek.addEventListener('input', () => mediaTarget()?.player.seek(Number(mb.seek.value)));
mb.speed.addEventListener('change', () => {
  const t = mediaTarget();
  if (t) t.player.speed = Number(mb.speed.value);
  markMediaUi();
});
mb.loop.addEventListener('click', () => {
  const t = mediaTarget();
  if (t) t.player.loop = !t.player.loop;
  markMediaUi();
});
mb.mute.addEventListener('click', () => {
  const t = mediaTarget();
  if (t) t.player.muted = !t.player.muted;
  markMediaUi();
});
mb.vol.addEventListener('input', () => {
  const t = mediaTarget();
  if (!t) return;
  const v = Number(mb.vol.value) / 100;
  t.player.volume = v;
  t.player.muted = v === 0;
  markMediaUi();
});
mb.anim.addEventListener('change', () => {
  const t = mediaTarget();
  if (!t) return;
  const on = mb.anim.checked;
  editDoc((d) => {
    for (const l of d.layers) if (l.src === t.layer.src && l.media) l.media.animate = on;
  }, 'once');
  toast(on ? 'Glitch animado: el ruido cambia en cada fotograma' : 'Glitch fijo: el mismo patrón en todos los fotogramas');
});

/* ------------------------------ misc buttons & keys ------------------------------ */
const openRewire = (): void => {
  if (!fxLayer()) return toast('Importa una imagen para recablear sus efectos');
  rewire.open();
};
$('btn-fx-rewire').addEventListener('click', openRewire);
$('btn-fx-clear').addEventListener('click', () => {
  const l = fxLayer();
  if (l) clearLayerFx(l.id);
});

/* ---- side panel tabs: Capas / Efectos ---- */
const TAB_KEY = 'glitch-editor:tab';
function showTab(tab: string, save = true): void {
  if (tab !== 'layers' && tab !== 'fx') tab = 'layers';
  for (const b of document.querySelectorAll<HTMLElement>('.rack-tab')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of document.querySelectorAll<HTMLElement>('.tab-panel')) p.hidden = p.dataset.panel !== tab;
  if (save) {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable */
    }
  }
}
document.querySelector('.rack-tabs')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.rack-tab');
  if (b) showTab(b.dataset.tab!);
});
document.querySelector('.rack-tabs')!.addEventListener('keydown', (e) => {
  const k = (e as KeyboardEvent).key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  const next = document.querySelector<HTMLElement>('.rack-tab:not(.on)')!;
  showTab(next.dataset.tab!);
  next.focus();
});
let savedTab = 'layers';
try {
  savedTab = localStorage.getItem(TAB_KEY) ?? 'layers';
} catch {
  /* storage unavailable */
}
showTab(savedTab, false);
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
const rack = $('rack');
initCollapsibles(rack);
$('btn-rack').addEventListener('click', () => {
  const open = !rack.classList.contains('open');
  rack.classList.toggle('open', open);
  $('btn-rack').classList.toggle('is-open', open);
  $('btn-rack').setAttribute('aria-expanded', String(open));
  $('btn-rack').setAttribute('aria-label', open ? 'Cerrar panel' : 'Abrir panel');
});

/* ------------------------------ theme ------------------------------ */
const THEME_KEY = 'glitch-editor:theme';
function applyTheme(t: 'light' | 'dark', save: boolean): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#161618' : '#e8e6e1');
  $('btn-theme').setAttribute('aria-label', t === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  if (save) {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage unavailable */
    }
  }
}
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);
$('btn-theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
// Follow the system while the user has not chosen.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* ignore */
  }
  if (!saved) applyTheme(e.matches ? 'dark' : 'light', false);
});

/* ------------------------------ effects of the active layer ------------------------------ */
function syncFxLabel(): void {
  const l = getLayer(doc, fxTargetId(doc));
  document.body.classList.toggle('no-fx-target', !l);
  const name = l ? l.name : 'sin imagen';
  $('fx-target-name').textContent = name;
  $('fx-panel-name').textContent = name;
  $('fx-panel-name').title = l && !doc.active ? 'Ninguna capa seleccionada: se editan los efectos de la imagen principal' : name;
  const anim = $<HTMLInputElement>('fx-anim');
  anim.checked = !!l && layerAnimates(l);
  $('fx-anim-hint').textContent = l?.media ? 'ruido distinto en cada fotograma del vídeo' : 'ruido distinto en cada fotograma · habilita GIF / MP4';
}
$<HTMLInputElement>('fx-anim').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  const id = fxTargetId(doc);
  editDoc((d) => {
    const l = getLayer(d, id);
    if (!l) return;
    if (l.media) l.media.animate = on;
    else if (on) l.animate = true;
    else delete l.animate;
  }, 'once');
  toast(on ? 'Glitch animado: el ruido cambia en cada fotograma' : 'Glitch fijo');
});
/** Resets the layer's effects (nothing connected). */
function clearLayerFx(id: string): void {
  editDoc((d) => {
    const l = getLayer(d, id);
    if (l) l.fx = cleanFx();
  }, 'once');
}

function restore(d: DocState | null): void {
  if (!d) return;
  doc = d;
  afterChange(true, true);
}
function undo(): void {
  restore(history.undo(doc));
}
function redo(): void {
  restore(history.redo(doc));
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input, select, textarea')) return;
  // The export dialog / progress own the keyboard (Esc is handled there).
  if (exportUi.dialogOpen || exportUi.busy || gifSearch.isOpen) return;
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
  if (rewire.isOpen || !variantsEl.hidden) {
    // Esc closes the open sheet even when focus fell back to the page (e.g. after the
    // cable list was redrawn under a knob that had focus).
    if (e.key === 'Escape') {
      if (rewire.isOpen) rewire.close();
      variantsEl.hidden = true;
    }
    return;
  }
  // View: Ctrl + / Ctrl - / Ctrl 0 / Ctrl 1 like other editors (instead of the browser zoom).
  if (mod && ['+', '=', '-', '0', '1'].includes(e.key)) {
    e.preventDefault();
    viewKey(e.key);
    return;
  }
  if (mod && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    layersPanel.duplicateActive();
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void saveProject(e.shiftKey);
    return;
  }
  // Style clipboard: Ctrl+Alt+C / Ctrl+Alt+V on the selected layer.
  if (mod && e.altKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'v') && doc.active) {
    e.preventDefault();
    if (e.key.toLowerCase() === 'c') copyStyle(doc.active);
    else if (styleClip) pasteStyle(doc.active);
    else toast('No hay ningún estilo copiado');
    return;
  }
  // Layer clipboard (text selections keep the normal copy).
  if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x') && !hasTextSelection()) {
    copyLayer(e.key.toLowerCase() === 'x');
    return;
  }
  if (mod && e.key.toLowerCase() === 'v') {
    // The paste event normally follows; if the browser sends none, paste the copied layer.
    pasteSeen = false;
    setTimeout(() => !pasteSeen && clip && pasteClip(), 120);
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === 'Escape') {
    if (doc.active) select(null);
    return;
  }
  if (e.key === 'F2') {
    e.preventDefault();
    layersPanel.renameActive();
    return;
  }
  if (layerKey(e, t)) return;
  const k = e.key.toLowerCase();
  if (k === 'b' && !e.repeat) setAB(true);
  else if (k === 'w') openRewire();
  else if (k === 'r') applyToTarget(randomState(freshSeed()));
  else if (k === 'v') void showVariants();
  else if (k === 'i') pickFile();
  else if (k === 'g') gifSearch.open();
  else if (k === 't' && !e.repeat) {
    e.preventDefault();
    void addTextLayer();
  }
  else if (e.key === ' ' && !t.matches('button')) {
    e.preventDefault();
    // With a video / GIF, Space is play / pause (as in every player); otherwise Capture.
    if (mediaTarget()) toggleMedia();
    else void saveProject(true);
  } else if ((e.key === ',' || e.key === '.') && mediaTarget()) {
    e.preventDefault();
    mediaTarget()!.player.step(e.key === ',' ? -1 : 1);
  } else if (k === 'm' && mediaTarget()) {
    const p = mediaTarget()!.player;
    if (p.kind === 'video') p.muted = !p.muted;
  }
});
function viewKey(k: string): void {
  if (k === '+' || k === '=') viewport.zoomBy(1.25);
  else if (k === '-') viewport.zoomBy(0.8);
  else if (k === '0') viewport.fit();
  else if (k === '1') viewport.zoomTo(1);
}

/** Layer / view shortcuts. Returns true if handled. */
function layerKey(e: KeyboardEvent, t: HTMLElement): boolean {
  if (['+', '=', '-', '0', '1'].includes(e.key)) {
    viewKey(e.key);
    return true;
  }
  const l = getLayer(doc, doc.active);
  if (!l) return false;
  // Knobs and other focused widgets use the arrows / Supr themselves.
  const widget = t !== document.body && t.closest('.knob, .layers, .rack, [role="slider"]');
  const step = e.shiftKey ? 10 : 1;
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (arrows[e.key] && !widget) {
    e.preventDefault();
    layersPanel.nudge(...arrows[e.key]);
    return true;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !t.closest('.knob')) {
    e.preventDefault();
    layersPanel.deleteActive();
    return true;
  }
  if (l.locked) return false;
  const act = (fn: (x: Layer) => void): boolean => {
    e.preventDefault();
    editDoc((d) => fn(getLayer(d, l.id)!), 'once');
    return true;
  };
  if (e.key === '[') return act((x) => rotateLayer(x, -90));
  if (e.key === ']') return act((x) => rotateLayer(x, 90));
  if (e.key.toLowerCase() === 'h') return act((x) => flipLayer(x, e.shiftKey ? 'v' : 'h'));
  return false;
}

window.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'b') setAB(false);
});

renderProjects();
afterChange(true, true);

/* ------------------------------ layer style clipboard ------------------------------ */
/**
 * "Style" of a layer = its look, not its content: effects (cables, knobs, stages, seed),
 * opacity and blend mode. Copied from one layer and pasted onto others (undoable).
 */
interface LayerStyle {
  fx: GlitchState;
  opacity: number;
  blend: Layer['blend'];
  from: string;
}
let styleClip: LayerStyle | null = null;
function copyStyle(id: string): void {
  const l = getLayer(doc, id);
  if (!l) return;
  styleClip = { fx: cloneState(l.fx ?? cleanFx()), opacity: l.opacity, blend: l.blend, from: l.name };
  toast(`Estilo de «${l.name}» copiado`);
}
function pasteStyle(id: string): void {
  const st = styleClip;
  const l = getLayer(doc, id);
  if (!st || !l) return;
  if (l.locked) return toast('Capa bloqueada');
  editDoc((d) => {
    const x = getLayer(d, id);
    if (!x) return;
    x.fx = cloneState(st.fx);
    x.opacity = st.opacity;
    x.blend = st.blend;
  }, 'once');
  toast(`Estilo de «${st.from}» pegado en «${l.name}»`);
}
function styleItems(id: string): MenuEntry[] {
  return [
    { label: 'Copiar estilo', icon: 'brush', keys: 'Ctrl+Alt+C', action: () => copyStyle(id) },
    { label: styleClip ? `Pegar estilo de «${styleClip.from.slice(0, 18)}»` : 'Pegar estilo', icon: 'paste', keys: 'Ctrl+Alt+V', disabled: !styleClip, action: () => pasteStyle(id) },
  ];
}
/** Menu of a row in the layers panel. */
function openRowMenu(id: string, x: number, y: number): void {
  const l = getLayer(doc, id);
  if (!l) return;
  menu.open(x, y, styleItems(id), `Capa ${l.name}`);
}

/* ------------------------------ context menu (viewer) ------------------------------ */
const menu = new ContextMenu();

/* ------------------------------ export (button ▾, formats, options) ------------------------------ */
const exportUi = new ExportUI(
  {
    engine,
    provider,
    players,
    blobFor: (k) => {
      const b = blobSources.get(k);
      return b instanceof Blob ? b : undefined;
    },
    doc: () => doc,
    docName: () => project?.name ?? doc.layers.find((l) => !l.text)?.name ?? 'glitch',
    seed: () => cur().seed,
    toast,
    menu,
    pauseMedia: () => players.forEach((p) => p.pause()),
  },
  $<HTMLButtonElement>('btn-export'),
  $<HTMLButtonElement>('btn-export-menu'),
);
$('progress-cancel').addEventListener('click', () => exportUi.cancel());

/* ------------------------------ GIF search (GifCities · Internet Archive) ------------------------------ */
// Nothing is requested until the user searches inside the panel.
const gifSearch = new GifSearchPanel({ toast, importFile: (f) => importFiles([f]) });
document.body.append(gifSearch.el);
$('btn-gifsearch').addEventListener('click', () => gifSearch.open());
function layerEdit(id: string, fn: (l: Layer) => void): void {
  editDoc((d) => {
    const l = getLayer(d, id);
    if (l && !l.locked) fn(l);
  }, 'once');
}
function openLayerMenu(id: string | null, x: number, y: number): void {
  textEditor.close();
  const l = getLayer(doc, id);
  const pasteItem = { label: 'Pegar capa', icon: 'paste', keys: 'Ctrl+V', disabled: !clip, action: pasteClip };
  const items: MenuEntry[] = l
    ? [
        { label: 'Girar 90° a la izquierda', icon: 'rot-l', keys: '[', action: () => layerEdit(l.id, (x) => rotateLayer(x, -90)) },
        { label: 'Girar 90° a la derecha', icon: 'rot-r', keys: ']', action: () => layerEdit(l.id, (x) => rotateLayer(x, 90)) },
        { label: 'Girar 180°', icon: 'more', action: () => layerEdit(l.id, (x) => rotateLayer(x, 180)) },
        { label: 'Enderezar (0°)', icon: 'rot-0', disabled: l.rotation === 0, action: () => layerEdit(l.id, (x) => (x.rotation = 0)) },
        'sep',
        { label: 'Espejo horizontal', icon: 'flip-h', keys: 'H', action: () => layerEdit(l.id, (x) => flipLayer(x, 'h')) },
        { label: 'Espejo vertical', icon: 'flip-v', keys: 'Shift+H', action: () => layerEdit(l.id, (x) => flipLayer(x, 'v')) },
        'sep',
        ...styleItems(l.id),
        'sep',
        { label: 'Copiar capa', icon: 'copy', keys: 'Ctrl+C', action: () => copyLayer(false) },
        { label: 'Cortar capa', icon: 'cut', keys: 'Ctrl+X', action: () => copyLayer(true) },
        pasteItem,
        { label: 'Duplicar', icon: 'duplicate', keys: 'Ctrl+J', action: () => layersPanel.duplicateActive() },
        { label: 'Renombrar', icon: 'pencil', keys: 'F2', action: () => (showTab('layers'), layersPanel.renameActive()) },
        'sep',
        { label: 'Eliminar capa', icon: 'trash', keys: 'Supr', danger: true, action: () => layersPanel.deleteActive() },
      ]
    : [pasteItem, 'sep', { label: 'Añadir imágenes', icon: 'image', keys: 'I', action: pickFile }, { label: 'Añadir texto', icon: 'type', keys: 'T', action: () => void addTextLayer() }];
  menu.open(x, y, items, l ? `Capa ${l.name}` : 'Visor');
}

/* ------------------------------ session restore ------------------------------ */
/**
 * Loads the bitmaps and fonts a stored document needs. Image layers whose bytes are gone are
 * dropped (and counted in `missing`) instead of breaking the whole document.
 */
async function hydrate(d: DocState, blobFor: (key: string) => Promise<Blob | undefined> | Blob | undefined): Promise<{ doc: DocState; missing: number }> {
  const out: Layer[] = [];
  let missing = 0;
  for (const l of d.layers) {
    if (l.text) {
      await ensureFont(l.text);
      refreshText(l);
      out.push(l);
      continue;
    }
    if (l.media && !players.has(l.src)) {
      // Video / GIF: the stored file reopens through an object URL (never read whole).
      const b = await blobFor(l.src);
      if (!b) {
        missing++;
        continue;
      }
      try {
        const p = await openPlayer(b, l.media.kind);
        players.set(l.src, p);
        if (!bitmaps.has(l.src)) await registerBitmap(l.src, await createImageBitmap(p.poster), l.name);
        blobSources.set(l.src, b);
        void p.play();
      } catch (err) {
        toast(`No se pudo reabrir «${l.name}»: ${(err as Error).message}`);
        missing++;
        continue;
      }
      out.push(l);
      continue;
    }
    if (!bitmaps.has(l.src)) {
      const b = await blobFor(l.src);
      if (!b) {
        missing++;
        continue;
      }
      try {
        await registerBitmap(l.src, await createImageBitmap(b, { imageOrientation: 'from-image' }), l.name);
        blobSources.set(l.src, b);
      } catch {
        missing++;
        continue;
      }
    } else if (!blobSources.has(l.src)) {
      const b = await blobFor(l.src);
      if (b) blobSources.set(l.src, b);
    }
    out.push(l);
  }
  d.layers = out;
  if (d.active !== null && !out.some((l) => l.id === d.active)) d.active = out[out.length - 1]?.id ?? null;
  return { doc: d, missing };
}

/** Gallery shots of previous versions become projects (kept in the session until that works). */
async function migrateShots(raw: unknown, blobs: Map<string, Blob>): Promise<void> {
  const list = Array.isArray(raw) ? raw : [];
  const keep: { doc: DocState; thumb: string }[] = [];
  let n = 0;
  for (const sh of list.slice().reverse()) {
    const thumb = typeof sh?.thumb === 'string' && sh.thumb.startsWith('data:image/') ? sh.thumb : '';
    const d = sanitizeDoc(sh?.doc);
    if (!d.layers.length) continue;
    const now = Date.now() + n;
    const rec: ProjectRecord = { v: 1, id: newId('P'), name: `Captura ${++n}`, created: now, updated: now, thumb, layers: d.layers.length, doc: d, fonts: docFonts(d) };
    try {
      await projects.save(rec, (k) => blobs.get(k), (f) => fontBlobs.get(f));
    } catch {
      keep.push({ doc: d, thumb });
    }
  }
  legacyShots = keep;
  if (n > keep.length) toast(`${n - keep.length} capturas antiguas convertidas en proyectos`);
}

async function restoreSession(): Promise<void> {
  try {
    const r = await session.load();
    if (r) {
      for (const [family, blob] of r.fonts) {
        try {
          const face = new FontFace(family, await blob.arrayBuffer());
          await face.load();
          document.fonts.add(face);
          if (!fonts.files.includes(family)) fonts.files.push(family);
          fontBlobs.set(family, blob);
        } catch {
          /* unreadable font: text falls back */
        }
      }
      fonts.version++;
      const p = r.data.project;
      if (p && typeof p.id === 'string' && typeof p.name === 'string') project = { id: p.id, name: p.name.slice(0, 80) };
      if (project) {
        // Unsaved-changes dot: compare with what the project holds.
        const rec = await projects.get(project.id).catch(() => null);
        if (rec) {
          project.name = rec.name;
          savedJson = JSON.stringify(rec.doc);
        } else project = null;
      }
      await migrateShots(r.data.shots, r.blobs);
      const { doc: d } = await hydrate(sanitizeDoc(r.data.doc), (k) => r.blobs.get(k));
      if (d.layers.length) {
        doc = d;
        afterChange(true, true);
        viewport.fit();
        toast(`Sesión recuperada · ${d.layers.length} capa${d.layers.length === 1 ? '' : 's'}`);
      }
    }
  } catch (e) {
    console.warn('No se pudo recuperar la sesión', e);
  }
  await refreshProjects();
  syncProjectLabel();
  session.ready = true;
  session.onError = (m) => toast(`No se pudo guardar la sesión: ${m}`);
  // Ask the browser not to evict the stored session under storage pressure.
  void navigator.storage?.persist?.().catch(() => false);
  session.schedule();
}
void restoreSession();
window.addEventListener('pagehide', () => void session.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void session.flush();
});

/** New empty document (undoable; the gallery is kept). */
$('btn-new').addEventListener('click', () => {
  if (!doc.layers.length) return;
  history.push(cloneDoc(doc));
  doc = { ...emptyDoc(), bg: doc.bg };
  project = null;
  savedJson = '';
  afterChange(true, true);
  toast('Documento nuevo (Ctrl+Z lo deshace)');
});

/* ------------------------------ debug / test API ------------------------------ */
async function hashPixels(img: ImageData): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', img.data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
Object.assign(window, {
  __glitch: {
    /** Export: defaults, a folder to write to (tests pass an OPFS directory instead of the native picker). */
    exportDefaults: () => exportUi.defaults,
    setExportDefaults: (s: unknown) => exportUi.saveDefaults(sanitizeSettings(s)),
    setExportFolder: (h: FileSystemDirectoryHandle | null) => exportUi.setFolder(h),
    /** Parses an exported video (base64) with Mediabunny: container, codecs, size, duration, frame rate. */
    inspectVideo: async (b64: string) => {
      const mb = await import('mediabunny');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
      try {
        const v = await input.getPrimaryVideoTrack();
        const a = await input.getPrimaryAudioTrack();
        const stats = v ? await v.computePacketStats() : null;
        return {
          format: (await input.getFormat()).name, codec: v?.codec ?? null, w: v?.displayWidth ?? 0, h: v?.displayHeight ?? 0,
          duration: await input.computeDuration(), fps: stats?.averagePacketRate ?? 0, frames: stats?.packetCount ?? 0, audio: a?.codec ?? null,
        };
      } finally {
        input.dispose();
      }
    },
    /** Transport state of the media bar's player (null without video / GIF). */
    media: () => {
      const t = mediaTarget();
      if (!t) return null;
      const p = t.player;
      return {
        kind: p.kind, decoder: p instanceof GifPlayer ? p.decoder : 'video', w: p.w, h: p.h, duration: p.duration, time: p.time,
        frame: p.frame, fps: p.fps, stamp: p.stamp, playing: p.playing, speed: p.speed, loop: p.loop, volume: p.volume,
        muted: p.muted, hasAudio: p.hasAudio, animate: !!t.layer.media?.animate,
      };
    },
    /** Preview renders since load (fps = delta / seconds). */
    presents: () => presents,
    /** Renders one "new frame" now (texture re-upload + every pass) and waits for the GPU: per-frame cost. */
    renderOnce: () => {
      const t = mediaTarget();
      if (t) (t.player as { stamp: number }).stamp++;
      engine.renderPreview(doc, null, ctx, false);
      const gl = engine.gl.gl;
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    },
    players: () => players.size,
    /** Size of the still the newest project holds for its first layer (capture = full resolution). */
    newestProjectStill: async () => {
      const all = await projects.list();
      const newest = all.sort((a, b) => b.updated - a.updated)[0];
      const rec = newest ? await projects.get(newest.id) : null;
      const l = rec?.doc.layers.find((x) => !x.text);
      const bm = l ? (bitmaps.get(l.src)?.full as ImageBitmap | undefined) : undefined;
      return l ? { w: bm?.width ?? 0, h: bm?.height ?? 0, media: !!l.media, layerW: l.w, layerH: l.h } : null;
    },
    loadSample: async () => {
      await addImageLayer(await makeSampleImage(), 'Carta de ajuste', { replace: true });
    },
    addSampleLayer: async (w?: number, h?: number) => (await addImageLayer(await makeSampleImage(w, h), 'Muestra')).id,
    getDoc: () => cloneDoc(doc),
    editText: (id: string, patch: Partial<TextProps>) => editText(id, patch, 'once'),
    setDoc: (d: DocState) => editDoc((x) => Object.assign(x, cloneDoc(d)), 'once'),
    view: () => ({ zoom: viewport.zoom, x: viewport.stage.x(), y: viewport.stage.y(), preview: [engine.previewW, engine.previewH] }),
    getState: () => cloneState(cur()),
    setState: (s: unknown) => applyToTarget(sanitizeState(s)),
    hash: async (s?: unknown) => hashPixels(await engine.renderPreviewPixels(s ? withTarget(sanitizeState(s)) : doc, null)),
    /** Raw preview pixels as base64 (tests compare renders across browser sessions). */
    pixels: async () => {
      const px = (await engine.renderPreviewPixels(doc, null)).data;
      let bin = '';
      for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    session: () => session,
    gpuMemory: () => engine.memory,
    exportSize: async (type: 'image/png' | 'image/jpeg' = 'image/png') => {
      const r = await engine.exportFull(doc, null, type);
      return { w: r.w, h: r.h, bytes: r.blob.size, original: [doc.w, doc.h] };
    },
    presetRoundTrip: () => parsePresetFile(JSON.stringify(toPresetFile('t', cur()))).state,
    saveProject: (asNew = false) => saveProject(asNew),
    openProject: (id: string) => openProject(id),
    projects: () => projects.list(),
    currentProject: () => (project ? { ...project, dirty: snapJson() !== savedJson } : null),
    styleClip: () => (styleClip ? { ...styleClip } : null),
    clearProjects: async () => {
      for (const p of await projects.list()) await projects.remove(p.id);
      project = null;
      await refreshProjects();
    },
  },
});
