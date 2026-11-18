import { describe, expect, it } from 'vitest';
import { GifWriter } from 'omggif';
import fixtureJson from './fixtures/gifcities-computer.json';
import {
  LIMIT_MAX, MAX_GIF_BYTES, SearchError, buildSearchUrl, checkGif, downloadGif, gifUrl, isAllowedGifUrl, isHost, parseResults,
  resultFileName, safePageUrl, search,
} from '../src/gifsearch/client';

// Real API response (trimmed), saved on 18-11-2026: tests never touch the network.
const fixture: unknown[] = fixtureJson;

const makeGif = (frames: number, w = 8, h = 6): Uint8Array => {
  const buf = new Uint8Array(8192);
  const g = new GifWriter(buf as unknown as number[], w, h, { palette: [0, 0xffffff], loop: 0 });
  for (let i = 0; i < frames; i++) g.addFrame(0, 0, w, h, Array.from({ length: w * h }, (_, k) => (k + i) % 2), { delay: 5 });
  return buf.slice(0, g.end());
};

/** A fake fetch returning `body` with headers; records the URL and init it was called with. */
function fakeFetch(body: BodyInit | (() => Promise<never>), init: ResponseInit = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, i?: RequestInit) => {
    calls.push({ url, init: i });
    if (typeof body === 'function') return body();
    return new Response(body, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('search URL', () => {
  it('builds the JSON API URL with q and limit, encoded', () => {
    expect(buildSearchUrl('computer')).toBe('https://gifcities.archive.org/api/v1/gifsearch?q=computer&limit=300');
    expect(buildSearchUrl('  under   construction ', 50)).toBe('https://gifcities.archive.org/api/v1/gifsearch?q=under+construction&limit=50');
    expect(buildSearchUrl('a&b=c#d')).toContain('q=a%26b%3Dc%23d');
  });
  it('empty → null; long queries capped; limit clamped', () => {
    expect(buildSearchUrl('   ')).toBeNull();
    expect(new URL(buildSearchUrl('x'.repeat(500))!).searchParams.get('q')!.length).toBe(100);
    expect(new URL(buildSearchUrl('x', 99999)!).searchParams.get('limit')).toBe(String(LIMIT_MAX));
    expect(new URL(buildSearchUrl('x', -3)!).searchParams.get('limit')).toBe('1');
  });
});

describe('parser (real fixture)', () => {
  const r = parseResults(fixture);
  it('keeps real images, drops checksum "-"', () => {
    expect(fixture.length).toBe(11);
    expect(r.length).toBe(10);
    expect(r.every((x) => x.checksum !== '-')).toBe(true);
  });
  it('maps checksum → blob URL, Wayback page, size and title', () => {
    expect(r[0]).toEqual({
      checksum: '3VOFVM3PZ2T7GHF52NCCCVJATK3C7ILZ',
      gif: 'https://blob.gifcities.org/gifcities/3VOFVM3PZ2T7GHF52NCCCVJATK3C7ILZ.gif',
      page: 'https://web.archive.org/web/20091026213653/http://www.geocities.com/mazuki2873/computer/index.htm',
      width: 280, height: 100, title: 'mazuki2873 images m azuki new animation',
    });
  });
  it('garbage never throws and yields nothing', () => {
    for (const bad of [null, 1, 'x', {}, [null, 3, 'a', { checksum: 'nope' }]]) expect(parseResults(bad)).toEqual([]);
  });
  it('rejects odd checksums, untrusted pages, dedupes and sanitizes text', () => {
    const ok = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const out = parseResults([
      { checksum: ok, page: 'javascript:alert(1)', url_text: '<img src=x onerror=alert(1)>', width: -5, height: 'x' },
      { checksum: ok },
      { checksum: '../../etc/passwd' },
      { checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].page).toBeNull();
    expect(out[0].width).toBe(0);
    // Title is kept as plain text: the UI puts it in textContent, never innerHTML.
    expect(out[0].title).toBe('<img src=x onerror=alert(1)>');
  });
  it('file names from the title words', () => {
    expect(resultFileName(r[0])).toBe('mazuki2873-images-m-azuki-new-animation.gif');
    expect(resultFileName({ ...r[0], title: '' })).toBe('3vofvm3pz2t7.gif');
  });
});

describe('domain validation', () => {
  it('https and exact host only', () => {
    expect(isHost('https://blob.gifcities.org/x', 'blob.gifcities.org')).toBe(true);
    expect(isHost('http://blob.gifcities.org/x', 'blob.gifcities.org')).toBe(false);
    expect(isHost('https://blob.gifcities.org.evil.com/x', 'blob.gifcities.org')).toBe(false);
    expect(isHost('https://user@blob.gifcities.org/x', 'blob.gifcities.org')).toBe(false);
    expect(isHost('https://blob.gifcities.org:8443/x', 'blob.gifcities.org')).toBe(false);
    expect(isHost('not a url', 'blob.gifcities.org')).toBe(false);
  });
  it('GIF URLs: blob store path with a base32 checksum', () => {
    expect(isAllowedGifUrl(gifUrl('3VOFVM3PZ2T7GHF52NCCCVJATK3C7ILZ')!)).toBe(true);
    expect(isAllowedGifUrl('https://blob.gifcities.org/gifcities/../secret.gif')).toBe(false);
    expect(isAllowedGifUrl('https://blob.gifcities.org/other/3VOFVM3PZ2T7GHF52NCCCVJATK3C7ILZ.gif')).toBe(false);
    expect(isAllowedGifUrl('https://example.com/a.gif')).toBe(false);
    expect(gifUrl('-')).toBeNull();
  });
  it('page links: Wayback Machine only', () => {
    expect(safePageUrl('https://web.archive.org/web/1/http://geocities.com/')).not.toBeNull();
    expect(safePageUrl('https://web.archive.org/save/x')).toBeNull();
    expect(safePageUrl('http://web.archive.org/web/1/x')).toBeNull();
    expect(safePageUrl('https://evil.com/web/1')).toBeNull();
  });
});

describe('search() with a mocked network', () => {
  it('parses a good response and sends no credentials nor referrer', async () => {
    const { f, calls } = fakeFetch(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
    const r = await search('computer', 300, undefined, f);
    expect(r.length).toBe(10);
    expect(calls[0].init?.credentials).toBe('omit');
    expect(calls[0].init?.referrerPolicy).toBe('no-referrer');
  });
  it('maps failures to clear error kinds', async () => {
    await expect(search('x', 10, undefined, fakeFetch('oops', { status: 503 }).f)).rejects.toMatchObject({ kind: 'http' });
    await expect(search('x', 10, undefined, fakeFetch('<html>', { status: 200 }).f)).rejects.toMatchObject({ kind: 'format' });
    await expect(search('x', 10, undefined, fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))).f)).rejects.toMatchObject({ kind: 'network' });
  });
  it('empty query: no request at all', async () => {
    const { f, calls } = fakeFetch('[]');
    expect(await search('   ', 10, undefined, f)).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe('GIF limits', () => {
  it('checkGif: signature, size, frames', () => {
    expect(checkGif(makeGif(3))).toBeNull();
    expect(checkGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('no es un GIF');
    expect(checkGif(makeGif(5), 4)).toContain('demasiados fotogramas');
    expect(checkGif(makeGif(1, 300, 10), 600, 256)).toContain('demasiado grande');
  });
  const url = gifUrl('3VOFVM3PZ2T7GHF52NCCCVJATK3C7ILZ')!;
  it('downloadGif: returns validated bytes and reports progress', async () => {
    const gif = makeGif(2);
    const seen: number[] = [];
    const { f } = fakeFetch(gif as BodyInit, { status: 200, headers: { 'content-type': 'image/gif' } });
    const b = await downloadGif(url, undefined, (g) => seen.push(g), f);
    expect([...b]).toEqual([...gif]);
    expect(seen.at(-1)).toBe(gif.length);
  });
  it('downloadGif: refuses foreign URLs, wrong types, declared and actual oversize', async () => {
    await expect(downloadGif('https://example.com/a.gif')).rejects.toBeInstanceOf(SearchError);
    await expect(downloadGif(url, undefined, undefined, fakeFetch('x', { headers: { 'content-type': 'text/html' } }).f)).rejects.toMatchObject({ kind: 'format' });
    await expect(downloadGif(url, undefined, undefined, fakeFetch('x', { headers: { 'content-type': 'image/gif', 'content-length': String(MAX_GIF_BYTES + 1) } }).f)).rejects.toMatchObject({ kind: 'limit' });
    // No content-length: the stream is cut as soon as it passes the cap.
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    await expect(downloadGif(url, undefined, undefined, fakeFetch(big, { headers: { 'content-type': 'image/gif' } }).f)).rejects.toMatchObject({ kind: 'limit' });
  });
  it('downloadGif: caller abort propagates (cancel button)', async () => {
    const ac = new AbortController();
    const slow = (async (_u: string, i?: RequestInit) => new Promise((_, rej) => i?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const p = downloadGif(url, ac.signal, undefined, slow);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
