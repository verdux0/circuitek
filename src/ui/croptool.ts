/**
 * Crop tool (Photoshop model). While it is open the viewer shows the whole canvas; the user drags a
 * rectangle (drag outside it = a new one, inside = move it, a handle = resize it). Outside the
 * rectangle the canvas is darkened (the "shield", a big box-shadow), with an optional rule of thirds.
 *
 * The rectangle lives in document pixels here and is stored NORMALISED in the document on apply
 * (crop.ts): one undo step per applied crop, never one per pointer move. The original is never
 * touched: reopening the tool shows the whole canvas and the current crop, ready to adjust.
 *
 * Keys while open: Enter = apply, Esc = cancel, arrows = move the rectangle 1 px (Shift = 10 px).
 * Handles have a 44 px grab area; pointer events (mouse, pen and touch).
 */
import { ico } from './icons';
import type { Viewport } from './viewport';
import type { DocState } from '../doc';
import { ASPECTS, HANDLES, clampRect, cropPx, dragHandle, fitRatio, moveRect, rectFromPoints, type Handle, type PxRect } from '../crop';

export interface CropHost {
  doc(): DocState;
  /** Apply: `rect` in document px (the whole canvas = no crop); `discard` = delete the pixels outside. */
  apply(rect: PxRect, discard: boolean): void;
  /** Called after the tool closed (applied or cancelled). */
  closed(): void;
}

const THIRDS_KEY = 'circuitek:crop-thirds';

export class CropTool {
  private ui: HTMLElement;
  private box: HTMLElement;
  private bar: HTMLElement;
  private aspectSel: HTMLSelectElement;
  private customW: HTMLInputElement;
  private customH: HTMLInputElement;
  private pxW: HTMLInputElement;
  private pxH: HTMLInputElement;
  private thirdsBtn: HTMLButtonElement;
  private discard: HTMLInputElement;
  private sizeLabel: HTMLElement;
  private open_ = false;
  private rect: PxRect = { x: 0, y: 0, w: 1, h: 1 };
  private docW = 1;
  private docH = 1;
  private drag: { id: number; mode: 'move' | 'new' | Handle; start: PxRect; sx: number; sy: number; ratio: number | null } | null = null;
  private onKey = (e: KeyboardEvent) => this.key(e);

  constructor(
    viewer: HTMLElement,
    private stageEl: HTMLElement,
    private viewport: Viewport,
    private host: CropHost,
  ) {
    const ui = document.createElement('div');
    ui.className = 'crop-ui';
    ui.hidden = true;
    ui.setAttribute('aria-label', 'Recorte: arrastra para dibujar el rectángulo, arrastra dentro para moverlo y las asas para cambiar su tamaño');
    const box = document.createElement('div');
    box.className = 'crop-box';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Rectángulo de recorte (flechas para moverlo)');
    box.tabIndex = 0;
    for (const h of HANDLES) {
      const el = document.createElement('div');
      el.className = `crop-h crop-h-${h}`;
      el.dataset.h = h;
      el.setAttribute('aria-hidden', 'true');
      box.append(el);
    }
    ui.append(box);
    // Toolbar: aspect, size, thirds, discard, reset, cancel / apply.
    const bar = document.createElement('div');
    bar.className = 'crop-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Opciones de recorte');
    bar.innerHTML = `
      <label class="crop-f"><span>Proporción</span><select class="crop-aspect" aria-label="Proporción del recorte"></select></label>
      <span class="crop-custom" hidden>
        <input type="number" class="crop-cw" min="1" max="100" step="1" value="4" aria-label="Proporción personalizada: ancho" />
        <span aria-hidden="true">:</span>
        <input type="number" class="crop-ch" min="1" max="100" step="1" value="3" aria-label="Proporción personalizada: alto" />
      </span>
      <label class="crop-f"><span>An.</span><input type="number" class="crop-pw" min="1" step="1" aria-label="Ancho del recorte en píxeles" /></label>
      <label class="crop-f"><span>Al.</span><input type="number" class="crop-ph" min="1" step="1" aria-label="Alto del recorte en píxeles" /></label>
      <span class="crop-size" aria-live="polite"></span>
      <button type="button" class="hw-btn icon crop-thirds" aria-pressed="true" aria-label="Regla de tercios" title="Regla de tercios">${ico('thirds')}</button>
      <label class="crop-chk" title="Borra de verdad lo que queda fuera: el lienzo cambia de tamaño y el patrón del glitch se recalcula"><input type="checkbox" class="crop-discard" /> Eliminar píxeles recortados</label>
      <button type="button" class="hw-btn crop-reset" title="Vuelve a todo el lienzo">Restablecer recorte</button>
      <span class="crop-end">
        <button type="button" class="hw-btn icon crop-cancel" aria-label="Cancelar recorte (Esc)" title="Cancelar (Esc)">${ico('close')}</button>
        <button type="button" class="hw-btn icon accent crop-ok" aria-label="Aplicar recorte (Intro)" title="Aplicar (Intro)">${ico('check')}</button>
      </span>`;
    this.aspectSel = bar.querySelector('.crop-aspect')!;
    this.aspectSel.innerHTML = ASPECTS.map((a) => `<option value="${a.id}">${a.label}</option>`).join('');
    this.customW = bar.querySelector('.crop-cw')!;
    this.customH = bar.querySelector('.crop-ch')!;
    this.pxW = bar.querySelector('.crop-pw')!;
    this.pxH = bar.querySelector('.crop-ph')!;
    this.thirdsBtn = bar.querySelector('.crop-thirds')!;
    this.discard = bar.querySelector('.crop-discard')!;
    this.sizeLabel = bar.querySelector('.crop-size')!;
    viewer.append(ui, bar);
    this.ui = ui;
    this.box = box;
    this.bar = bar;
    let thirds = true;
    try {
      thirds = localStorage.getItem(THIRDS_KEY) !== '0';
    } catch {
      /* storage blocked */
    }
    this.setThirds(thirds);
    this.bind();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    const d = this.host.doc();
    if (!d.layers.length || this.open_) return;
    this.open_ = true;
    this.docW = d.w;
    this.docH = d.h;
    this.rect = cropPx(d.w, d.h, d.crop);
    this.aspectSel.value = 'free';
    this.discard.checked = false;
    this.updateCustom();
    this.ui.hidden = false;
    this.bar.hidden = false;
    document.body.classList.add('cropping');
    this.viewport.setCropEditing(true);
    window.addEventListener('keydown', this.onKey, true);
    this.position();
    this.box.focus({ preventScroll: true });
  }

  /** Cancel (Esc / ✕): nothing changes. */
  cancel(): void {
    this.close();
  }

  private applyNow(): void {
    const r = { x: Math.round(this.rect.x), y: Math.round(this.rect.y), w: Math.round(this.rect.w), h: Math.round(this.rect.h) };
    const discard = this.discard.checked;
    this.close();
    this.host.apply(clampRect(r, this.docW, this.docH), discard);
  }

  private close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.drag = null;
    this.ui.hidden = true;
    this.bar.hidden = true;
    document.body.classList.remove('cropping');
    window.removeEventListener('keydown', this.onKey, true);
    this.viewport.setCropEditing(false);
    this.host.closed();
  }

  /** The document changed under the tool (undo, another size): a crop of another canvas makes no sense. */
  sync(): void {
    if (!this.open_) return;
    const d = this.host.doc();
    if (d.w !== this.docW || d.h !== this.docH || !d.layers.length) this.cancel();
  }

  /** Places the rectangle on screen (after any zoom / pan / resize). */
  position(): void {
    if (!this.open_) return;
    const a = this.viewport.toScreen(this.rect.x, this.rect.y);
    const b = this.viewport.toScreen(this.rect.x + this.rect.w, this.rect.y + this.rect.h);
    Object.assign(this.box.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${Math.max(1, b.x - a.x)}px`, height: `${Math.max(1, b.y - a.y)}px` });
    const w = Math.round(this.rect.w);
    const h = Math.round(this.rect.h);
    if (document.activeElement !== this.pxW) this.pxW.value = String(w);
    if (document.activeElement !== this.pxH) this.pxH.value = String(h);
    this.pxW.max = String(this.docW);
    this.pxH.max = String(this.docH);
    this.sizeLabel.textContent = `${w} × ${h} px`;
    this.box.setAttribute('aria-valuetext', `${w} por ${h} píxeles en ${Math.round(this.rect.x)}, ${Math.round(this.rect.y)}`);
  }

  /** Width / height ratio of the chosen preset (null = free). */
  private ratio(): number | null {
    const a = ASPECTS.find((x) => x.id === this.aspectSel.value);
    if (!a || a.ratio === null) return null;
    if (a.ratio === 'original') return this.docW / this.docH;
    if (a.ratio === 'custom') {
      const w = Number(this.customW.value);
      const h = Number(this.customH.value);
      return w > 0 && h > 0 ? w / h : null;
    }
    return a.ratio;
  }

  private updateCustom(): void {
    (this.bar.querySelector('.crop-custom') as HTMLElement).hidden = this.aspectSel.value !== 'custom';
  }

  private setThirds(on: boolean): void {
    this.box.classList.toggle('thirds', on);
    this.thirdsBtn.setAttribute('aria-pressed', String(on));
    try {
      localStorage.setItem(THIRDS_KEY, on ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.stageEl.getBoundingClientRect();
    return this.viewport.toDoc(e.clientX - r.left, e.clientY - r.top);
  }

  private bind(): void {
    this.ui.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.drag) return;
      e.preventDefault();
      const t = e.target as HTMLElement;
      const h = t.closest<HTMLElement>('.crop-h')?.dataset.h as Handle | undefined;
      const mode = h ?? (t.closest('.crop-box') ? 'move' : 'new');
      const p = this.local(e);
      this.ui.setPointerCapture(e.pointerId);
      this.drag = { id: e.pointerId, mode, start: { ...this.rect }, sx: p.x, sy: p.y, ratio: this.ratio() };
      this.box.focus({ preventScroll: true });
    });
    this.ui.addEventListener('pointermove', (e) => {
      const g = this.drag;
      if (!g || e.pointerId !== g.id) return;
      const p = this.local(e);
      const dx = p.x - g.sx;
      const dy = p.y - g.sy;
      // Free ratio + Shift on a corner: keep the proportion the rectangle had.
      const corner = g.mode.length === 2;
      const ratio = g.ratio ?? (e.shiftKey && corner ? g.start.w / g.start.h : null);
      if (g.mode === 'move') this.rect = moveRect(g.start, dx, dy, this.docW, this.docH);
      else if (g.mode === 'new') this.rect = rectFromPoints(g.sx, g.sy, p.x, p.y, this.docW, this.docH, ratio);
      else this.rect = dragHandle(g.start, g.mode, dx, dy, this.docW, this.docH, ratio);
      this.position();
    });
    const end = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.drag = null;
      if (this.ui.hasPointerCapture(e.pointerId)) this.ui.releasePointerCapture(e.pointerId);
    };
    this.ui.addEventListener('pointerup', end);
    this.ui.addEventListener('pointercancel', end);
    // The wheel still zooms the viewer while cropping.
    this.ui.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.stageEl.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    this.ui.addEventListener('contextmenu', (e) => e.preventDefault());

    this.aspectSel.addEventListener('change', () => {
      this.updateCustom();
      const r = this.ratio();
      if (r) this.rect = fitRatio(this.rect, r, this.docW, this.docH);
      this.position();
    });
    for (const inp of [this.customW, this.customH]) inp.addEventListener('input', () => {
      const r = this.ratio();
      if (r) this.rect = fitRatio(this.rect, r, this.docW, this.docH);
      this.position();
    });
    const setSize = (which: 'w' | 'h') => {
      const v = Math.round(Number((which === 'w' ? this.pxW : this.pxH).value));
      if (!(v > 0)) return;
      const r = this.ratio();
      const cx = this.rect.x + this.rect.w / 2;
      const cy = this.rect.y + this.rect.h / 2;
      let w = which === 'w' ? v : this.rect.w;
      let h = which === 'h' ? v : this.rect.h;
      if (r) {
        if (which === 'w') h = w / r;
        else w = h * r;
      }
      const k = Math.min(1, this.docW / w, this.docH / h);
      w *= k;
      h *= k;
      this.rect = clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, this.docW, this.docH);
      this.position();
    };
    this.pxW.addEventListener('change', () => setSize('w'));
    this.pxH.addEventListener('change', () => setSize('h'));
    this.thirdsBtn.addEventListener('click', () => this.setThirds(!this.box.classList.contains('thirds')));
    this.bar.querySelector('.crop-reset')!.addEventListener('click', () => {
      this.aspectSel.value = 'free';
      this.updateCustom();
      this.rect = { x: 0, y: 0, w: this.docW, h: this.docH };
      this.position();
    });
    this.bar.querySelector('.crop-cancel')!.addEventListener('click', () => this.cancel());
    this.bar.querySelector('.crop-ok')!.addEventListener('click', () => this.applyNow());
  }

  private key(e: KeyboardEvent): void {
    if (!this.open_) return;
    const inField = (e.target as HTMLElement).matches?.('input, select, textarea');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      return;
    }
    if (e.key === 'Enter' && !(e.target as HTMLElement).matches?.('button')) {
      // In a size field Enter first commits the field (change event), then applies.
      if (inField) (e.target as HTMLInputElement).dispatchEvent(new Event('change'));
      e.preventDefault();
      e.stopPropagation();
      this.applyNow();
      return;
    }
    if (inField) return;
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const a = arrows[e.key];
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      this.rect = moveRect(this.rect, a[0], a[1], this.docW, this.docH);
      this.position();
      return;
    }
    // The rest of the editor's shortcuts wait until the crop is applied or cancelled.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  }
}
