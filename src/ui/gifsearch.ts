/**
 * "Buscar GIF" panel: searches GifCities (Internet Archive) and imports the chosen GIF.
 *
 * Privacy: nothing is requested until the user searches (typing, debounced 400 ms, or Enter);
 * only the search text leaves the app; no cookies, no referrer, no analytics.
 * Safety: remote strings only go into textContent / validated attributes, never innerHTML.
 */
import { ico } from './icons';
import {
  API_ORIGIN, BLOB_PREFIX, LIMIT_FIRST, PAGE, SITE_URL, SearchCache, SearchError, downloadGif, mayHaveMore, nextLimit, resultFileName, search,
  type GifResult,
} from '../gifsearch/client';

export interface GifSearchHost {
  toast(msg: string): void;
  /** Imports a file exactly like a drop / paste (GIFs become animated layers). */
  importFile(f: File): Promise<void>;
}

const DEBOUNCE = 350;
/** Thumbnails of the first rows load at high priority; the rest wait (each one is a whole GIF). */
const EAGER_TILES = 8;
/** Start fetching the next batch when fewer than this many pages are left to show. */
const PREFETCH_PAGES = 3;

export class GifSearchPanel {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private grid: HTMLElement;
  private status: HTMLElement;
  private more: HTMLButtonElement;
  private dl: HTMLElement;
  private dlMsg: HTMLElement;
  private dlBar: HTMLProgressElement;
  private timer = 0;
  private searchAc: AbortController | null = null;
  private dlAc: AbortController | null = null;
  private query = '';
  private limit = LIMIT_FIRST;
  private all: GifResult[] = [];
  private shown = 0;
  private lastBatch = 0;
  private restoreFocus: HTMLElement | null = null;
  /** Finished searches: repeating one (or going back to it) is instant and needs no request. */
  private cache = new SearchCache();
  /** Background request for the next, larger batch (started when the shown results run low). */
  private prefetch: Promise<boolean> | null = null;
  /** Reveals the next page when the last tile scrolls near the view (infinite scroll). */
  private io: IntersectionObserver | null = null;
  private preconnected = false;

  constructor(private host: GifSearchHost) {
    const el = document.createElement('div');
    el.className = 'sheet-backdrop gs-backdrop';
    el.hidden = true;
    // Static markup only (no remote data here).
    el.innerHTML = `
      <section class="sheet gs-sheet" role="dialog" aria-modal="true" aria-labelledby="gs-title">
        <header class="sheet-head">
          <h2 id="gs-title">Buscar GIF</h2>
          <button class="hw-btn icon sheet-close" data-act="close" aria-label="Cerrar" title="Cerrar (Esc)">${ico('close')}</button>
        </header>
        <p class="gs-privacy">Al buscar, la app contacta con el <b>Internet Archive</b> (gifcities.archive.org y blob.gifcities.org) y solo envía el texto que escribes. Tus imágenes y tus datos no salen de la app. Sin cookies ni analytics.</p>
        <form class="gs-form" role="search">
          <input type="search" id="gs-q" maxlength="100" autocomplete="off" spellcheck="false" enterkeyhint="search"
            placeholder="p. ej. under construction, dancing baby…" aria-label="Buscar GIFs en GifCities" />
          <button type="submit" class="hw-btn accent" id="gs-go">Buscar</button>
        </form>
        <p class="gs-status" id="gs-status" role="status" aria-live="polite"></p>
        <div class="gs-grid" id="gs-grid" role="list" aria-label="Resultados"></div>
        <div class="gs-more-row"><button type="button" class="hw-btn" id="gs-more" hidden>Cargar más</button></div>
        <div class="gs-dl" id="gs-dl" hidden>
          <progress id="gs-dl-bar" max="1" value="0" aria-label="Descarga"></progress>
          <span id="gs-dl-msg" aria-live="polite"></span>
          <button type="button" class="hw-btn hw-btn-sm" id="gs-dl-cancel">Cancelar</button>
        </div>
        <footer class="gs-foot">
          <p class="gs-rights">Son GIFs de páginas de GeoCities (1994-2009) <b>sin licencia clara: no son libres de derechos</b>. Tú eres responsable de lo que uses o publiques. Esta búsqueda <b>no filtra contenido adulto</b>.</p>
          <p class="gs-credit">Fuente: <a href="${SITE_URL}" target="_blank" rel="noopener noreferrer">GifCities</a> · Internet Archive.
            <a class="gs-manual" href="${SITE_URL}" target="_blank" rel="noopener noreferrer">Abrir gifcities.org ↗</a>
            <span>(si la búsqueda falla: descarga el GIF allí y arrástralo o pégalo aquí)</span></p>
        </footer>
      </section>`;
    this.el = el;
    this.input = el.querySelector('#gs-q')!;
    this.grid = el.querySelector('#gs-grid')!;
    this.status = el.querySelector('#gs-status')!;
    this.more = el.querySelector('#gs-more')!;
    this.dl = el.querySelector('#gs-dl')!;
    this.dlMsg = el.querySelector('#gs-dl-msg')!;
    this.dlBar = el.querySelector('#gs-dl-bar')!;
    this.bind();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.restoreFocus = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    if (!navigator.onLine) this.setStatus('Sin conexión: la búsqueda necesita internet.', 'offline');
    this.input.focus();
  }

  close(): void {
    this.el.hidden = true;
    clearTimeout(this.timer);
    this.searchAc?.abort();
    this.dlAc?.abort();
    if (this.restoreFocus?.isConnected) this.restoreFocus.focus();
  }

  private bind(): void {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-act="close"]')) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.dlAc) this.dlAc.abort();
        else this.close();
      }
    });
    this.input.addEventListener('input', () => {
      if (this.input.value.trim()) this.warmUp();
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(this.input.value), DEBOUNCE);
    });
    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      clearTimeout(this.timer);
      // Enter on a new term searches at once; a term searched before comes from the cache.
      void this.run(this.input.value);
    });
    this.more.addEventListener('click', () => void this.loadMore());
    // Infinite scroll; the «Cargar más» button stays for keyboards and old browsers.
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting) && !this.more.hidden && !this.more.disabled && this.isOpen) void this.loadMore();
      }, { root: this.grid, rootMargin: '0px 0px 300px 0px' });
    }
    this.el.querySelector('#gs-dl-cancel')!.addEventListener('click', () => this.dlAc?.abort());
    window.addEventListener('offline', () => this.isOpen && this.setStatus('Sin conexión: la búsqueda necesita internet.', 'offline'));
    window.addEventListener('online', () => this.isOpen && this.status.dataset.kind === 'offline' && this.setStatus('Conexión recuperada.', ''));
  }

  private setStatus(text: string, kind: '' | 'loading' | 'empty' | 'error' | 'offline', retry = false): void {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hw-btn hw-btn-sm gs-retry';
      b.textContent = 'Reintentar';
      b.addEventListener('click', () => void this.run(this.query, true));
      this.status.append(' ', b);
    }
  }

  /**
   * Opens a connection to both hosts while the user types (DNS + TLS ahead of the search).
   * It only connects: no request and no text is sent until the search itself runs.
   */
  private warmUp(): void {
    if (this.preconnected) return;
    this.preconnected = true;
    for (const href of [API_ORIGIN, new URL(BLOB_PREFIX).origin]) {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = href;
      l.crossOrigin = 'anonymous';
      document.head.append(l);
    }
  }

  /** New search (previous one aborted). `force` repeats the same query against the network. */
  private async run(q: string, force = false): Promise<void> {
    const term = q.trim();
    if (!term) {
      this.searchAc?.abort();
      this.clear();
      this.setStatus('', '');
      return;
    }
    if (term === this.query && !force && this.all.length) return;
    this.searchAc?.abort();
    this.query = term;
    this.clear();
    const hit = force ? undefined : this.cache.get(term);
    if (hit) {
      this.all = hit.results.slice();
      this.limit = hit.limit;
      this.lastBatch = hit.lastBatch;
      this.reveal(PAGE);
      return;
    }
    this.limit = LIMIT_FIRST;
    await this.fetchPage();
  }

  private clear(): void {
    this.all = [];
    this.shown = 0;
    this.lastBatch = 0;
    this.prefetch = null;
    this.io?.disconnect();
    this.grid.replaceChildren();
    this.more.hidden = true;
  }

  /**
   * Fetches `limit` results for the current query and adds the new ones. `quiet` = background
   * prefetch: no «Buscando…» status, and an error is left for the next explicit «Cargar más».
   * Returns true when the request succeeded.
   */
  private async fetchPage(quiet = false): Promise<boolean> {
    this.searchAc?.abort();
    const ac = new AbortController();
    this.searchAc = ac;
    const query = this.query;
    const limit = this.limit;
    if (!quiet) {
      this.setStatus(`Buscando «${query}»…`, 'loading');
      this.more.disabled = true;
    }
    try {
      const res = await search(query, limit, ac.signal);
      if (ac.signal.aborted || query !== this.query) return false;
      const known = new Set(this.all.map((r) => r.checksum));
      this.all.push(...res.filter((r) => !known.has(r.checksum)));
      this.lastBatch = res.length;
      this.cache.set(query, { results: this.all.slice(), limit, lastBatch: res.length });
      if (!this.all.length) {
        this.setStatus(`Sin resultados para «${query}». Prueba otra palabra (en inglés suele haber más).`, 'empty');
        return true;
      }
      if (quiet) {
        this.updateMore();
        // Re-observing reports the current intersection: if the end is already in view, the
        // next page appears without another scroll.
        this.watchEnd();
      }
      else this.reveal(PAGE);
      return true;
    } catch (err) {
      if (ac.signal.aborted || (err as Error).name === 'AbortError' || quiet) return false;
      const e = err as SearchError;
      if (e.kind === 'offline') this.setStatus('Sin conexión: la búsqueda necesita internet.', 'offline', true);
      else this.setStatus(`${e.message}. Puedes reintentar o usar «Abrir gifcities.org».`, 'error', true);
      return false;
    } finally {
      if (this.searchAc === ac) this.searchAc = null;
      if (!quiet) this.more.disabled = false;
    }
  }

  private get canFetch(): boolean {
    return mayHaveMore({ limit: this.limit, lastBatch: this.lastBatch });
  }

  private updateMore(): void {
    this.more.hidden = !(this.shown < this.all.length || this.canFetch);
    this.setStatus(`${this.shown} de ${this.all.length}${this.canFetch ? '+' : ''} resultados para «${this.query}». Toca uno para usarlo.`, '');
  }

  /** Shows the next `n` results in one DOM write, and prefetches the next batch when they run low. */
  private reveal(n: number): void {
    const next = this.all.slice(this.shown, this.shown + n);
    const frag = document.createDocumentFragment();
    next.forEach((r, i) => frag.append(this.tile(r, this.shown + i < EAGER_TILES)));
    this.grid.append(frag);
    this.shown += next.length;
    this.updateMore();
    this.watchEnd();
    // Fewer than PREFETCH_PAGES pages left and the API may have more: fetch the next batch in the
    // background (it takes ~7 s), so scrolling / «Cargar más» finds it ready.
    if (this.all.length - this.shown < PAGE * PREFETCH_PAGES && this.canFetch && !this.prefetch && !this.searchAc) {
      this.limit = nextLimit(this.limit);
      const p = this.fetchPage(true);
      this.prefetch = p;
      void p.then(() => {
        if (this.prefetch === p) this.prefetch = null;
      });
    }
  }

  /** Observes the last tile, so scrolling near the end reveals the next page. */
  private watchEnd(): void {
    if (!this.io) return;
    this.io.disconnect();
    const last = this.grid.lastElementChild;
    if (last) this.io.observe(last);
  }

  private async loadMore(): Promise<void> {
    if (this.shown < this.all.length) return this.reveal(PAGE);
    if (this.prefetch) {
      this.setStatus(`Buscando más resultados de «${this.query}»…`, 'loading');
      const ok = await this.prefetch;
      if (this.shown < this.all.length) return this.reveal(PAGE);
      if (!ok) {
        // The background request failed: retry it in the open, with its error message.
        await this.fetchPage();
        return;
      }
    } else if (this.canFetch) {
      this.limit = nextLimit(this.limit);
      await this.fetchPage();
      return;
    }
    this.updateMore();
  }

  /** One result, built with the DOM API (remote strings never become HTML). */
  private tile(r: GifResult, eager = false): HTMLElement {
    const li = document.createElement('div');
    li.className = 'gs-tile';
    li.setAttribute('role', 'listitem');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gs-pick';
    const label = r.title || 'GIF sin título';
    b.setAttribute('aria-label', `Usar GIF: ${label}`);
    b.title = `${label}${r.width ? ` · ${r.width}×${r.height}` : ''}`;
    const img = document.createElement('img');
    img.loading = eager ? 'eager' : 'lazy';
    img.decoding = 'async';
    // Off-screen thumbnails must not compete with the first rows for bandwidth.
    img.fetchPriority = eager ? 'high' : 'low';
    img.referrerPolicy = 'no-referrer';
    img.crossOrigin = 'anonymous';
    img.alt = '';
    if (r.width && r.height) {
      img.width = r.width;
      img.height = r.height;
    }
    img.src = r.gif;
    img.addEventListener('error', () => li.classList.add('broken'), { once: true });
    b.append(img);
    b.addEventListener('click', () => void this.pick(r));
    const meta = document.createElement('div');
    meta.className = 'gs-meta';
    if (r.page) {
      const a = document.createElement('a');
      a.href = r.page;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Original ↗';
      a.title = 'Página original en la Wayback Machine';
      meta.append(a);
    }
    const src = document.createElement('span');
    src.textContent = 'GifCities · IA';
    src.title = 'Fuente: GifCities · Internet Archive';
    meta.append(src);
    li.append(b, meta);
    return li;
  }

  private async pick(r: GifResult): Promise<void> {
    this.dlAc?.abort();
    const ac = new AbortController();
    this.dlAc = ac;
    this.dl.hidden = false;
    this.dlBar.removeAttribute('value');
    this.dlMsg.textContent = 'Descargando GIF…';
    try {
      const bytes = await downloadGif(r.gif, ac.signal, (got, total) => {
        if (total) this.dlBar.value = got / total;
        this.dlMsg.textContent = `Descargando GIF… ${Math.round(got / 1024)} KB`;
      });
      if (ac.signal.aborted) return;
      this.dlMsg.textContent = 'Cargando…';
      await this.host.importFile(new File([bytes as BlobPart], resultFileName(r), { type: 'image/gif' }));
      this.close();
    } catch (err) {
      if (ac.signal.aborted || (err as Error).name === 'AbortError') this.host.toast('Descarga cancelada');
      else this.host.toast(`No se pudo usar ese GIF: ${(err as Error).message}`);
    } finally {
      if (this.dlAc === ac) this.dlAc = null;
      this.dl.hidden = true;
    }
  }
}
