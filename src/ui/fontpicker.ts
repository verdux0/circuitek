/**
 * Font list inside the text panel (no dialog, so the canvas stays visible): each family is
 * written in its own font; clicking one applies it at once, ↑ ↓ browse and apply live (one
 * undo step when browsing stops). Search (debounced, accent-insensitive), category filter,
 * virtualized rows whose font loads lazily (IntersectionObserver + a load queue with a
 * concurrency limit), favourites and recents (localStorage, guarded).
 *
 * The element is persistent: the layers panel rebuilds its HTML and mounts it again, so the
 * search, filter and scroll survive.
 */
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
export type ApplyPhase = 'live' | 'end' | 'once';
export interface FontPickerHost {
  /** Fonts outside the catalog (system / computer / user files). */
  extra(): { system: string[]; local: string[]; user: string[] };
  current(): { fontId?: string; family: string } | null;
  apply(item: PickItem, phase: ApplyPhase): void;
}

const ROW = 40;
const OVERSCAN = 6;
/** The open list never gets shorter than this many rows, even in a very short panel. */
const MIN_ROWS = 4;
/** Space (px) kept under the open list inside its panel. */
const MARGIN = 8;
const DEBOUNCE = 120;
/** Browsing with the arrows stops being "live" after this pause: one undo step. */
const COMMIT_MS = 700;
const FAV_KEY = 'circuitek.fonts.favs';
const RECENT_KEY = 'circuitek.fonts.recent';
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
  private trigger: HTMLButtonElement;
  private pop: HTMLElement;
  private catSel: HTMLSelectElement;
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
  private commitTimer = 0;
  private fitTimer = 0;
  private raf = 0;
  private rows = new Map<number, HTMLElement>();
  private io: IntersectionObserver;
  private queue = new LoadQueue(4);
  private previewed = new Set<string>();
  private built = '';
  /** Time to build the list with the full catalog on first mount (ms), for the report. */
  lastOpenMs = 0;

  constructor(private host: FontPickerHost) {
    const el = document.createElement('div');
    el.className = 'fp';
    el.innerHTML = `
      <button type="button" class="fp-trigger" aria-expanded="false" aria-controls="fp-pop"
        aria-label="Fuente" title="Elegir fuente (↑ ↓ cambian a la anterior / siguiente sin abrir la lista)">
        <span class="fp-cur-name"></span><span class="fp-chev" aria-hidden="true"></span>
      </button>
      <div class="fp-pop" id="fp-pop" hidden>
      <div class="fp-bar">
        <input type="search" class="fp-q" maxlength="60" autocomplete="off" spellcheck="false"
          role="combobox" aria-expanded="true" aria-controls="fp-list" aria-autocomplete="list"
          placeholder="Buscar fuente…" aria-label="Buscar fuente por nombre" />
        <select class="fp-cat" aria-label="Filtrar fuentes por categoría"></select>
      </div>
      <div class="fp-list" id="fp-list" role="listbox" aria-label="Fuentes: clic o ↑ ↓ para aplicarlas" tabindex="0"><div class="fp-spacer"></div></div>
      <p class="fp-status" role="status" aria-live="polite"></p>
      </div>`;
    this.el = el;
    this.trigger = el.querySelector('.fp-trigger')!;
    this.pop = el.querySelector('.fp-pop')!;
    this.input = el.querySelector('.fp-q')!;
    this.catSel = el.querySelector('.fp-cat')!;
    this.list = el.querySelector('.fp-list')!;
    this.spacer = el.querySelector('.fp-spacer')!;
    this.status = el.querySelector('.fp-status')!;
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) this.preview(e.target as HTMLElement);
    }, { root: this.list, rootMargin: '40px 0px' });
    onFontState((id, s) => {
      for (const r of this.rows.values()) if (r.dataset.key === id) this.paintState(r, s);
    });
    this.bind();
  }

  get expanded(): boolean {
    return !this.pop.hidden;
  }

  /** Puts the control into the text panel (again after each rebuild of the panel). */
  async mount(slot: HTMLElement): Promise<void> {
    const scroll = this.list.scrollTop;
    slot.append(this.el);
    this.list.scrollTop = scroll;
    this.markCurrent();
    if (this.expanded) {
      await this.ensureBuilt();
      this.markCurrent(true);
    }
  }

  /** Opens the list under the field (nothing is fetched before this). */
  async expand(focusSearch = true): Promise<void> {
    this.pop.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.el.classList.add('open');
    if (focusSearch) this.input.focus({ preventScroll: true });
    await this.ensureBuilt();
    this.fitToPanel();
    this.markCurrent(true);
  }

  /**
   * The list lives inside a dock panel of limited height (Propiedades). Opened under the font
   * field it used to fall below the panel's visible area, so it looked empty. Fit the list to
   * the space the panel has (never fewer than MIN_ROWS rows, never more than its CSS height)
   * and scroll the panel so the whole list is in view.
   */
  private fitToPanel(): void {
    if (this.pop.hidden) return;
    const scroller = this.el.closest<HTMLElement>('.dock-content');
    this.list.style.maxHeight = '';
    if (scroller) {
      const extra = this.pop.offsetHeight - this.list.offsetHeight; // search bar, status…
      const room = scroller.clientHeight - this.trigger.offsetHeight - extra - MARGIN;
      this.list.style.maxHeight = `${Math.max(MIN_ROWS * ROW, room)}px`;
    }
    // Field + list now fit in the panel: bring both into view (moves only as much as needed).
    this.el.scrollIntoView({ block: 'nearest' });
    this.render();
  }

  collapse(focusTrigger = true): void {
    if (this.commitTimer) this.commit();
    this.pop.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.el.classList.remove('open');
    if (focusTrigger) this.trigger.focus();
  }

  /** Loads the catalog and builds the items (once, or again when the extra fonts change). */
  private async ensureBuilt(): Promise<void> {
    if (!catalogLoaded()) this.status.textContent = 'Cargando fuentes…';
    const t0 = performance.now();
    const cat = await loadCatalog();
    if (!this.el.isConnected) return;
    const ex = this.host.extra();
    const sig = `${!!cat}|${ex.system.length}|${ex.local.length}|${ex.user.join(',')}`;
    if (sig !== this.built) {
      this.built = sig;
      this.items = this.buildItems();
      this.renderCats();
      this.filter();
      if (!this.lastOpenMs) this.lastOpenMs = performance.now() - t0;
      if (!cat) this.status.textContent = 'Biblioteca no disponible en esta versión: fuentes incluidas, del sistema y propias.';
    }
  }

  /** Shows the layer's font in the field and highlights it in the list (scrolling to it when asked). */
  markCurrent(scroll = false): void {
    const cur = this.host.current();
    const nm = this.trigger.querySelector<HTMLElement>('.fp-cur-name')!;
    if (cur && nm.textContent !== cur.family) {
      nm.textContent = cur.family;
      nm.style.fontFamily = cssFamily(cur.family);
      this.trigger.setAttribute('aria-label', `Fuente: ${cur.family}`);
    }
    const i = cur ? this.view.findIndex((x) => x.key === cur.fontId || (!cur.fontId && x.family === cur.family)) : -1;
    if (i >= 0) this.setActive(i, scroll);
    for (const r of this.rows.values()) r.classList.toggle('fp-cur', !!cur && (r.dataset.key === cur.fontId || r.dataset.family === cur.family));
  }

  private buildItems(): PickItem[] {
    const out: PickItem[] = [];
    const labels = new Map(catalogCategories().map((c) => [c.id, c.label]));
    const seen = new Set<string>();
    for (const e of catalogLoaded()?.families ?? []) {
      seen.add(e.family.toLowerCase());
      const styles = e.variable ? 'variable' : `${e.variants.length} ${e.variants.length === 1 ? 'estilo' : 'estilos'}`;
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
    add(user, 'user', 'propias', 'propia');
    add(system, 'system', 'sistema', 'sistema');
    add(local, 'local', 'equipo', 'del equipo');
    return out.sort((a, b) => a.family.localeCompare(b.family));
  }

  private renderCats(): void {
    const counts = new Map<string, number>();
    for (const it of this.items) for (const c of it.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    const opts: [string, string][] = [
      ['all', `Todas (${this.items.length})`],
      ['favs', `★ Favoritas (${this.favs.length})`],
      ['recent', 'Recientes'],
      ...catalogCategories().map((c) => [c.id, `${c.label} (${c.count})`] as [string, string]),
      ...EXTRA_CATS.filter(([id]) => counts.get(id)).map(([id, l]) => [id, `${l} (${counts.get(id)})`] as [string, string]),
    ];
    if (!opts.some(([id]) => id === this.cat)) this.cat = 'all';
    this.catSel.innerHTML = opts.map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('');
    this.catSel.value = this.cat;
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
    this.status.textContent = n ? `${n} ${n === 1 ? 'fuente' : 'fuentes'} · clic o ↑ ↓ para aplicar` : 'Ninguna fuente coincide';
    this.render();
    this.markCurrent();
  }

  /** Renders the rows in (and near) the viewport. */
  private render(): void {
    const top = this.list.scrollTop;
    const h = this.list.clientHeight || 280;
    const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const last = Math.min(this.view.length - 1, Math.ceil((top + h) / ROW) + OVERSCAN);
    for (const [i, r] of this.rows) {
      if (i < first || i > last) {
        this.io.unobserve(r);
        r.remove();
        this.rows.delete(i);
      }
    }
    const cur = this.host.current();
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const it = this.view[i];
      const r = document.createElement('div');
      r.className = 'fp-row';
      r.id = `fp-o-${i}`;
      r.setAttribute('role', 'option');
      r.setAttribute('aria-selected', String(i === this.active));
      r.setAttribute('aria-label', `${it.family}, ${it.meta}`);
      r.dataset.i = String(i);
      r.dataset.key = it.key;
      r.dataset.family = it.family;
      r.style.top = `${i * ROW}px`;
      if (cur && (it.key === cur.fontId || it.family === cur.family)) r.classList.add('fp-cur');
      const fav = this.favs.includes(it.key);
      r.innerHTML = `
        <span class="fp-prev">${escapeHtml(it.family)}</span>
        <small class="fp-meta">${escapeHtml(it.meta)}</small>
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
    const e = it.entry;
    this.queue.push(async () => {
      if (!r.isConnected) return; // scrolled away before its turn
      const ok = await loadVariant(e, 400, false, it.family);
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
      const h = this.list.clientHeight || 280;
      if (y < this.list.scrollTop) this.list.scrollTop = y;
      else if (y + ROW > this.list.scrollTop + h) this.list.scrollTop = y + ROW - h;
      this.render();
    }
    for (const [k, r] of this.rows) r.setAttribute('aria-selected', String(k === this.active));
    this.input.setAttribute('aria-activedescendant', `fp-o-${this.active}`);
    this.list.setAttribute('aria-activedescendant', `fp-o-${this.active}`);
  }

  private choose(i: number, phase: ApplyPhase): void {
    const it = this.view[i];
    if (!it) return;
    this.setActive(i, true);
    this.host.apply(it, phase);
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    if (phase === 'live') this.commitTimer = window.setTimeout(() => this.commit(), COMMIT_MS);
    else this.remember(it);
    for (const r of this.rows.values()) r.classList.toggle('fp-cur', r.dataset.key === it.key);
  }

  /** Ends a live browse: one undo step, and the font goes to the recents. */
  private commit(): void {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    const it = this.view[this.active];
    if (!it) return;
    this.host.apply(it, 'end');
    this.remember(it);
  }

  private remember(it: PickItem): void {
    this.recent = pushRecent(this.recent, it.key);
    writeList(store(), RECENT_KEY, this.recent);
  }

  private toggleFav(i: number): void {
    const it = this.view[i];
    if (!it) return;
    this.favs = this.favs.includes(it.key) ? this.favs.filter((k) => k !== it.key) : [it.key, ...this.favs];
    writeList(store(), FAV_KEY, this.favs);
    const b = this.rows.get(i)?.querySelector<HTMLButtonElement>('[data-fav]');
    if (b) {
      const on = this.favs.includes(it.key);
      b.textContent = on ? '★' : '☆';
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', `${on ? 'Quitar de favoritas' : 'Añadir a favoritas'}: ${it.family}`);
    }
    const o = this.catSel.querySelector<HTMLOptionElement>('option[value="favs"]');
    if (o) o.textContent = `★ Favoritas (${this.favs.length})`;
  }

  private bind(): void {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('.fp-row');
      if (!row) return;
      e.stopPropagation();
      const i = Number(row.dataset.i);
      if (t.closest('[data-fav]')) return this.toggleFav(i);
      this.choose(i, 'once');
    });
    this.trigger.addEventListener('click', () => (this.expanded ? this.collapse() : void this.expand()));
    // A click elsewhere closes the list (the choice is already applied).
    document.addEventListener('pointerdown', (e) => {
      if (this.expanded && this.el.isConnected && !this.el.contains(e.target as Node)) this.collapse(false);
    });
    this.el.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && this.expanded) {
        e.preventDefault();
        e.stopPropagation();
        return this.collapse();
      }
      if (t === this.catSel) return;
      if (t === this.trigger && !this.items.length && /^(ArrowUp|ArrowDown)$/.test(e.key)) {
        // Collapsed field: ↑ ↓ change the font like a native select (the list is built first).
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        void this.ensureBuilt().then(() => {
          this.markCurrent();
          this.choose(this.active + step, 'live');
        });
        return;
      }
      if (t === this.trigger && e.key === 'Enter') return;
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 8 : e.key === 'PageUp' ? -8 : 0;
      if (step) {
        e.preventDefault();
        e.stopPropagation();
        this.choose(this.active + step, 'live');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) return this.toggleFav(this.active);
        if (this.commitTimer) this.commit();
        else this.choose(this.active, 'once');
        this.collapse();
      }
    });
    // The panel changes height with the window (and the dock layout): refit while open.
    window.addEventListener('resize', () => {
      clearTimeout(this.fitTimer);
      this.fitTimer = window.setTimeout(() => this.fitToPanel(), 150);
    });
    this.list.addEventListener('focusout', () => {
      if (this.commitTimer) this.commit();
    });
    this.input.addEventListener('input', (e) => {
      e.stopPropagation();
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.filter(), DEBOUNCE);
    });
    this.catSel.addEventListener('change', (e) => {
      e.stopPropagation();
      this.cat = this.catSel.value;
      this.filter();
    });
    this.list.addEventListener('scroll', () => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.render());
    }, { passive: true });
  }
}
