/**
 * Text layers: layout + drawing with Canvas2D (vector, so it stays sharp at any export size)
 * and font management. Fonts are local: bundled with Fontsource (no network), the fonts
 * installed on the computer (Local Font Access API, Chromium) or a font file chosen by the user.
 */

export type Align = 'left' | 'center' | 'right';

export interface TextProps {
  content: string;
  /** CSS family name (what Canvas draws with). */
  font: string;
  /**
   * Stable identity of the font: a library id (public/fonts catalog) or "system:" / "local:" /
   * "user:" + family. Kept even when the font is missing so the choice is not lost.
   */
  fontId?: string;
  /** Exact weight (100..900) chosen in the variant selector; when absent, `bold` gives 700 / 400. */
  weight?: number;
  /** Font size in document pixels (before the layer scale). */
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: Align;
  lineHeight: number;
}

export const DEFAULT_TEXT: TextProps = {
  content: 'TEXTO',
  font: 'Anton',
  size: 160,
  color: '#ffffff',
  bold: false,
  italic: false,
  align: 'center',
  lineHeight: 1.15,
};

/** Bundled with the app (see fonts.ts). */
export const BUNDLED_FONTS = ['Anton', 'Bebas Neue', 'VT323', 'Press Start 2P', 'Space Mono', 'Permanent Marker', 'Playfair Display'];
/** Usually installed on Windows / macOS; the browser falls back if missing. */
export const SYSTEM_FONTS = ['Arial', 'Arial Black', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Consolas'];
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

/** Weight used to draw: the variant's exact weight, or 700 / 400 from the bold toggle. */
export function textWeight(t: Pick<TextProps, 'bold' | 'weight'>): number {
  return t.weight ?? (t.bold ? 700 : 400);
}

export function cssFont(t: Pick<TextProps, 'font' | 'size' | 'bold' | 'italic' | 'weight'>, size = t.size): string {
  const fam = GENERIC.has(t.font) ? t.font : `"${t.font.replace(/"/g, '')}"`;
  return `${t.italic ? 'italic ' : ''}${textWeight(t)} ${size}px ${fam}, sans-serif`;
}

export function textPadding(t: TextProps): number {
  return Math.ceil(t.size * 0.18);
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Box size of the text block (document px, before the layer scale). */
export function measureText(t: TextProps, ctx?: Ctx2D): { w: number; h: number } {
  const g = ctx ?? (measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')!);
  g.font = cssFont(t);
  const lines = t.content.split('\n');
  const pad = textPadding(t);
  const w = Math.max(...lines.map((l) => g.measureText(l).width));
  return { w: Math.max(1, Math.ceil(w + pad * 2)), h: Math.max(1, Math.ceil(lines.length * t.size * t.lineHeight + pad * 2)) };
}

/** Draws the text block in local coordinates (0..w, 0..h). */
export function drawText(ctx: Ctx2D, t: TextProps, w: number): void {
  const pad = textPadding(t);
  const lh = t.size * t.lineHeight;
  ctx.font = cssFont(t);
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align;
  const x = t.align === 'left' ? pad : t.align === 'right' ? w - pad : w / 2;
  t.content.split('\n').forEach((line, i) => ctx.fillText(line, x, pad + lh * (i + 0.5)));
}

/** Small raster of the text for the viewport ghost and the layer thumbnail. */
export function rasterText(t: TextProps, w: number, h: number, max = 1024): OffscreenCanvas {
  const k = Math.min(1, max / Math.max(w, h));
  const c = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  const g = c.getContext('2d')!;
  g.scale(c.width / w, c.height / h);
  drawText(g, t, w);
  return c;
}

/** Raster of the text at `k` pixels per document pixel (GPU texture of a text layer). */
export function rasterTextAt(t: TextProps, w: number, h: number, k: number): OffscreenCanvas {
  const c = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  const g = c.getContext('2d')!;
  g.scale(c.width / w, c.height / h);
  drawText(g, t, w);
  return c;
}

/** Waits until the font face used by `t` is ready (bundled fonts are lazy-loaded by the browser). */
export async function ensureFont(t: Pick<TextProps, 'font' | 'bold' | 'italic' | 'weight'>, sample = 'AaÑñ'): Promise<void> {
  try {
    await document.fonts.load(cssFont({ ...t, size: 32 }), sample);
  } catch {
    /* unknown font: canvas falls back to sans-serif */
  }
}

/** Families installed on this computer (Chromium only; asks for permission). */
export async function queryLocalFamilies(): Promise<string[] | null> {
  const w = window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> };
  if (!w.queryLocalFonts) return null;
  const fonts = await w.queryLocalFonts();
  return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
}

/** Largest user font file accepted (bytes). */
export const MAX_USER_FONT = 15 * 1024 * 1024;

/**
 * Registers a .ttf / .otf / .woff / .woff2 file as a new family (the browser sanitizes it
 * through FontFace). Returns its name.
 */
export async function loadFontFile(file: File): Promise<string> {
  if (file.size > MAX_USER_FONT) throw new Error(`el archivo pesa más de ${MAX_USER_FONT / 1048576} MB`);
  const family = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, ' ').trim() || 'Fuente';
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  return family;
}
