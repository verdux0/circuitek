/** Encoder stage (shared by the worker and the main-thread fallback). */
import { STRIPS, corruptJpegBytes, corruptionCount, pixelSort } from './bytes';
import { mulberry32 } from '../prng';
import type { EncParams } from '../model';

/**
 * Real JPEG databending. The image is cut into horizontal strips (like the restart
 * intervals of a camera encoder) and each strip is encoded, corrupted and decoded on its
 * own, so one bad byte smears a band instead of flooding the whole frame. Strips and
 * corruption counts are relative to the image, so preview, thumbnails and export match.
 */
export async function jpegGlitch(img: ImageData, p: EncParams, seed: number): Promise<ImageData> {
  const { width: w, height: h } = img;
  const rng = mulberry32(seed);
  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext('2d')!;
  g.putImageData(img, 0, 0);
  const strips = STRIPS;
  const amt = p.jpg / 100;
  for (let gen = 0; gen < p.gens; gen++) {
    for (let i = 0; i < strips; i++) {
      const y0 = Math.floor((i * h) / strips);
      const sh = Math.floor(((i + 1) * h) / strips) - y0;
      const hit = rng() < 0.25 + amt * 0.85;
      const n = corruptionCount(p.jpg, rng);
      if (!hit || sh < 2) continue;
      const strip = new OffscreenCanvas(w, sh);
      const sg = strip.getContext('2d')!;
      sg.drawImage(cv, 0, y0, w, sh, 0, 0, w, sh);
      const blob = await strip.convertToBlob({ type: 'image/jpeg', quality: p.quality / 100 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bmp: ImageBitmap | null = null;
      for (let attempt = 0; attempt < 3 && !bmp; attempt++) {
        try {
          bmp = await createImageBitmap(new Blob([corruptJpegBytes(bytes, attempt ? 1 : n, rng)], { type: 'image/jpeg' }));
        } catch {
          bmp = null;
        }
      }
      if (!bmp) bmp = await createImageBitmap(blob);
      g.drawImage(bmp, 0, y0, w, sh);
      bmp.close();
    }
  }
  return g.getImageData(0, 0, w, h);
}

export async function processEnc(img: ImageData, p: EncParams, seed: number): Promise<ImageData> {
  let out = img;
  if (p.jpg > 0) out = await jpegGlitch(out, p, seed);
  if (p.sort > 0) pixelSort(out.data, out.width, out.height, 1 - p.sort / 100, p.sortLen / 100, p.sortDir);
  return out;
}
