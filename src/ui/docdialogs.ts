/**
 * Document dialogs from the Imagen menu, as floating windows (Photopea reference, sections 3
 * and 8): Tamaño de lienzo… (canvas only, content not scaled, with anchor) and Tamaño de la
 * imagen… (canvas and content scaled). Plus the Atajos window.
 */
import { resizeDoc, scaleDoc, type DocState } from '../doc';
import { ico } from './icons';
import { openWindow } from './window';

export interface DocDialogHost {
  doc(): DocState;
  editDoc(fn: (d: DocState) => void, phase: 'once'): void;
  /** Largest allowed size with the same aspect ratio. */
  clampDocSize(w: number, h: number): [number, number];
  toast(msg: string): void;
}

/** Width / height fields with a proportion lock (shared by both dialogs). */
function sizeFields(w0: number, h0: number, locked: boolean): { el: HTMLElement; get(): [number, number]; setBase(w: number, h: number): void } {
  const el = document.createElement('div');
  el.className = 'win-size';
  el.innerHTML = `
    <label class="win-field"><span>Ancho:</span><input type="number" data-k="w" min="1" step="1" inputmode="numeric"><span class="win-unit">px</span></label>
    <label class="win-field"><span>Alto:</span><input type="number" data-k="h" min="1" step="1" inputmode="numeric"><span class="win-unit">px</span></label>
    <button type="button" class="hw-btn icon-sm win-lock" aria-pressed="${locked}" aria-label="Mantener la proporción" title="Mantener la proporción">${ico(locked ? 'lock' : 'unlock')}</button>`;
  const iw = el.querySelector<HTMLInputElement>('[data-k="w"]')!;
  const ih = el.querySelector<HTMLInputElement>('[data-k="h"]')!;
  const lock = el.querySelector<HTMLButtonElement>('.win-lock')!;
  let ratio = w0 / h0;
  let baseW = w0;
  let baseH = h0;
  iw.value = String(w0);
  ih.value = String(h0);
  lock.addEventListener('click', () => {
    locked = !locked;
    lock.setAttribute('aria-pressed', String(locked));
    lock.innerHTML = ico(locked ? 'lock' : 'unlock');
    ratio = (Number(iw.value) || baseW) / (Number(ih.value) || baseH);
  });
  iw.addEventListener('input', () => {
    if (locked && Number(iw.value)) ih.value = String(Math.max(1, Math.round(Number(iw.value) / ratio)));
  });
  ih.addEventListener('input', () => {
    if (locked && Number(ih.value)) iw.value = String(Math.max(1, Math.round(Number(ih.value) * ratio)));
  });
  return {
    el,
    get: () => [Math.round(Number(iw.value)), Math.round(Number(ih.value))],
    setBase: (w, h) => {
      baseW = w;
      baseH = h;
      iw.value = String(w);
      ih.value = String(h);
      ratio = h ? w / h : 1;
    },
  };
}

const ANCHOR_NAMES = ['arriba a la izquierda', 'arriba', 'arriba a la derecha', 'a la izquierda', 'en el centro', 'a la derecha', 'abajo a la izquierda', 'abajo', 'abajo a la derecha'];

/** Imagen → Tamaño de lienzo…: width, height, Relativo, anchor 3×3 and background. */
export function canvasSizeDialog(host: DocDialogHost): void {
  const d0 = host.doc();
  const body = document.createElement('div');
  const size = sizeFields(d0.w, d0.h, false);
  body.append(size.el);
  body.insertAdjacentHTML(
    'beforeend',
    `<label class="win-check"><input type="checkbox" data-k="rel"> Relativo</label>
    <div class="win-row"><span class="win-label" id="anchor-label">Ancla:</span>
      <div class="anchor-grid" role="radiogroup" aria-labelledby="anchor-label">
        ${ANCHOR_NAMES.map((n, i) => `<button type="button" role="radio" class="anchor-cell" data-i="${i}" aria-checked="${i === 4}" aria-label="Ancla ${n}" tabindex="${i === 4 ? 0 : -1}"></button>`).join('')}
      </div>
    </div>
    <div class="win-row">
      <label class="win-field"><span>Fondo:</span><input type="color" data-k="bg" value="${d0.bg}"></label>
      <label class="win-check"><input type="checkbox" data-k="transparent"${d0.transparent ? ' checked' : ''}> Transparente</label>
    </div>
    <button type="button" class="hw-btn accent win-ok">Aceptar</button>`,
  );
  const rel = body.querySelector<HTMLInputElement>('[data-k="rel"]')!;
  const bg = body.querySelector<HTMLInputElement>('[data-k="bg"]')!;
  const tr = body.querySelector<HTMLInputElement>('[data-k="transparent"]')!;
  const cells = [...body.querySelectorAll<HTMLButtonElement>('.anchor-cell')];
  let anchor = 4;
  const setAnchor = (i: number) => {
    anchor = i;
    cells.forEach((c, k) => {
      c.setAttribute('aria-checked', String(k === i));
      c.tabIndex = k === i ? 0 : -1;
    });
  };
  cells.forEach((c, i) => {
    c.addEventListener('click', () => setAnchor(i));
    c.addEventListener('keydown', (e) => {
      const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
      if (!(e.key in step)) return;
      e.preventDefault();
      const n = Math.max(0, Math.min(8, i + step[e.key]));
      setAnchor(n);
      cells[n].focus();
    });
  });
  bg.disabled = tr.checked;
  tr.addEventListener('change', () => (bg.disabled = tr.checked));
  // Relativo: the fields hold how much to add or remove.
  rel.addEventListener('change', () => {
    const d = host.doc();
    const [w, h] = size.get();
    if (rel.checked) size.setBase(w - d.w, h - d.h);
    else size.setBase(d.w + w, d.h + h);
  });
  const win = openWindow({ title: 'Tamaño de lienzo', body, className: 'win-canvas-size' });
  body.querySelector('.win-ok')!.addEventListener('click', () => {
    const d = host.doc();
    let [w, h] = size.get();
    if (rel.checked) [w, h] = [d.w + w, d.h + h];
    if (!(w >= 1 && h >= 1)) return host.toast('Ancho y alto tienen que ser de 1 px o más');
    [w, h] = host.clampDocSize(w, h);
    const ax = (anchor % 3) / 2;
    const ay = Math.floor(anchor / 3) / 2;
    host.editDoc((x) => {
      resizeDoc(x, w, h, (w - x.w) * ax, (h - x.h) * ay);
      x.bg = bg.value;
      if (tr.checked) x.transparent = true;
      else delete x.transparent;
    }, 'once');
    win.close();
  });
}

/** Imagen → Tamaño de la imagen…: scales the canvas and everything on it. */
export function imageSizeDialog(host: DocDialogHost): void {
  const d0 = host.doc();
  const body = document.createElement('div');
  const size = sizeFields(d0.w, d0.h, true);
  body.append(size.el);
  body.insertAdjacentHTML('beforeend', '<button type="button" class="hw-btn accent win-ok">Aceptar</button>');
  const win = openWindow({ title: 'Tamaño de la imagen', body, className: 'win-image-size' });
  body.querySelector('.win-ok')!.addEventListener('click', () => {
    let [w, h] = size.get();
    if (!(w >= 1 && h >= 1)) return host.toast('Ancho y alto tienen que ser de 1 px o más');
    [w, h] = host.clampDocSize(w, h);
    host.editDoc((x) => scaleDoc(x, w, h), 'once');
    win.close();
  });
}

/** Atajos: the keyboard reference (index.html, #tpl-shortcuts). */
export function shortcutsDialog(): void {
  const tpl = document.getElementById('tpl-shortcuts') as HTMLTemplateElement | null;
  const body = document.createElement('div');
  if (tpl) body.append(tpl.content.cloneNode(true));
  openWindow({ title: 'Atajos', body, className: 'win-shortcuts' });
}
