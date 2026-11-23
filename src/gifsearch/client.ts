/**
 * Minimal client for GifCities (Internet Archive's search of GIFs saved from GeoCities).
 *
 * Endpoint (checked by hand on 18-11-2026, see PLAN-GIFS.md): the original JSON API
 * `https://gifcities.archive.org/api/v1/gifsearch?q=…&limit=N`, which sends CORS headers. The
 * newer gifcities.org/search is HTML without CORS. Images come from
 * `https://blob.gifcities.org/gifcities/<CHECKSUM>.gif` with `Access-Control-Allow-Origin: *`.
 *
 * Everything remote is untrusted: only https and the expected hosts, strict checksum format,
 * size / frame / dimension limits, and no HTML built from remote strings (callers use the DOM).
 */

export const API_ORIGIN = 'https://gifcities.archive.org';
export const API_PATH = '/api/v1/gifsearch';
export const BLOB_PREFIX = 'https://blob.gifcities.org/gifcities/';
export const SITE_URL = 'https://gifcities.org/';

/**
 * Results asked per request. The API has no server pagination, only `limit`, and it takes about
 * 7 s to answer whatever the limit (measured 23-11-2026: TTFB ≈ 6.5–7.3 s for limit 60 and 300;
 * the body itself downloads in ≈ 0.15 s). So the first request asks for a comfortable 300 (12
 * pages), and the next one jumps straight to the maximum, fetched in the background while the
 * user is still looking at the first batch.
 */
export const LIMIT_FIRST = 300;
export const LIMIT_MAX = 1200;
/** Results revealed at a time (each thumbnail is a whole GIF, so fewer at once = lighter). */
export const PAGE = 24;
/** Searches kept in memory (repeating one, or going back to it, needs no request). */
export const CACHE_SIZE = 20;

/** Next `limit` to ask for once the current results run low: ×4 (300 → 1200), capped at LIMIT_MAX. */
export function nextLimit(limit: number): number {
  return Math.min(LIMIT_MAX, Math.max(LIMIT_FIRST, Math.floor(limit) * 4));
}

/** Normalised cache key of a query (same rules as buildSearchUrl, case-insensitive). */
export function queryKey(q: string): string {
  return q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY).toLowerCase();
}

/** What a finished search left: results, the limit asked for and how many the API returned. */
export interface SearchEntry {
  results: GifResult[];
  limit: number;
  lastBatch: number;
}

/** Small LRU of finished searches, by queryKey. */
export class SearchCache {
  private map = new Map<string, SearchEntry>();
  constructor(private readonly max = CACHE_SIZE) {}
  get(q: string): SearchEntry | undefined {
    const k = queryKey(q);
    const e = this.map.get(k);
    if (e) {
      // Refresh its place in the LRU order.
      this.map.delete(k);
      this.map.set(k, e);
    }
    return e;
  }
  set(q: string, e: SearchEntry): void {
    const k = queryKey(q);
    if (!k) return;
    this.map.delete(k);
    this.map.set(k, e);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  get size(): number {
    return this.map.size;
  }
}

/** True when the API may have more results than `lastBatch` (it filled the whole limit). */
export const mayHaveMore = (e: Pick<SearchEntry, 'limit' | 'lastBatch'>): boolean => e.lastBatch >= e.limit && e.limit < LIMIT_MAX;

export const MAX_GIF_BYTES = 10 * 1024 * 1024;
export const MAX_GIF_FRAMES = 600;
export const MAX_GIF_SIDE = 2048;
export const SEARCH_TIMEOUT = 20000;
export const DOWNLOAD_TIMEOUT = 30000;
export const MAX_QUERY = 100;

export interface GifResult {
  checksum: string;
  /** Direct image URL (blob.gifcities.org). */
  gif: string;
  /** Wayback Machine page the GIF was found on (null if missing or not trusted). */
  page: string | null;
  width: number;
  height: number;
  /** Words from the original URL (plain text, never HTML). */
  title: string;
}

const CHECKSUM = /^[A-Z2-7]{32}$/;

/** Builds the search URL; null for an empty query. The query is trimmed and capped. */
export function buildSearchUrl(q: string, limit = LIMIT_FIRST): string | null {
  const term = q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  if (!term) return null;
  const u = new URL(API_PATH, API_ORIGIN);
  u.searchParams.set('q', term);
  u.searchParams.set('limit', String(Math.max(1, Math.min(LIMIT_MAX, Math.floor(limit)))));
  return u.href;
}

/** True when `url` is https on exactly `host` (no credentials, no odd ports). */
export function isHost(url: string, host: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === host && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Image URL for a checksum, or null if the checksum is not the expected base32 hash. */
export function gifUrl(checksum: unknown): string | null {
  return typeof checksum === 'string' && CHECKSUM.test(checksum) ? `${BLOB_PREFIX}${checksum}.gif` : null;
}

/** Only images from the GifCities blob store, by exact checksum path. */
export function isAllowedGifUrl(url: string): boolean {
  if (!isHost(url, 'blob.gifcities.org')) return false;
  const m = /^\/gifcities\/([A-Z2-7]{32})\.gif$/.exec(new URL(url).pathname);
  return !!m;
}

/** Wayback Machine page links only (shown as "página original"). */
export function safePageUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2000) return null;
  return isHost(url, 'web.archive.org') && new URL(url).pathname.startsWith('/web/') ? url : null;
}

const clampDim = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(10000, Math.round(v)) : 0);

/**
 * Parses the API's JSON (already `JSON.parse`d). Drops entries without a real image
 * (checksum "-"), with an unexpected checksum, and duplicates; never throws on bad input.
 */
export function parseResults(data: unknown): GifResult[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: GifResult[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const gif = gifUrl(r.checksum);
    if (!gif || seen.has(r.checksum as string)) continue;
    seen.add(r.checksum as string);
    const title = typeof r.url_text === 'string' ? r.url_text.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    out.push({ checksum: r.checksum as string, gif, page: safePageUrl(r.page), width: clampDim(r.width), height: clampDim(r.height), title });
  }
  return out;
}

/** File name for a downloaded result: words from its title, else the checksum. */
export function resultFileName(r: GifResult): string {
  const words = r.title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 6).join('-');
  return `${words || r.checksum.slice(0, 12).toLowerCase()}.gif`;
}

export class SearchError extends Error {
  constructor(message: string, readonly kind: 'offline' | 'network' | 'http' | 'format' | 'limit' | 'timeout') {
    super(message);
  }
}

/** Abort on the caller's signal OR after `ms` (timeout reported as such). */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ac = new AbortController();
  let timed = false;
  const t = setTimeout(() => {
    timed = true;
    ac.abort();
  }, ms);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  return { signal: ac.signal, timedOut: () => timed, done: () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); } };
}

const fetchOpts = (signal: AbortSignal): RequestInit => ({ signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'default', mode: 'cors' });

/** Runs a search. Throws SearchError (or AbortError if the caller aborted). */
export async function search(q: string, limit: number, signal?: AbortSignal, f: typeof fetch = fetch): Promise<GifResult[]> {
  const url = buildSearchUrl(q, limit);
  if (!url) return [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SearchError('Sin conexión', 'offline');
  const to = withTimeout(signal, SEARCH_TIMEOUT);
  try {
    let res: Response;
    try {
      res = await f(url, fetchOpts(to.signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      if (to.timedOut()) throw new SearchError('GifCities no responde (tiempo agotado)', 'timeout');
      throw new SearchError('No se pudo contactar con GifCities', 'network');
    }
    if (!res.ok) throw new SearchError(`GifCities respondió ${res.status}`, 'http');
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (to.timedOut()) throw new SearchError('GifCities no responde (tiempo agotado)', 'timeout');
      throw new SearchError('La respuesta de GifCities se cortó', 'network');
    }
    if (text.length > 4 * 1024 * 1024) throw new SearchError('Respuesta demasiado grande', 'limit');
    try {
      return parseResults(JSON.parse(text));
    } catch {
      throw new SearchError('Respuesta inesperada de GifCities', 'format');
    }
  } finally {
    to.done();
  }
}

/* ------------------------------------ GIF checks ------------------------------------ */

/**
 * Validates GIF bytes before decoding: signature, logical screen size and frame count
 * (stops counting past `maxFrames`). Returns null when fine, else the reason.
 */
export function checkGif(bytes: Uint8Array, maxFrames = MAX_GIF_FRAMES, maxSide = MAX_GIF_SIDE): string | null {
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38) return 'no es un GIF';
  const w = bytes[6] | (bytes[7] << 8);
  const h = bytes[8] | (bytes[9] << 8);
  if (!w || !h) return 'GIF sin tamaño';
  if (w > maxSide || h > maxSide) return `GIF demasiado grande (${w}×${h}, máximo ${maxSide} px)`;
  let p = 13;
  if (bytes[10] & 0x80) p += 3 * (1 << ((bytes[10] & 7) + 1));
  let frames = 0;
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3b) break;
    if (b === 0x21) {
      p += 2;
      while (p < bytes.length && bytes[p] !== 0) p += bytes[p] + 1;
      p++;
    } else if (b === 0x2c) {
      if (++frames > maxFrames) return `demasiados fotogramas (más de ${maxFrames})`;
      const lf = bytes[p + 9];
      p += 10;
      if (lf & 0x80) p += 3 * (1 << ((lf & 7) + 1));
      p++;
      while (p < bytes.length && bytes[p] !== 0) p += bytes[p] + 1;
      p++;
    } else break;
  }
  return frames ? null : 'GIF sin fotogramas';
}

/**
 * Downloads a result's GIF with a hard size cap (stops reading past it), a timeout, and the
 * checks above. `onProgress(received, total|0)`.
 */
export async function downloadGif(url: string, signal?: AbortSignal, onProgress: (got: number, total: number) => void = () => {}, f: typeof fetch = fetch): Promise<Uint8Array> {
  if (!isAllowedGifUrl(url)) throw new SearchError('Dirección de imagen no permitida', 'format');
  const to = withTimeout(signal, DOWNLOAD_TIMEOUT);
  try {
    let res: Response;
    try {
      res = await f(url, fetchOpts(to.signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      if (to.timedOut()) throw new SearchError('La descarga tarda demasiado', 'timeout');
      throw new SearchError('No se pudo descargar el GIF', 'network');
    }
    if (!res.ok) throw new SearchError(`El GIF respondió ${res.status}`, 'http');
    const type = res.headers.get('content-type') ?? '';
    if (type && !/^image\/gif\b/i.test(type)) throw new SearchError('El archivo no es un GIF', 'format');
    const total = Number(res.headers.get('content-length')) || 0;
    if (total > MAX_GIF_BYTES) throw new SearchError(`GIF de más de ${MAX_GIF_BYTES / 1048576} MB`, 'limit');
    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let got = 0;
    if (reader) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal?.aborted) throw err;
          throw new SearchError(to.timedOut() ? 'La descarga tarda demasiado' : 'Descarga interrumpida', to.timedOut() ? 'timeout' : 'network');
        }
        if (chunk.done) break;
        got += chunk.value.byteLength;
        if (got > MAX_GIF_BYTES) {
          await reader.cancel().catch(() => {});
          throw new SearchError(`GIF de más de ${MAX_GIF_BYTES / 1048576} MB`, 'limit');
        }
        parts.push(chunk.value);
        onProgress(got, total);
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_GIF_BYTES) throw new SearchError(`GIF de más de ${MAX_GIF_BYTES / 1048576} MB`, 'limit');
      parts.push(buf);
      got = buf.byteLength;
    }
    const bytes = new Uint8Array(got);
    let o = 0;
    for (const p of parts) {
      bytes.set(p, o);
      o += p.byteLength;
    }
    const why = checkGif(bytes);
    if (why) throw new SearchError(why, 'format');
    return bytes;
  } finally {
    to.done();
  }
}
