/**
 * Two panels over the same layer state (Photopea reference, sections 6 and 7):
 *  - Capas (`el`): blend mode and opacity of the selected layer, the sortable stack (SortableJS)
 *    and the bottom action row (effects, duplicate, new text / image layer, delete).
 *  - Propiedades (`propsEl`): blending options, transform and text of the selected layer.
 * Neither knows where it is docked. All changes go through host.editDoc (undoable).
 */
import Sortable from 'sortablejs';
import {
  BLENDS,
  cloneLayer,
  cropDocTo,
  fitLayer,
  flipDoc,
  flipLayer,
  getLayer,
  moveLayer,
  newId,
  PASTE_OFFSET,
  resetLayer,
  resizeDoc,
  rotateDoc,
  rotateLayer,
  type BitmapSource,
  type DocState,
  type Layer,
} from '../doc';
import type { TextProps } from '../text';
import { addIco, ico } from './icons';
import { layerHasFx } from '../gl/renderer';
import { EFFECTS, addedEffects, type EffectKey } from '../layerstyle';

type Phase = 'live' | 'end' | 'once';
export interface LayersHost {
  doc(): DocState;
  bitmaps: Map<string, BitmapSource>;
  editDoc(fn: (d: DocState) => void, phase: Phase): void;
  select(id: string | null): void;
  pickFiles(): void;
  clampDocSize(w: number, h: number): [number, number];
  toast(msg: string): void;
  /** Toast with a «Deshacer» button that undoes the edit just made (touch has no Ctrl+Z). */
  toastUndo(msg: string): void;
  /** Text layers. */
  editText(id: string, patch: Partial<TextProps>, phase: Phase): void;
  /** Puts the (persistent) font list into the text panel. */
  mountFontList(slot: HTMLElement): void;
  /** Weight / style choices of the layer's font ("400", "700i"…); null when it has no known variants. */
  fontVariants(t: TextProps): { value: string; label: string }[] | null;
  /** Warning shown under the font (missing font, missing glyphs…), '' when all is fine. */
  fontNote(t: TextProps): string;
  openTextEditor(id: string): void;
  addTextLayer(): void;
  /** Opens the «Buscar GIF» panel. */
  searchGifs(): void;
  extraFonts(): { local: string[]; files: string[] };
  fontsVersion(): number;
  loadLocalFonts(): void;
  pickFontFile(): void;
  /** Menu of a layer row (⋯ button or right click), at a screen point. */
  rowMenu(id: string, clientX: number, clientY: number): void;
  /** «Estilo de capa» dialog for a layer (optionally on one effect). */
  openStyle(id: string, focus?: EffectKey): void;
  /** Shows the effects panel (bottom row «fx» button). */
  showEffects(): void;
}

const blendOptions = (): string => BLENDS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');

export class LayersPanel {
  readonly el = document.createElement('section');
  /** The Propiedades panel (selected layer). */
  readonly propsEl = document.createElement('section');
  private list: HTMLOListElement;
  private props: HTMLElement;
  private structKey = '';
  private propsKey = '';
  private thumbs = new Map<string, string>();
  /** Id of the layer whose name is being edited inline (the list is not rebuilt meanwhile). */
  private renaming: string | null = null;
  /** Layers whose effects list (under the row) is folded (view state, not part of the document). */
  private folded = new Set<string>();

  constructor(private host: LayersHost) {
    this.el.className = 'layers';
    this.el.innerHTML = `
      <div class="layers-top">
        <select data-prop="blend" aria-label="Modo de fusión de la capa">${blendOptions()}</select>
        <label class="layers-opacity"><span>Opacidad:</span><input type="number" data-prop="opacity" min="0" max="100" step="1" inputmode="numeric" aria-label="Opacidad de la capa (%)"><span class="win-unit">%</span></label>
      </div>
      <ol class="layer-list" aria-label="Capas (la de arriba se dibuja encima)"></ol>
      <p class="layer-empty">Sin capas. Importa una o varias fotos: cada una será una capa.</p>
      <div class="layers-foot" role="toolbar" aria-label="Acciones de capa">
        <span class="layer-count" aria-live="polite">Sin capas</span>
        <button class="layers-act" data-act="show-fx" aria-label="Efectos de la capa" title="Efectos de la capa">${ico('fx')}</button>
        <button class="layers-act" data-act="duplicate" aria-label="Duplicar capa (Ctrl+J)" title="Duplicar capa (Ctrl+J)">${ico('duplicate')}</button>
        <button class="layers-act" data-act="add-text" aria-label="Nueva capa de texto (T)" title="Nueva capa de texto (T)">${addIco('type')}</button>
        <button class="layers-act" data-act="search-gif" aria-label="Buscar GIF en GifCities (G)" title="Buscar GIF en GifCities (G)">${ico('search')}</button>
        <button class="layers-act" data-act="add" aria-label="Nueva capa desde imagen (I)" title="Nueva capa: añadir imágenes, GIF o vídeos (I · también arrastrar o Ctrl+V)">${addIco('image')}</button>
        <button class="layers-act danger" data-act="delete" aria-label="Eliminar capa (Supr · se puede deshacer)" title="Eliminar capa (Supr · se puede deshacer)">${ico('trash')}</button>
      </div>`;
    this.list = this.el.querySelector('.layer-list')!;
    this.propsEl.className = 'layer-props-panel';
    this.propsEl.innerHTML = '<p class="layer-empty">Sin capas.</p><div class="layer-props"></div>';
    this.props = this.propsEl.querySelector('.layer-props')!;

    Sortable.create(this.list, {
      animation: 140,
      handle: '.layer-grip',
      ghostClass: 'layer-ghost',
      // Pointer-driven reordering instead of native HTML5 drag & drop: a native drag would
      // reach the window's file-drop handlers (import overlay) and is unreliable on touch.
      forceFallback: true,
      fallbackOnBody: true,
      fallbackClass: 'layer-drag-mirror',
      onEnd: (e) => {
        if (e.oldIndex === undefined || e.newIndex === undefined || e.oldIndex === e.newIndex) return;
        const id = (e.item as HTMLElement).dataset.id!;
        const n = this.host.doc().layers.length;
        // The list shows the top layer first.
        this.structKey = '';
        this.host.editDoc((d) => moveLayer(d, id, n - 1 - e.newIndex!), 'once');
      },
    });

    for (const root of [this.el, this.propsEl]) {
      root.addEventListener('click', (e) => this.onClick(e));
      root.addEventListener('input', (e) => this.onInput(e as InputEvent, 'live'));
      root.addEventListener('change', (e) => this.onInput(e, 'end'));
    }
    // Right click on a row: same menu as the ⋯ button (instead of the browser's).
    this.list.addEventListener('contextmenu', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.layer-row');
      if (!row || (e.target as HTMLElement).closest('.layer-name-input')) return;
      e.preventDefault();
      this.host.select(row.dataset.id!);
      this.host.rowMenu(row.dataset.id!, e.clientX, e.clientY);
    });
    this.el.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('.layer-row');
      if (!row) return;
      if (t.closest('.layer-name')) return this.startRename(row.dataset.id!);
      // Outside the name, the thumbnail and the buttons: «Estilo de capa» (as in Photoshop).
      if (t.closest('button, .layer-thumb, .layer-grip, .layer-fx, input')) return;
      this.host.openStyle(row.dataset.id!);
    });
  }

  private active(): Layer | undefined {
    const d = this.host.doc();
    return getLayer(d, d.active);
  }

  private onClick(e: Event): void {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>('[data-act], [data-row-act]');
    const row = t.closest<HTMLElement>('.layer-row');
    if (btn?.dataset.act === 'add') return this.host.pickFiles();
    if (btn?.dataset.act === 'add-text') return this.host.addTextLayer();
    if (btn?.dataset.act === 'search-gif') return this.host.searchGifs();
    if (btn?.dataset.act === 'show-fx') return this.host.showEffects();
    const tb = t.closest<HTMLElement>('[data-font], [data-text-toggle], [data-align]');
    if (tb) return this.textButton(tb);
    if (btn?.dataset.rowAct === 'menu' && row) {
      const id = row.dataset.id!;
      this.host.select(id);
      const r = btn.getBoundingClientRect();
      this.host.rowMenu(id, r.left, r.bottom);
      return;
    }
    if (btn?.dataset.rowAct === 'delete' && row) return this.deleteLayer(row.dataset.id!);
    if (btn && row && this.styleAction(btn, row.dataset.id!)) return;
    if (btn?.dataset.rowAct && row) {
      const id = row.dataset.id!;
      const key = btn.dataset.rowAct === 'eye' ? 'visible' : 'locked';
      this.host.editDoc((d) => {
        const l = getLayer(d, id);
        if (l) l[key] = !l[key];
      }, 'once');
      return;
    }
    if (row && !btn) return this.host.select(row.dataset.id!);
    if (btn?.dataset.act) this.layerAction(btn.dataset.act);
  }

  layerAction(act: string): void {
    const l = this.active();
    if (!l) return;
    const id = l.id;
    if (act === 'delete') return this.deleteActive();
    if (act === 'edit-text') return this.host.openTextEditor(id);
    if (act === 'duplicate') return this.duplicateActive();
    if (act === 'rename') return this.startRename(id);
    this.host.editDoc((d) => {
      const x = getLayer(d, id)!;
      switch (act) {
        case 'rot-l': rotateLayer(x, -90); break;
        case 'rot-r': rotateLayer(x, 90); break;
        case 'rot-180': rotateLayer(x, 180); break;
        case 'rot-0': x.rotation = 0; break;
        case 'flip-h': flipLayer(x, 'h'); break;
        case 'flip-v': flipLayer(x, 'v'); break;
        case 'fit': fitLayer(d, x, 'contain'); break;
        case 'fill': fitLayer(d, x, 'cover'); break;
        case 'center': x.x = d.w / 2; x.y = d.h / 2; break;
        case 'one': x.scaleX = x.scaleY = 1; break;
        case 'reset': resetLayer(d, x); break;
        case 'up': moveLayer(d, id, d.layers.indexOf(x) + 1); break;
        case 'down': moveLayer(d, id, d.layers.indexOf(x) - 1); break;
        case 'top': moveLayer(d, id, d.layers.length - 1); break;
        case 'bottom': moveLayer(d, id, 0); break;
      }
    }, 'once');
  }

  private textButton(b: HTMLElement): void {
    const l = this.active();
    if (!l?.text) return;
    if (b.dataset.font === 'local') return this.host.loadLocalFonts();
    if (b.dataset.font === 'file') return this.host.pickFontFile();
    if (b.dataset.textToggle === 'bold') return this.host.editText(l.id, { bold: !l.text.bold }, 'once');
    if (b.dataset.textToggle === 'italic') return this.host.editText(l.id, { italic: !l.text.italic }, 'once');
    if (b.dataset.align) this.host.editText(l.id, { align: b.dataset.align as TextProps['align'] }, 'once');
  }

  deleteActive(notify = true): void {
    const l = this.active();
    if (l) this.deleteLayer(l.id, notify);
  }

  /** Deletes a layer at once; the toast offers «Deshacer» (no confirmation dialog to dismiss). */
  deleteLayer(id: string, notify = true): void {
    const d0 = this.host.doc();
    const l = getLayer(d0, id);
    if (!l) return;
    const wasActive = d0.active === id;
    this.host.editDoc((d) => {
      const i = d.layers.findIndex((x) => x.id === id);
      d.layers.splice(i, 1);
      if (wasActive) d.active = d.layers[Math.min(i, d.layers.length - 1)]?.id ?? null;
    }, 'once');
    if (notify) this.host.toastUndo(`Capa «${l.name}» eliminada`);
  }

  duplicateActive(): void {
    const l = this.active();
    if (!l) return;
    this.host.editDoc((d) => {
      const i = d.layers.findIndex((x) => x.id === l.id);
      const copy: Layer = { ...cloneLayer(d.layers[i]), id: newId(), name: `${l.name} copia`.slice(0, 80), autoName: false, x: l.x + PASTE_OFFSET, y: l.y + PASTE_OFFSET };
      d.layers.splice(i + 1, 0, copy);
      d.active = copy.id;
    }, 'once');
  }

  nudge(dx: number, dy: number): void {
    const l = this.active();
    if (!l || l.locked) return;
    this.host.editDoc((d) => {
      const x = getLayer(d, l.id)!;
      x.x += dx;
      x.y += dy;
    }, 'once');
  }

  /** Canvas operations (Imagen menu): rotate, mirror, crop to the active / all layers. */
  docAction(act: 'rot-l' | 'rot-r' | 'flip-h' | 'flip-v' | 'crop-active' | 'crop-all'): void {
    if (act === 'crop-active' && !this.active()) return this.host.toast('Selecciona una capa');
    this.host.editDoc((d) => {
      switch (act) {
        case 'rot-l': rotateDoc(d, -1); break;
        case 'rot-r': rotateDoc(d, 1); break;
        case 'flip-h': flipDoc(d, 'h'); break;
        case 'flip-v': flipDoc(d, 'v'); break;
        case 'crop-active': cropDocTo(d, [getLayer(d, d.active)!]); break;
        case 'crop-all': cropDocTo(d, d.layers.filter((l) => l.visible)); break;
      }
      const [w, h] = this.host.clampDocSize(d.w, d.h);
      if (w !== d.w || h !== d.h) resizeDoc(d, w, h);
    }, 'once');
  }

  /** Renames the active layer inline (F2). */
  renameActive(): void {
    const l = this.active();
    if (l) this.startRename(l.id);
  }

  /**
   * Inline rename: the name becomes a text field in place. Enter / leaving the field commits,
   * Escape cancels; an empty name keeps the old one. No dialogs.
   */
  startRename(id: string): void {
    const l = getLayer(this.host.doc(), id);
    const row = this.list.querySelector<HTMLElement>(`.layer-row[data-id="${CSS.escape(id)}"]`);
    const label = row?.querySelector<HTMLElement>('.layer-name');
    if (!l || !row || !label || this.renaming) return;
    this.renaming = id;
    const input = document.createElement('input');
    input.className = 'layer-name-input';
    input.value = l.name;
    input.maxLength = 80;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Nombre de la capa');
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      const name = input.value.trim().slice(0, 80);
      this.structKey = ''; // the row is drawn again with the (new) name
      if (commit && name && name !== l.name) {
        this.host.editDoc((d) => {
          const x = getLayer(d, id);
          if (!x) return;
          x.name = name;
          x.autoName = false;
        }, 'once');
      } else this.sync();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    // Clicks inside the field must not re-select the row or start a reorder.
    for (const t of ['pointerdown', 'mousedown', 'click', 'dblclick']) input.addEventListener(t, (e) => e.stopPropagation());
  }

  private onInput(e: Event, phase: 'live' | 'end'): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const prop = t.dataset.prop;
    const textKey = t.dataset.text as keyof TextProps | undefined;
    if (textKey) {
      const l = this.active();
      if (!l?.text) return;
      if ((textKey as string) === 'variant') {
        const m = /^(\d+)(i?)$/.exec(t.value);
        if (m && phase === 'end') this.host.editText(l.id, { weight: Number(m[1]), italic: m[2] === 'i', bold: Number(m[1]) >= 600 }, 'once');
        return;
      }
      if (textKey === 'content' || textKey === 'color') return this.host.editText(l.id, { [textKey]: t.value }, phase);
      const v = Number(t.value);
      if (textKey === 'size' && v >= 1 && v <= 4000) this.host.editText(l.id, { size: v }, phase);
      if (textKey === 'lineHeight' && v >= 0.5 && v <= 4) this.host.editText(l.id, { lineHeight: v }, phase);
      return;
    }
    if (!prop) return;
    const l = this.active();
    if (!l) return;
    // Number fields commit on change; the opacity slider and the blend select update live.
    if (phase === 'live' && t.type === 'number') return;
    this.host.editDoc((d) => {
      const x = getLayer(d, l.id)!;
      const v = Number(t.value);
      switch (prop) {
        case 'opacity': if (t.value !== '' && Number.isFinite(v)) x.opacity = Math.max(0, Math.min(1, v / 100)); break;
        case 'blend': x.blend = t.value as Layer['blend']; break;
        case 'scale': {
          if (!(v > 0)) break;
          const ratio = x.scaleY / x.scaleX;
          x.scaleX = v / 100;
          x.scaleY = (v / 100) * ratio;
          break;
        }
      }
    }, phase);
  }

  private thumb(src: string): string {
    let url = this.thumbs.get(src);
    if (url) return url;
    const bm = this.host.bitmaps.get(src);
    if (!bm) return '';
    const img = bm.proxy as ImageBitmap;
    const k = Math.min(88 / img.width, 64 / img.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    url = c.toDataURL('image/jpeg', 0.8);
    this.thumbs.set(src, url);
    return url;
  }

  /** Buttons of the layer-style part of a row. Returns true if handled. */
  private styleAction(btn: HTMLElement, id: string): boolean {
    const act = btn.dataset.rowAct;
    const fx = btn.dataset.fx as EffectKey | undefined;
    if (act === 'style') this.host.openStyle(id);
    else if (act === 'fx-open' && fx) this.host.openStyle(id, fx);
    else if (act === 'fx-fold') {
      if (this.folded.has(id)) this.folded.delete(id);
      else this.folded.add(id);
      this.structKey = '';
      this.sync();
    } else if (act === 'fx-all' || (act === 'fx-eye' && fx)) {
      this.host.editDoc((d) => {
        const st = getLayer(d, id)?.style;
        if (!st) return;
        if (act === 'fx-all') st.enabled = !st.enabled;
        else st[fx!].hidden = !st[fx!].hidden;
      }, 'once');
    } else return false;
    return true;
  }

  /** The effects of a layer's style, under its row: «Efectos» (eye = all) and one row per effect. */
  private fxList(l: Layer): string {
    const st = l.style;
    const keys = addedEffects(st);
    if (!st || !keys.length) return '';
    const fold = this.folded.has(l.id);
    const items = keys
      .map((k) => {
        const e = EFFECTS.find((x) => x.key === k)!;
        const shown = !st[k].hidden;
        return `<li class="layer-fx-item${shown ? '' : ' off'}">
          <button class="layer-tog" data-row-act="fx-eye" data-fx="${k}" aria-pressed="${shown}" aria-label="${shown ? 'Ocultar' : 'Mostrar'} ${e.label}" title="${shown ? 'Ocultar' : 'Mostrar'} el efecto">${ico(shown ? 'eye' : 'eye-off')}</button>
          <button class="layer-fx-name" data-row-act="fx-open" data-fx="${k}" title="Editar ${e.label}">${e.label}</button>
        </li>`;
      })
      .join('');
    return `<div class="layer-fx${st.enabled ? '' : ' off'}">
        <div class="layer-fx-head">
          <button class="layer-tog" data-row-act="fx-all" aria-pressed="${st.enabled}" aria-label="${st.enabled ? 'Ocultar' : 'Mostrar'} todos los efectos de la capa" title="${st.enabled ? 'Ocultar' : 'Mostrar'} los efectos">${ico(st.enabled ? 'eye' : 'eye-off')}</button>
          <button class="layer-fx-fold" data-row-act="fx-fold" aria-expanded="${!fold}" aria-label="${fold ? 'Desplegar' : 'Plegar'} la lista de efectos">${ico('chevron', fold ? 'folded' : '')} Efectos</button>
        </div>
        ${fold ? '' : `<ul class="layer-fx-items">${items}</ul>`}
      </div>`;
  }

  /** Re-renders the list when the structure changed and refreshes the property fields. */
  sync(): void {
    const d = this.host.doc();
    // The selection is not part of the key: selecting only moves a class, so the row under
    // the pointer survives a click (double click to rename, drag the grip right after).
    const fxKey = (l: Layer) => (l.style ? [l.style.enabled, addedEffects(l.style).map((k) => `${k}${l.style![k].hidden ? '-' : '+'}`), this.folded.has(l.id)] : null);
    const key = JSON.stringify(d.layers.map((l) => [l.id, l.src, l.name, l.visible, l.locked, l.blend, Math.round(l.opacity * 100), layerHasFx(l), fxKey(l)]));
    this.el.classList.toggle('no-layers', d.layers.length === 0);
    this.propsEl.classList.toggle('no-layers', d.layers.length === 0);
    const n = d.layers.length;
    this.el.querySelector('.layer-count')!.textContent = n ? `${n} capa${n === 1 ? '' : 's'}` : 'Sin capas';
    if (key !== this.structKey && !this.renaming) {
      this.structKey = key;
      this.list.innerHTML = [...d.layers]
        .reverse()
        .map(
          (l) => `
        <li class="layer-row${l.visible ? '' : ' hidden-layer'}" data-id="${l.id}">
          <button class="layer-tog${l.visible ? '' : ' off'}" data-row-act="eye" aria-label="${l.visible ? 'Ocultar' : 'Mostrar'} capa" title="${l.visible ? 'Ocultar' : 'Mostrar'}">${ico(l.visible ? 'eye' : 'eye-off')}</button>
          <img class="layer-thumb" src="${this.thumb(l.src)}" alt="" draggable="false">
          <span class="layer-name" title="Doble clic para renombrar (F2)">${layerHasFx(l) ? `<b class="fx-badge" title="Tiene efectos">${ico('fx')}</b>` : ''}${escapeHtml(l.name)}${l.blend !== 'source-over' || l.opacity < 1 ? `<small>${l.opacity < 1 ? Math.round(l.opacity * 100) + '%' : ''} ${l.blend !== 'source-over' ? BLENDS.find((b) => b[0] === l.blend)![1] : ''}</small>` : ''}</span>
          <button class="layer-tog layer-style-btn${addedEffects(l.style).length ? ' on' : ''}" data-row-act="style" aria-label="Estilo de capa (sombra, resplandor…)" title="Estilo de capa: sombras y resplandores (o doble clic en la fila)">${ico('style')}</button>
          <button class="layer-tog${l.locked ? ' on' : ''}" data-row-act="lock" aria-label="${l.locked ? 'Desbloquear' : 'Bloquear'} capa" title="${l.locked ? 'Desbloquear' : 'Bloquear (no se mueve en el visor)'}">${ico(l.locked ? 'lock' : 'unlock')}</button>
          <button class="layer-tog" data-row-act="menu" aria-label="Menú de la capa" aria-haspopup="menu" title="Opciones de la capa (o clic derecho)">${ico('menu')}</button>
          <span class="layer-grip" title="Arrastra para reordenar" aria-hidden="true">${ico('grip')}</span>
          ${this.fxList(l)}
        </li>`,
        )
        .join('');
    }
    for (const row of this.list.querySelectorAll<HTMLElement>('.layer-row')) {
      const on = row.dataset.id === d.active;
      row.classList.toggle('active', on);
      row.setAttribute('aria-selected', String(on));
    }
    // The property block is rebuilt only when the active layer changes (never mid-drag).
    const pk = `${d.active}|${d.layers.length > 0}|${this.host.fontsVersion()}`;
    if (pk !== this.propsKey) {
      this.propsKey = pk;
      this.renderProps();
    }
    this.syncFields();
  }

  private renderProps(): void {
    const l = this.active();
    if (!l) {
      this.props.innerHTML = this.host.doc().layers.length ? '<p class="layer-hint">Selecciona una capa en la lista o en el visor.</p>' : '';
      return;
    }
    queueMicrotask(() => {
      const slot = this.props.querySelector<HTMLElement>('[data-font-slot]');
      if (slot) this.host.mountFontList(slot);
    });
    this.props.innerHTML = `
      <details class="sub" data-sub="blend" open>
      <summary>${ico('chevron', 'sub-chev')}${ico('layers')} Opciones de fusión</summary>
      <label class="prop prop-wide"><span>Modo de fusión:</span><select data-prop="blend">${blendOptions()}</select></label>
      <div class="prop prop-wide prop-slider"><span>Opacidad:</span><input type="range" data-prop="opacity" min="0" max="100" step="1" aria-label="Opacidad"><input type="number" data-prop="opacity" min="0" max="100" step="1" inputmode="numeric" aria-label="Opacidad (%)"><span class="win-unit">%</span></div>
      </details>
      ${l.text ? this.textBlock(l.text) : ''}
      <details class="sub" data-sub="transform" open>
      <summary>${ico('chevron', 'sub-chev')}${ico('contain')} Transformar</summary>
      <label class="prop prop-wide"><span>Escala:</span><input type="number" data-prop="scale" min="1" step="1"><span class="win-unit">%</span></label>
      <div class="btn-grid btn-grid-7">
        <button class="hw-btn icon-sm" data-act="flip-h" aria-label="Espejo horizontal (H)" title="Espejo horizontal (H)">${ico('flip-h')}</button>
        <button class="hw-btn icon-sm" data-act="flip-v" aria-label="Espejo vertical (Shift+H)" title="Espejo vertical (Shift+H)">${ico('flip-v')}</button>
        <button class="hw-btn icon-sm" data-act="reset" aria-label="Quitar todas las transformaciones" title="Quitar todas las transformaciones">${ico('reset')}</button>
        <button class="hw-btn icon-sm" data-act="one" aria-label="Tamaño original 1:1" title="Tamaño original 1:1">${ico('one-to-one')}</button>
        <button class="hw-btn icon-sm" data-act="fit" aria-label="Encajar entera en el lienzo" title="Encajar entera en el lienzo">${ico('contain')}</button>
        <button class="hw-btn icon-sm" data-act="fill" aria-label="Rellenar el lienzo" title="Rellenar el lienzo">${ico('cover')}</button>
        <button class="hw-btn icon-sm" data-act="center" aria-label="Centrar en el lienzo" title="Centrar en el lienzo">${ico('center')}</button>
      </div>
      <p class="layer-hint">Girar: clic derecho sobre la capa en el visor, asa superior del marco o [ ].</p>
      </details>`;
  }

  private textBlock(t: TextProps): string {
    void t;
    return `
      <details class="sub text-props" data-sub="text" open>
        <summary>${ico('chevron', 'sub-chev')}${ico('type')} Texto</summary>
        <label class="prop"><span>TEXTO · doble clic en el visor para editar encima</span><textarea data-text="content" rows="2" spellcheck="false"></textarea></label>
        <div class="prop prop-wide font-field"><span>FUENTE</span>
          <div data-font-slot></div>
        </div>
        <div class="prop-row">
          <label class="prop prop-wide"><span>VARIANTE</span><select data-text="variant" aria-label="Variante: peso y estilo"></select></label>
        </div>
        <p class="font-note" data-font-note role="status" aria-live="polite"></p>
        <div class="prop-row font-btns">
          <button class="hw-btn hw-btn-sm font-src" data-font="local" title="Usar las fuentes instaladas en este equipo (Chrome / Edge; pide permiso)">${ico('font-local')} Fuentes del equipo</button>
          <button class="hw-btn hw-btn-sm font-src" data-font="file" title="Cargar un archivo .ttf, .otf, .woff o .woff2 (solo se guarda en este equipo)">${ico('font-file')} Cargar fuente…</button>
        </div>
        <div class="prop-grid prop-grid-3">
          <label class="prop"><span>TAMAÑO px</span><input type="number" data-text="size" min="1" max="4000" step="1"></label>
          <label class="prop"><span>INTERLÍNEA</span><input type="number" data-text="lineHeight" min="0.5" max="4" step="0.05"></label>
          <label class="prop prop-color"><span>COLOR</span><input type="color" data-text="color"></label>
        </div>
        <div class="seg-row">
          <button class="hw-btn icon-sm seg" data-text-toggle="bold" aria-label="Negrita" title="Negrita">${ico('bold')}</button>
          <button class="hw-btn icon-sm seg" data-text-toggle="italic" aria-label="Cursiva" title="Cursiva">${ico('italic')}</button>
          <button class="hw-btn icon-sm seg" data-align="left" aria-label="Alinear a la izquierda" title="Alinear a la izquierda">${ico('align-left')}</button>
          <button class="hw-btn icon-sm seg" data-align="center" aria-label="Centrar" title="Centrar">${ico('align-center')}</button>
          <button class="hw-btn icon-sm seg" data-align="right" aria-label="Alinear a la derecha" title="Alinear a la derecha">${ico('align-right')}</button>
          <button class="hw-btn icon-sm" data-act="edit-text" aria-label="Editar texto en el visor" title="Editar el texto sobre el visor (doble clic)">${ico('pencil')}</button>
        </div>
      </details>`;
  }

  private syncFields(): void {
    const set = (el: HTMLInputElement | HTMLSelectElement | null, v: string) => {
      if (el && document.activeElement !== el && el.value !== v) el.value = v;
    };
    const q = <T extends HTMLElement>(s: string) => this.propsEl.querySelector<T>(s) ?? this.el.querySelector<T>(s);
    const all = <T extends HTMLElement>(s: string) => [...this.el.querySelectorAll<T>(s), ...this.propsEl.querySelectorAll<T>(s)];
    const l = this.active();
    // The top of the Capas panel and its bottom row act on the selected layer.
    for (const c of this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.layers-top [data-prop]')) c.disabled = !l;
    this.el.querySelectorAll<HTMLButtonElement>('.layers-foot [data-act]').forEach((b) => {
      b.disabled = !l && ['show-fx', 'duplicate', 'delete'].includes(b.dataset.act!);
    });
    if (!l) return;
    const r1 = (n: number) => String(Math.round(n * 10) / 10);
    for (const c of all<HTMLInputElement>('[data-prop="opacity"]')) set(c, String(Math.round(l.opacity * 100)));
    for (const c of all<HTMLSelectElement>('[data-prop="blend"]')) set(c, l.blend);
    set(q('[data-prop="scale"]'), r1(l.scaleX * 100));
    if (l.text) {
      const t = l.text;
      set(q('[data-text="content"]'), t.content);
      const vs = q<HTMLSelectElement>('[data-text="variant"]');
      if (vs) {
        const opts = this.host.fontVariants(t);
        const sig = JSON.stringify(opts);
        if (vs.dataset.sig !== sig) {
          vs.dataset.sig = sig;
          vs.innerHTML = (opts ?? []).map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
        }
        vs.disabled = !opts || opts.length < 2;
        (vs.closest('.prop-row') as HTMLElement).hidden = !opts;
        const w = t.weight ?? (t.bold ? 700 : 400);
        const want = `${w}${t.italic ? 'i' : ''}`;
        if (opts?.some((o) => o.value === want)) set(vs, want);
      }
      const note = q('[data-font-note]');
      const msg = this.host.fontNote(t);
      if (note && note.textContent !== msg) note.textContent = msg;
      set(q('[data-text="size"]'), String(Math.round(t.size * 10) / 10));
      set(q('[data-text="lineHeight"]'), String(t.lineHeight));
      set(q('[data-text="color"]'), t.color);
      q('[data-text-toggle="bold"]')?.classList.toggle('pressed', t.bold);
      q('[data-text-toggle="italic"]')?.classList.toggle('pressed', t.italic);
      this.props.querySelectorAll<HTMLElement>('[data-align]').forEach((b) => b.classList.toggle('pressed', b.dataset.align === t.align));
    }
    const locked = l.locked;
    this.props.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
      b.disabled = locked && !['up', 'down', 'duplicate', 'delete', 'rename', 'edit-text'].includes(b.dataset.act!);
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

