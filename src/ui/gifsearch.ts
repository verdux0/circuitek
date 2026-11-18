/**
 * "Buscar GIF" panel: searches GifCities (Internet Archive) and imports the chosen GIF.
 *
 * Privacy: nothing is requested until the user searches (typing, debounced 400 ms, or Enter);
 * only the search text leaves the app; no cookies, no referrer, no analytics.
 * Safety: remote strings only go into textContent / validated attributes, never innerHTML.
 */
import { ico } from './icons';
import {
  LIMIT_MAX, LIMIT_STEP, PAGE, SITE_URL, SearchError, downloadGif, resultFileName, search, type GifResult,
} from '../gifsearch/client';

export interface GifSearchHost {
  toast(msg: string): void;
  /** Imports a file exactly like a drop / paste (GIFs become animated layers). */
  importFile(f: File): Promise<void>;
}

const DEBOUNCE = 400;

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
  private limit = LIMIT_STEP;
  private all: GifResult[] = [];
  private shown = 0;
  private restoreFocus: HTMLElement | null = null;

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
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(this.input.value), DEBOUNCE);
    });
    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      clearTimeout(this.timer);
      void this.run(this.input.value, true);
    });
    this.more.addEventListener('click', () => void this.loadMore());
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

  /** New search (previous one aborted). `force` repeats the same query. */
  private async run(q: string, force = false): Promise<void> {
    const term = q.trim();
    if (!term) {
      this.searchAc?.abort();
      this.clear();
      this.setStatus('', '');
      return;
    }
    if (term === this.query && !force && this.all.length) return;
    this.query = term;
    this.limit = LIMIT_STEP;
    this.clear();
    await this.fetchPage(true);
  }

  private clear(): void {
    this.all = [];
    this.shown = 0;
    this.grid.replaceChildren();
    this.more.hidden = true;
  }

  /** Fetches `limit` results for the current query; `fresh` = first page. */
  private async fetchPage(fresh: boolean): Promise<void> {
    this.searchAc?.abort();
    const ac = new AbortController();
    this.searchAc = ac;
    this.setStatus(`Buscando «${this.query}»…`, 'loading');
    this.more.disabled = true;
    try {
      const res = await search(this.query, this.limit, ac.signal);
      if (ac.signal.aborted) return;
      const known = new Set(this.all.map((r) => r.checksum));
      const add = res.filter((r) => !known.has(r.checksum));
      this.all.push(...add);
      this.lastBatch = res.length;
      if (!this.all.length) {
        this.setStatus(`Sin resultados para «${this.query}». Prueba otra palabra (en inglés suele haber más).`, 'empty');
        return;
      }
      this.reveal(fresh ? PAGE : PAGE);
    } catch (err) {
      if (ac.signal.aborted || (err as Error).name === 'AbortError') return;
      const e = err as SearchError;
      if (e.kind === 'offline') this.setStatus('Sin conexión: la búsqueda necesita internet.', 'offline', true);
      else this.setStatus(`${e.message}. Puedes reintentar o usar «Abrir gifcities.org».`, 'error', true);
    } finally {
      if (this.searchAc === ac) this.searchAc = null;
      this.more.disabled = false;
    }
  }

  private lastBatch = 0;

  /** Shows the next `n` results; "Cargar más" asks the API for more when the list runs out. */
  private reveal(n: number): void {
    const next = this.all.slice(this.shown, this.shown + n);
    for (const r of next) this.grid.append(this.tile(r));
    this.shown += next.length;
    const canFetch = this.lastBatch >= this.limit && this.limit < LIMIT_MAX;
    this.more.hidden = !(this.shown < this.all.length || canFetch);
    this.setStatus(`${this.shown} de ${this.all.length}${canFetch ? '+' : ''} resultados para «${this.query}». Toca uno para usarlo.`, '');
  }

  private async loadMore(): Promise<void> {
    if (this.shown < this.all.length) return this.reveal(PAGE);
    if (this.lastBatch >= this.limit && this.limit < LIMIT_MAX) {
      this.limit = Math.min(LIMIT_MAX, this.limit + LIMIT_STEP);
      await this.fetchPage(false);
    }
  }

  /** One result, built with the DOM API (remote strings never become HTML). */
  private tile(r: GifResult): HTMLElement {
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
    img.loading = 'lazy';
    img.decoding = 'async';
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
