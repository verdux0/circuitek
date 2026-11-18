/**
 * Export UI: split button "Exportar · PNG ▾", the format menu and the options dialog.
 * The main part exports at once with the saved defaults; ▾ lists every format (the ones that do
 * not apply stay visible, disabled, with the reason) and opens the options dialog.
 */
import type { DocState } from '../doc';
import type { ContextMenu, MenuEntry } from './contextmenu';
import { ico } from './icons';
import {
  DEFAULT_TEMPLATE, EXT, GIF_EXACT_FPS, defaultSettings, estimateGifBytes, fmtBytes, mp4Bitrate, renderFileName, sanitizeSettings,
  type ExportFormat, type ExportSettings,
} from '../export/settings';
import {
  Cancelled, audioStatus, docInfo, exportGif, exportStill, exportVideo, planGif, planVideo, videoCaps,
  type ExportHost, type VideoCaps,
} from '../export/exporter';
import { DownloadSink, FolderSink, canPickFolder, ensurePermission, pickFolder, rememberFolder, savedFolder, type SaveSink } from '../export/save';

export interface ExportUiHost extends ExportHost {
  doc(): DocState;
  /** {nombre}: project name, else the main layer's name. */
  docName(): string;
  /** {seed}: seed of the layer the effects editor targets. */
  seed(): number;
  toast(msg: string): void;
  menu: ContextMenu;
  /** Pauses every video / GIF (exports render their own frames). */
  pauseMedia(): void;
}

const STORE_KEY = 'glitch-editor:export';
const LABEL: Record<ExportFormat, string> = { png: 'PNG', jpg: 'JPG', gif: 'GIF', mp4: 'MP4' };
/** Hard cap for animated exports (frames). */
export const MAX_FRAMES = 3600;
const WARN_FRAMES = 1500;
const WARN_GIF_BYTES = 40e6;

function loadDefaults(): ExportSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtNum = (v: number, d = 1): string => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('es-ES');

export class ExportUI {
  /** Saved defaults (what the main button uses). */
  defaults: ExportSettings = loadDefaults();
  private folder: FileSystemDirectoryHandle | null = null;
  private caps: VideoCaps | null = null;
  private running: AbortController | null = null;
  private dialog: HTMLElement | null = null;

  constructor(private host: ExportUiHost, private main: HTMLButtonElement, private arrow: HTMLButtonElement) {
    void savedFolder().then((h) => (this.folder = h));
    void videoCaps().then((c) => (this.caps = c)).catch(() => (this.caps = { container: null, reason: 'No se pudo comprobar el codificador de vídeo.' }));
    main.addEventListener('click', () => void this.runDefault());
    arrow.addEventListener('click', () => this.openMenu());
    arrow.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.openMenu();
      }
    });
    this.syncMain();
  }

  get busy(): boolean {
    return !!this.running;
  }
  get dialogOpen(): boolean {
    return !!this.dialog;
  }
  /** Remembers `h` as the export folder (tests use an OPFS directory instead of the picker). */
  async setFolder(h: FileSystemDirectoryHandle | null): Promise<void> {
    this.folder = h;
    await rememberFolder(h);
  }

  private syncMain(): void {
    const f = this.defaults.format;
    this.main.innerHTML = `${ico('download')}<span>Exportar</span><small>${LABEL[f]}</small>`;
    this.main.setAttribute('aria-label', `Exportar como ${LABEL[f]} (predeterminado)`);
    this.main.title = `Exportar como ${LABEL[f]} con los ajustes predeterminados · ▾ para otros formatos y opciones`;
  }

  /** null = available; otherwise why not (shown next to the disabled entry). */
  why(format: ExportFormat): string | null {
    const doc = this.host.doc();
    if (!doc.layers.length) return 'Importa una imagen, GIF o vídeo primero';
    if (format === 'png' || format === 'jpg') return null;
    const info = docInfo(doc, this.host.players);
    if (!info.media && !info.generated) return 'Imagen fija: activa «Glitch animado» (Efectos) para exportar animación';
    if (format === 'mp4' && this.caps && !this.caps.container) return this.caps.reason;
    return null;
  }

  private formatLabel(f: ExportFormat): string {
    if (f === 'mp4' && this.caps?.container === 'webm') return 'MP4 → WebM (VP9)';
    return LABEL[f];
  }

  openMenu(): void {
    if (this.running) return;
    const r = this.arrow.getBoundingClientRect();
    const desc: Record<ExportFormat, string> = { png: 'Imagen sin pérdida', jpg: 'Imagen comprimida', gif: 'Animación en bucle', mp4: 'Vídeo H.264' };
    const entries: MenuEntry[] = (['png', 'jpg', 'gif', 'mp4'] as ExportFormat[]).map((f) => {
      const why = this.why(f);
      return {
        label: `<span class="ex-mi"><b>${this.formatLabel(f)}</b><small>${esc(why ?? desc[f])}</small></span>`,
        icon: f === 'gif' || f === 'mp4' ? 'variants' : 'image',
        disabled: !!why,
        action: () => this.openDialog(f),
      };
    });
    this.arrow.setAttribute('aria-expanded', 'true');
    this.host.menu.open(r.right - 260, r.bottom, entries, 'Formatos de exportación');
    this.host.menu.onClosed = () => this.arrow.setAttribute('aria-expanded', 'false');
  }

  /* ------------------------------------ running ------------------------------------ */

  private nameFor(s: ExportSettings, w: number, h: number): string {
    return renderFileName(s.template, { name: this.host.docName(), seed: this.host.seed(), date: new Date(), format: EXT[s.format], width: w, height: h }, s.format === 'mp4' && this.caps?.container === 'webm' ? 'webm' : EXT[s.format]);
  }

  /** Output size the settings will produce (for the name preview and the notes). */
  private outSize(s: ExportSettings): [number, number] {
    const doc = this.host.doc();
    const info = docInfo(doc, this.host.players);
    if (s.format === 'gif') {
      const p = planGif(doc, info, s);
      return [p.w, p.h];
    }
    if (s.format === 'mp4') {
      const p = planVideo(doc, info, s);
      return [p.w, p.h];
    }
    const k = s.format === 'jpg' ? s.jpg.scale : s.png.scale;
    return [Math.round(doc.w * k), Math.round(doc.h * k)];
  }

  /** Folder sink when chosen and allowed, else a download. Must start inside a click (permission prompt). */
  private async sinkFor(s: ExportSettings, name: string): Promise<SaveSink> {
    if (s.save === 'folder' && canPickFolder()) {
      if (!this.folder) this.folder = await pickFolder();
      if (this.folder && (await ensurePermission(this.folder))) return FolderSink.open(this.folder, name);
      this.host.toast('Sin permiso para la carpeta: se descarga con el navegador');
    }
    return new DownloadSink(name);
  }

  private async run(s: ExportSettings, ui: { progress(f: number, msg: string): void }): Promise<boolean> {
    const why = this.why(s.format);
    if (why) {
      this.host.toast(why);
      return false;
    }
    const doc = this.host.doc();
    const [w, h] = this.outSize(s);
    const ac = new AbortController();
    this.running = ac;
    this.main.disabled = this.arrow.disabled = true;
    let sink: SaveSink | null = null;
    try {
      sink = await this.sinkFor(s, this.nameFor(s, w, h));
      const animated = s.format === 'gif' || s.format === 'mp4';
      if (animated) this.host.pauseMedia();
      let msg: string;
      if (s.format === 'png' || s.format === 'jpg') {
        const r = await exportStill(this.host, doc, s, sink, ui.progress, ac.signal);
        msg = `${sink.name} · ${r.w}×${r.h} → ${r.where}`;
      } else if (s.format === 'gif') {
        const r = await exportGif(this.host, doc, s, sink, ui.progress, ac.signal);
        msg = `${sink.name} · ${r.w}×${r.h} · ${r.frames} fotogramas → ${r.where}`;
      } else {
        const caps = this.caps ?? (await videoCaps());
        const r = await exportVideo(this.host, doc, s, sink as SaveSink & { setWhole?(b: ArrayBuffer): void }, caps, ui.progress, ac.signal);
        msg = `${sink.name} · ${r.w}×${r.h} · ${r.frames} fotogramas · audio: ${r.audio} → ${r.where}`;
      }
      this.host.toast(`Exportado ${msg}`);
      return true;
    } catch (err) {
      await sink?.abort();
      if (err instanceof Cancelled || ac.signal.aborted) this.host.toast('Exportación cancelada: no se ha guardado nada');
      else this.host.toast(`No se pudo exportar: ${(err as Error).message}`);
      return false;
    } finally {
      this.running = null;
      this.main.disabled = this.arrow.disabled = false;
    }
  }

  cancel(): void {
    this.running?.abort();
  }

  /** Main button: the default format and settings, no dialog. */
  async runDefault(): Promise<boolean> {
    if (this.running) return false;
    const ov = document.getElementById('progress')!;
    const msg = document.getElementById('progress-msg')!;
    const bar = document.getElementById('progress-bar') as HTMLProgressElement | null;
    ov.hidden = false;
    try {
      return await this.run(this.defaults, {
        progress: (f, m) => {
          msg.textContent = `${LABEL[this.defaults.format]} · ${m}…`;
          if (bar) bar.value = f;
        },
      });
    } finally {
      ov.hidden = true;
      if (bar) bar.value = 0;
    }
  }

  /* ------------------------------------ dialog ------------------------------------ */

  openDialog(format: ExportFormat): void {
    this.closeDialog();
    const s: ExportSettings = sanitizeSettings({ ...this.defaults, format });
    const info = docInfo(this.host.doc(), this.host.players);
    const el = document.createElement('div');
    el.className = 'sheet-backdrop export-backdrop';
    el.innerHTML = this.dialogHtml(s, info.media);
    document.body.append(el);
    this.dialog = el;
    const $ = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    const go = $<HTMLButtonElement>('#ex-go');
    const cancel = $<HTMLButtonElement>('#ex-cancel');
    const note = $('#ex-note');
    const nameOut = $('#ex-name');

    /** Reads every field into `s` and refreshes the preview and notes. */
    const read = (): void => {
      const num = (id: string, d: number) => {
        const v = Number(el.querySelector<HTMLInputElement>(`#${id}`)?.value);
        return Number.isFinite(v) ? v : d;
      };
      const val = (id: string) => el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value;
      const chk = (id: string) => !!el.querySelector<HTMLInputElement>(`#${id}`)?.checked;
      s.template = $<HTMLInputElement>('#ex-tpl').value || DEFAULT_TEMPLATE;
      s.save = el.querySelector<HTMLInputElement>('input[name="ex-save"]:checked')?.value === 'folder' ? 'folder' : 'download';
      if (format === 'png') s.png.scale = num('ex-scale', 1);
      if (format === 'jpg') {
        s.jpg.scale = num('ex-scale', 1);
        s.jpg.quality = num('ex-quality', 92);
      }
      if (format === 'gif') {
        Object.assign(s.gif, {
          maxWidth: num('ex-gw', s.gif.maxWidth), fps: num('ex-gfps', s.gif.fps), colors: num('ex-colors', s.gif.colors),
          dither: val('ex-dither'), duration: num('ex-dur', s.gif.duration), repeat: num('ex-repeat', 0),
          loop: el.querySelector<HTMLInputElement>('input[name="ex-loop"]:checked')?.value ?? s.gif.loop,
          overlap: num('ex-overlap', s.gif.overlap * 100) / 100, pulse: num('ex-pulse', 0), pulseCycles: num('ex-cycles', 1),
        });
      }
      if (format === 'mp4') {
        Object.assign(s.mp4, {
          height: num('ex-mh', 0), fps: num('ex-mfps', 30), quality: val('ex-mq'), start: num('ex-start', 0), end: num('ex-end', 0),
          duration: num('ex-mdur', s.mp4.duration), audio: chk('ex-audio'), pulse: num('ex-pulse', 0), pulseCycles: num('ex-cycles', 1),
        });
      }
      Object.assign(s, sanitizeSettings(s));
      const ov = el.querySelector<HTMLElement>('.ex-overlap-row');
      if (ov) ov.hidden = s.gif.loop !== 'crossfade';
      const q = el.querySelector('#ex-quality-v');
      if (q) q.textContent = String(s.jpg.quality);
      const c = el.querySelector('#ex-colors-v');
      if (c) c.textContent = String(s.gif.colors);
      const [w, h] = this.outSize(s);
      nameOut.textContent = this.nameFor(s, w, h);
      note.innerHTML = this.notes(s, info).map((n) => `<span class="${n.warn ? 'ex-warn' : ''}">${n.text}</span>`).join('');
      go.disabled = this.notes(s, info).some((n) => n.block);
      const folderName = el.querySelector('#ex-folder-name');
      if (folderName) folderName.textContent = this.folder ? `«${this.folder.name}»` : 'sin elegir';
    };
    el.addEventListener('input', read);
    el.addEventListener('change', read);
    read();

    if (format === 'mp4') {
      const a = $('#ex-audio-why');
      const box = el.querySelector<HTMLInputElement>('#ex-audio');
      void (async () => {
        const caps = this.caps ?? (await videoCaps());
        const st = caps.container ? await audioStatus(this.host.doc(), this.host, caps.container) : { ok: false, reason: caps.reason };
        a.textContent = st.ok ? `Se incluye el audio del vídeo (${st.codec?.toUpperCase()}).` : `${st.reason}`;
        if (box) {
          box.disabled = !st.ok;
          if (!st.ok) box.checked = false;
        }
        read();
      })();
    }

    el.querySelector('#ex-pick')?.addEventListener('click', async () => {
      const h = await pickFolder();
      if (h) {
        this.folder = h;
        await rememberFolder(h);
        el.querySelector<HTMLInputElement>('input[name="ex-save"][value="folder"]')!.checked = true;
      }
      read();
    });
    el.querySelector('#ex-reset')?.addEventListener('click', async () => {
      this.defaults = defaultSettings();
      try {
        localStorage.removeItem(STORE_KEY);
      } catch {
        /* ignore */
      }
      this.folder = null;
      await rememberFolder(null);
      this.syncMain();
      this.host.toast('Exportación: ajustes de fábrica restablecidos');
      this.openDialog(format);
    });
    const close = () => {
      if (this.running) return this.cancel();
      this.closeDialog();
    };
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === el || t.closest('[data-act="close"]')) close();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    cancel.addEventListener('click', close);
    go.addEventListener('click', async () => {
      read();
      const def = $<HTMLInputElement>('#ex-default').checked;
      el.classList.add('running');
      const bar = $<HTMLProgressElement>('#ex-bar');
      const msg = $('#ex-msg');
      cancel.textContent = 'Cancelar exportación';
      el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('.ex-body input, .ex-body select, .ex-body button, #ex-go').forEach((x) => (x.disabled = true));
      const ok = await this.run(s, { progress: (f, m) => { bar.value = f; msg.textContent = m; } });
      if (ok && def) this.saveDefaults(s);
      if (ok) this.closeDialog();
      else if (this.dialog === el) {
        el.classList.remove('running');
        cancel.textContent = 'Cerrar';
        el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('.ex-body input, .ex-body select, .ex-body button, #ex-go').forEach((x) => (x.disabled = false));
        read();
      }
    });
    $<HTMLElement>('.ex-body').querySelector<HTMLElement>('input, select')?.focus();
  }

  saveDefaults(s: ExportSettings): void {
    this.defaults = sanitizeSettings(s);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.defaults));
    } catch {
      /* storage unavailable: defaults last for this session */
    }
    this.syncMain();
  }

  closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }

  /** Lines under the options: what will be produced, and warnings. `block` disables Export. */
  private notes(s: ExportSettings, info: ReturnType<typeof docInfo>): { text: string; warn?: boolean; block?: boolean }[] {
    const doc = this.host.doc();
    const out: { text: string; warn?: boolean; block?: boolean }[] = [];
    const [w, h] = this.outSize(s);
    if (s.format === 'png' || s.format === 'jpg') {
      out.push({ text: `${w}×${h} px${info.media ? ' · el fotograma actual' : ''}` });
      if (w * h > 48e6) out.push({ text: 'Más de 48 MP: se limitará al máximo de la GPU.', warn: true });
    } else if (s.format === 'gif') {
      const p = planGif(doc, info, s);
      const cs = p.delays[0];
      const est = estimateGifBytes(p.w, p.h, p.frames, s.gif.colors, s.gif.dither);
      out.push({ text: `${p.w}×${p.h} · ${p.frames} fotogramas · ${fmtNum(p.fps)} fps · ≈ ${fmtBytes(est)}` });
      if (p.mode === 'generated') out.push({ text: `Bucle perfecto: ruido${s.gif.pulse ? ' y pulso' : ''} periódicos en ${p.frames} fotogramas.` });
      else out.push({ text: { crossfade: 'Bucle: fundido cruzado del final con el principio.', pingpong: 'Bucle: ida y vuelta.', trim: 'Bucle: se recorta donde el vídeo mejor enlaza con el principio.' }[p.mode] });
      if (p.clamped) out.push({ text: 'Los GIF no van por encima de 50 fps (retardo mínimo de 2 centésimas): se usa 50.', warn: true });
      else if (p.uneven) out.push({ text: `${fmtNum(s.gif.fps)} fps no cuadra con centésimas: retardos de ${Math.min(...p.delays)} y ${Math.max(...p.delays)} cs (media exacta). Exactos: ${GIF_EXACT_FPS.map((f) => fmtNum(f)).join(', ')} fps.`, warn: true });
      else out.push({ text: `Retardo de ${cs} cs por fotograma (exacto).` });
      if (info.media && s.gif.duration > info.duration + 1e-6) out.push({ text: `El vídeo dura ${fmtNum(info.duration)} s: el GIF también.`, warn: true });
      if (est > WARN_GIF_BYTES) out.push({ text: `GIF enorme (≈ ${fmtBytes(est)}): baja el ancho, los fps, la duración o los colores.`, warn: true });
      if (p.frames > WARN_FRAMES) out.push({ text: `${p.frames} fotogramas: tardará y ocupará mucho.`, warn: true });
      if (p.frames > MAX_FRAMES) out.push({ text: `Máximo ${MAX_FRAMES} fotogramas.`, warn: true, block: true });
    } else {
      const p = planVideo(doc, info, s);
      const codec = this.caps?.container === 'webm' ? 'VP9 (WebM)' : 'H.264';
      out.push({ text: `${p.w}×${p.h} · ${p.fps} fps · ${fmtNum(p.end - p.start)} s · ${p.frames} fotogramas · ${codec} ≈ ${fmtNum(mp4Bitrate(p.w, p.h, p.fps, s.mp4.quality) / 1e6)} Mb/s` });
      if (this.caps?.container === 'webm') out.push({ text: this.caps.reason, warn: true });
      if (p.frames > WARN_FRAMES) out.push({ text: `${p.frames} fotogramas: tardará (cada fotograma pasa por todo el pipeline).`, warn: true });
      if (p.frames > MAX_FRAMES) out.push({ text: `Máximo ${MAX_FRAMES} fotogramas: acorta el rango o baja los fps.`, warn: true, block: true });
    }
    return out;
  }

  private dialogHtml(s: ExportSettings, media: boolean): string {
    const f = s.format;
    const scaleSel = (v: number) => `<label class="ex-field"><span>Escala</span><select id="ex-scale">${[0.25, 0.5, 1, 1.5, 2, 3, 4].map((k) => `<option value="${k}"${k === v ? ' selected' : ''}>${k * 100} %</option>`).join('')}</select></label>`;
    const pulse = (p: { pulse: number; pulseCycles: number }) => media ? '' : `
      <label class="ex-field"><span>Pulso del EFFECT (±)</span><input id="ex-pulse" type="number" min="0" max="50" step="1" value="${p.pulse}" /></label>
      <label class="ex-field"><span>Ciclos por bucle</span><input id="ex-cycles" type="number" min="1" max="8" step="1" value="${p.pulseCycles}" /></label>`;
    let opts = '';
    if (f === 'png') opts = scaleSel(s.png.scale);
    if (f === 'jpg') opts = `${scaleSel(s.jpg.scale)}
      <label class="ex-field"><span>Calidad <output id="ex-quality-v">${s.jpg.quality}</output></span><input id="ex-quality" type="range" min="1" max="100" step="1" value="${s.jpg.quality}" /></label>`;
    if (f === 'gif') {
      const g = s.gif;
      opts = `
      <label class="ex-field"><span>Ancho máximo (px)</span><input id="ex-gw" type="number" min="16" max="2048" step="1" value="${g.maxWidth}" /></label>
      <label class="ex-field"><span>fps</span><input id="ex-gfps" type="number" min="1" max="50" step="any" value="${fmtNum(g.fps, 3).replace(',', '.')}" list="ex-fps-list" /></label>
      <datalist id="ex-fps-list">${GIF_EXACT_FPS.map((v) => `<option value="${Math.round(v * 1000) / 1000}">`).join('')}</datalist>
      <label class="ex-field"><span>Colores <output id="ex-colors-v">${g.colors}</output></span><input id="ex-colors" type="range" min="2" max="256" step="1" value="${g.colors}" /></label>
      <label class="ex-field"><span>Dithering</span><select id="ex-dither">
        <option value="bayer"${g.dither === 'bayer' ? ' selected' : ''}>Ordenado (Bayer) · estable en animación</option>
        <option value="floyd"${g.dither === 'floyd' ? ' selected' : ''}>Floyd–Steinberg · más suave, «hierve»</option>
        <option value="none"${g.dither === 'none' ? ' selected' : ''}>Ninguno · bandas, archivo menor</option></select></label>
      <label class="ex-field"><span>Duración (s)</span><input id="ex-dur" type="number" min="0.2" max="60" step="0.1" value="${g.duration}" /></label>
      <label class="ex-field"><span>Repeticiones (0 = infinito)</span><input id="ex-repeat" type="number" min="0" max="65535" step="1" value="${g.repeat}" /></label>
      ${media ? `<fieldset class="ex-loop"><legend>Bucle perfecto con vídeo</legend>
        <label><input type="radio" name="ex-loop" value="crossfade"${g.loop === 'crossfade' ? ' checked' : ''} /> Fundido cruzado <small>(predeterminado: vale para cualquier vídeo y no invierte el movimiento)</small></label>
        <label><input type="radio" name="ex-loop" value="pingpong"${g.loop === 'pingpong' ? ' checked' : ''} /> Ida y vuelta</label>
        <label><input type="radio" name="ex-loop" value="trim"${g.loop === 'trim' ? ' checked' : ''} /> Recortar al bucle más cercano</label>
        <label class="ex-field ex-overlap-row"><span>Solape del fundido (%)</span><input id="ex-overlap" type="number" min="5" max="50" step="1" value="${Math.round(g.overlap * 100)}" /></label>
      </fieldset>` : ''}
      ${pulse(g)}`;
    }
    if (f === 'mp4') {
      const m = s.mp4;
      opts = `
      <label class="ex-field"><span>Resolución</span><select id="ex-mh">${[[0, 'Original'], [2160, '2160p'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']].map(([v, l]) => `<option value="${v}"${v === m.height ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="ex-field"><span>fps</span><select id="ex-mfps">${[12, 15, 24, 25, 30, 50, 60].map((v) => `<option value="${v}"${v === m.fps ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="ex-field"><span>Calidad</span><select id="ex-mq">${[['low', 'Baja'], ['medium', 'Media'], ['high', 'Alta']].map(([v, l]) => `<option value="${v}"${v === m.quality ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${media ? `<label class="ex-field"><span>Desde (s)</span><input id="ex-start" type="number" min="0" step="0.1" value="${m.start}" /></label>
      <label class="ex-field"><span>Hasta (s, 0 = final)</span><input id="ex-end" type="number" min="0" step="0.1" value="${m.end}" /></label>
      <label class="ex-check"><input id="ex-audio" type="checkbox"${m.audio ? ' checked' : ''} /> Audio <small id="ex-audio-why">comprobando…</small></label>`
        : `<label class="ex-field"><span>Duración (s)</span><input id="ex-mdur" type="number" min="0.5" max="120" step="0.5" value="${m.duration}" /></label>
      <p class="ex-small" id="ex-audio-why">Animación generada: sin audio.</p>`}
      ${pulse(m)}`;
    }
    const fsa = canPickFolder();
    return `
      <section class="sheet export-sheet" role="dialog" aria-modal="true" aria-labelledby="ex-title">
        <header class="sheet-head">
          <h2 id="ex-title">Exportar ${this.formatLabel(f)}</h2>
          <button class="hw-btn icon sheet-close" data-act="close" aria-label="Cerrar" title="Cerrar (Esc)">${ico('close')}</button>
        </header>
        <div class="ex-body">
          <fieldset class="ex-opts"><legend>Propiedades</legend>${opts}</fieldset>
          <p class="ex-note" id="ex-note" aria-live="polite"></p>
          <fieldset class="ex-file"><legend>Archivo</legend>
            <label class="ex-field ex-wide"><span>Nombre</span><input id="ex-tpl" type="text" spellcheck="false" value="${esc(s.template)}" aria-describedby="ex-tokens" /></label>
            <p class="ex-preview">→ <output id="ex-name" aria-live="polite"></output></p>
            <p class="ex-small" id="ex-tokens">Variables: {nombre} {seed} {fecha} {hora} {formato} {ancho} {alto}</p>
            ${fsa ? `<div class="ex-save" role="radiogroup" aria-label="Ubicación">
              <label><input type="radio" name="ex-save" value="download"${s.save !== 'folder' ? ' checked' : ''} /> Descargas del navegador</label>
              <label><input type="radio" name="ex-save" value="folder"${s.save === 'folder' ? ' checked' : ''} /> Carpeta <b id="ex-folder-name"></b></label>
              <button type="button" class="hw-btn hw-btn-sm" id="ex-pick">Elegir carpeta…</button>
            </div>` : `<p class="ex-warn ex-nofsa">Este navegador no deja elegir carpeta: el archivo se guarda donde decida el navegador (normalmente Descargas).</p>`}
            <label class="ex-check"><input id="ex-default" type="checkbox" /> Usar como predeterminado (formato, ajustes, nombre y carpeta del botón Exportar)</label>
            <button type="button" class="hw-btn hw-btn-sm" id="ex-reset">Restablecer predeterminados</button>
          </fieldset>
        </div>
        <footer class="ex-foot">
          <div class="ex-progress"><progress id="ex-bar" max="1" value="0"></progress><span id="ex-msg" aria-live="polite"></span></div>
          <button type="button" class="hw-btn" id="ex-cancel">Cerrar</button>
          <button type="button" class="hw-btn accent" id="ex-go">${ico('download')} Exportar</button>
        </footer>
      </section>`;
  }
}
