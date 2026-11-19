/**
 * Font picker: search (debounced, accent-insensitive), category filters, a virtualized list
 * whose visible rows preview the user's text lazily (IntersectionObserver + a load queue with
 * a concurrency limit), favourites and recents (localStorage, guarded) and keyboard control
 * (combobox pattern: focus stays in the search box, arrows move the active option).
 */
import { ico } from './icons';
import {
  LoadQueue,
  catalogCategories,
  catalogLoaded,
  fontState,
  loadCatalog,
  loadVariant,
  onFontState,
  pushRecent,
  readList,
  searchFonts,
  writeList,
  type FontEntry,
} from '../fontlib';

export type PickKind = 'lib' | 'system' | 'local' | 'user';
export interface PickItem {
  /** Stable key: the catalog id, or "<kind>:<family>". Stored as the layer's fontId. */
  key: string;
  family: string;
  kind: PickKind;
  categories: string[];
  entry: FontEntry | null;
  meta: string;
}
export interface FontPickerHost {
  /** Fonts outside the catalog (system / computer / user files). */
  extra(): { system: string[]; local: string[]; user: string[] };
  /** Text of the active layer for the preview ('' = sample text). */
  previewText(): string;
  current(): { fontId?: string; family: string } | null;
  apply(item: PickItem): void;
}

const ROW = 52;
const OVERSCAN = 6;
const DEBOUNCE = 120;
const FAV_KEY = 'glitch-editor.fonts.favs';
const RECENT_KEY = 'glitch-editor.fonts.recent';
const SAMPLE = 'Glitch Ñandú 0123';
const EXTRA_CATS: [string, string][] = [
  ['sistema', 'Sistema'],
  ['equipo', 'Del equipo'],
  ['propias', 'Propias'],
];
const store = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const cssFamily = (f: string): string => `"${f.replace(/["\\]/g, '')}", sans-serif`;

export class FontPicker {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private chips: HTMLElement;
  private list: HTMLElement;
  private spacer: HTMLElement;
  private status: HTMLElement;
  private items: PickItem[] = [];
  private view: PickItem[] = [];
  private cat = 'all';
  private active = 0;
  private favs: string[] = readList(store(), FAV_KEY);
  private recent: string[] = readList(store(), RECENT_KEY, 12);
  private timer = 0;
  private raf = 0;
  private rows = new Map<number, HTMLElement>();
  private io: IntersectionObserver;
  private queue = new LoadQueue(4);
  private previewed = new Set<string>();
  private restoreFocus: HTMLElement | null = null;
  /** Time from open() to the first rendered rows with the full catalog (ms), for the report. */
  lastOpenMs = 0;

  constructor(private host: FontPickerHost) {
    const el = document.createElement('div');
    el.className = 'sheet-backdrop fp-backdrop';
    el.hidden = true;
    el.innerHTML = `
      <section class="sheet fp-sheet" role="dialog" aria-modal="true" aria-labelledby="fp-title">
        <header class="sheet-head">
          <h2 id="fp-title">Fuentes</h2>
          <button class="hw-btn icon sheet-close" data-act="close" aria-label="Cerrar" title="Cerrar (Esc)">${ico('close')}</button>
        </header>
        <input type="search" class="fp-q" id="fp-q" maxlength="60" autocomplete="off" spellcheck="false"
          role="combobox" aria-expanded="true" aria-controls="fp-list" aria-autocomplete="list"
          placeholder="Buscar fuente…" aria-label="Buscar fuente por nombre" />
        <div class="fp-chips" role="group" aria-label="Filtrar por categoría"></div>
        <p class="fp-status" role="status" aria-live="polite"></p>
        <div class="fp-list" id="fp-list" role="listbox" aria-label="Fuentes disponibles" tabindex="-1"><div class="fp-spacer"></div></div>
        <p class="fp-hint">↑ ↓ para moverte · Intro para aplicar · Mayús + Intro para marcar como favorita</p>
      </section>`;
    this.el = el;
    this.input = el.querySelector('.fp-q')!;
    this.chips = el.querySelector('.fp-chips')!;
    this.list = el.querySelector('.fp-list')!;
    this.spacer = el.querySelector('.fp-spacer')!;
    this.status = el.querySelector('.fp-status')!;
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) this.preview(e.target as HTMLElement);
    }, { root: this.list, rootMargin: '40px 0px' });
    onFontState((id, s) => {
      if (this.el.hidden) return;
      for (const r of this.rows.values()) if (r.dataset.key === id) this.paintState(r, s);
    });
    this.bind();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  async open(): Promise<void> {
    const t0 = performance.now();
    this.restoreFocus = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    this.input.value = '';
    this.cat = 'all';
    this.status.textContent = 'Cargando catálogo…';
    this.input.focus();
    const cat = await loadCatalog();
    this.items = this.buildItems();
    this.renderChips();
    this.status.textContent = cat ? '' : 'La biblioteca de fuentes no está disponible en esta versión: solo fuentes incluidas, del sistema y propias.';
    this.filter();
    const cur = this.host.current();
    const i = cur ? this.view.findIndex((x) => x.key === cur.fontId || x.family === cur.family) : -1;
    this.setActive(Math.max(0, i), true);
    this.lastOpenMs = performance.now() - t0;
  }

  close(): void {
    this.el.hidden = true;
    clearTimeout(this.timer);
    this.queue.clear();
    if (this.restoreFocus?.isConnected) this.restoreFocus.focus();
  }

  private buildItems(): PickItem[] {
    const out: PickItem[] = [];
    const labels = new Map(catalogCategories().map((c) => [c.id, c.label]));
    const seen = new Set<string>();
    for (const e of catalogLoaded()?.families ?? []) {
      seen.add(e.family.toLowerCase());
      const styles = e.variable ? 'Variable' : `${e.variants.length} ${e.variants.length === 1 ? 'estilo' : 'estilos'}`;
      out.push({ key: e.id, family: e.family, kind: 'lib', categories: e.categories, entry: e, meta: `${labels.get(e.categories[0]) ?? e.categories[0]} · ${styles}` });
    }
    const { system, local, user } = this.host.extra();
    const add = (names: string[], kind: PickKind, cat: string, meta: string) => {
      for (const f of names) {
        if (seen.has(f.toLowerCase())) continue;
        seen.add(f.toLowerCase());
        out.push({ key: `${kind}:${f}`, family: f, kind, categories: [cat], entry: null, meta });
      }
    };
    add(user, 'user', 'propias', 'Propia (solo en este equipo)');
    add(system, 'system', 'sistema', 'Sistema');
    add(local, 'local', 'equipo', 'Instalada en el equipo');
    return out.sort((a, b) => a.family.localeCompare(b.family));
  }

  private renderChips(): void {
    const counts = new Map<string, number>();
    for (const it of this.items) for (const c of it.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    const chips: [string, string][] = [
      ['all', `Todas ${this.items.length}`],
      ['favs', `★ Favoritas ${this.favs.length}`],
      ['recent', 'Recientes'],
      ...catalogCategories().map((c) => [c.id, `${c.label} ${c.count}`] as [string, string]),
      ...EXTRA_CATS.filter(([id]) => counts.get(id)).map(([id, l]) => [id, `${l} ${counts.get(id)}`] as [string, string]),
    ];
    this.chips.innerHTML = chips
      .map(([id, label]) => `<button type="button" class="fp-chip" data-cat="${escapeHtml(id)}" aria-pressed="${id === this.cat}">${escapeHtml(label)}</button>`)
      .join('');
  }

  private filter(): void {
    let base = this.items;
    if (this.cat === 'favs') base = this.items.filter((x) => this.favs.includes(x.key));
    else if (this.cat === 'recent') base = this.recent.map((k) => this.items.find((x) => x.key === k)).filter((x): x is PickItem => !!x);
    const cats = this.cat === 'all' || this.cat === 'favs' || this.cat === 'recent' ? [] : [this.cat];
    this.view = searchFonts(base, this.input.value, cats);
    this.spacer.style.height = `${this.view.length * ROW}px`;
    this.list.scrollTop = 0;
    for (const r of this.rows.values()) {
      this.io.unobserve(r);
      r.remove();
    }
    this.rows.clear();
    this.active = 0;
    const n = this.view.length;
    if (catalogLoaded() || this.items.length) this.status.textContent = n ? `${n} ${n === 1 ? 'fuente' : 'fuentes'}` : 'Ninguna fuente coincide';
    this.render();
  }

  /** Renders the rows in (and near) the viewport; reuses nothing across filters (simple + correct). */
  private render(): void {
    const top = this.list.scrollTop;
    const h = this.list.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const last = Math.min(this.view.length - 1, Math.ceil((top + h) / ROW) + OVERSCAN);
    for (const [i, r] of this.rows) {
      if (i < first || i > last) {
        this.io.unobserve(r);
        r.remove();
        this.rows.delete(i);
      }
    }
    const text = this.previewText();
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const it = this.view[i];
      const r = document.createElement('div');
      r.className = 'fp-row';
      r.id = `fp-o-${i}`;
      r.setAttribute('role', 'option');
      r.setAttribute('aria-selected', String(i === this.active));
      r.dataset.i = String(i);
      r.dataset.key = it.key;
      r.style.top = `${i * ROW}px`;
      const fav = this.favs.includes(it.key);
      r.innerHTML = `
        <span class="fp-name">${escapeHtml(it.family)}<small>${escapeHtml(it.meta)}</small></span>
        <span class="fp-prev" aria-hidden="true">${escapeHtml(text)}</span>
        <span class="fp-state" aria-hidden="true"></span>
        <button type="button" class="fp-fav" tabindex="-1" data-fav aria-pressed="${fav}" aria-label="${fav ? 'Quitar de favoritas' : 'Añadir a favoritas'}: ${escapeHtml(it.family)}">${fav ? '★' : '☆'}</button>`;
      if (it.kind !== 'lib' || this.previewed.has(it.key)) this.showPreview(r, it);
      this.list.append(r);
      this.rows.set(i, r);
      if (it.kind === 'lib' && !this.previewed.has(it.key)) {
        this.paintState(r, fontState(it.key));
        this.io.observe(r);
      }
    }
  }

  private previewText(): string {
    const t = this.host.previewText().split('\n')[0].trim().slice(0, 32);
    return t || SAMPLE;
  }

  private showPreview(r: HTMLElement, it: PickItem): void {
    (r.querySelector('.fp-prev') as HTMLElement).style.fontFamily = cssFamily(it.family);
  }

  private paintState(r: HTMLElement, s: string): void {
    const el = r.querySelector('.fp-state');
    if (!el) return;
    el.textContent = s === 'loading' ? '…' : s === 'error' ? '!' : '';
    el.setAttribute('title', s === 'error' ? 'No se pudo cargar: se reintenta al elegirla' : '');
    r.classList.toggle('fp-err', s === 'error');
  }

  private preview(r: HTMLElement): void {
    this.io.unobserve(r);
    const it = this.view[Number(r.dataset.i)];
    if (!it?.entry || this.previewed.has(it.key)) return;
    const text = this.previewText();
    const e = it.entry;
    this.queue.push(async () => {
      // Skip rows scrolled away before their turn.
      if (!r.isConnected) return;
      const ok = await loadVariant(e, 400, false, text);
      if (!ok) return;
      this.previewed.add(it.key);
      if (r.isConnected && r.dataset.key === it.key) this.showPreview(r, it);
    });
  }

  private setActive(i: number, scroll: boolean): void {
    if (!this.view.length) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.active = Math.max(0, Math.min(this.view.length - 1, i));
    if (scroll) {
      const y = this.active * ROW;
      if (y < this.list.scrollTop) this.list.scrollTop = y;
      else if (y + ROW > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = y + ROW - this.list.clientHeight;
      this.render();
    }
    for (const [k, r] of this.rows) r.setAttribute('aria-selected', String(k === this.active));
    this.input.setAttribute('aria-activedescendant', `fp-o-${this.active}`);
  }

  private choose(i: number): void {
    const it = this.view[i];
    if (!it) return;
    this.recent = pushRecent(this.recent, it.key);
    writeList(store(), RECENT_KEY, this.recent);
    this.host.apply(it);
    this.close();
  }

  private toggleFav(i: number): void {
    const it = this.view[i];
    if (!it) return;
    this.favs = this.favs.includes(it.key) ? this.favs.filter((k) => k !== it.key) : [it.key, ...this.favs];
    writeList(store(), FAV_KEY, this.favs);
    const r = this.rows.get(i);
    const b = r?.querySelector<HTMLButtonElement>('[data-fav]');
    if (b) {
      const on = this.favs.includes(it.key);
      b.textContent = on ? '★' : '☆';
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', `${on ? 'Quitar de favoritas' : 'Añadir a favoritas'}: ${it.family}`);
    }
    const chip = this.chips.querySelector<HTMLElement>('[data-cat="favs"]');
    if (chip) chip.textContent = `★ Favoritas ${this.favs.length}`;
  }

  private bind(): void {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-act="close"]')) return this.close();
      const chip = t.closest<HTMLElement>('[data-cat]');
      if (chip) {
        this.cat = chip.dataset.cat!;
        this.chips.querySelectorAll('[data-cat]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        this.filter();
        this.input.focus();
        return;
      }
      const row = t.closest<HTMLElement>('.fp-row');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (t.closest('[data-fav]')) return this.toggleFav(i);
      this.choose(i);
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.setActive(this.active + (e.key === 'ArrowDown' ? 1 : -1), true);
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        const page = Math.max(1, Math.floor(this.list.clientHeight / ROW) - 1);
        this.setActive(this.active + (e.key === 'PageDown' ? page : -page), true);
      } else if (e.key === 'Enter' && e.target === this.input) {
        e.preventDefault();
        if (e.shiftKey) this.toggleFav(this.active);
        else this.choose(this.active);
      }
    });
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.filter(), DEBOUNCE);
    });
    this.list.addEventListener('scroll', () => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.render());
    }, { passive: true });
  }
}
