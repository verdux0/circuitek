/**
 * Our font categories (Spanish labels): Photopea's categories mapped onto ours, plus the
 * Fontsource category and name keywords for the glitch-friendly styles. A family can have several.
 * Shared by build-catalog.mjs and the tests.
 */
export const CATEGORY_LABELS = {
  display: 'Display',
  script: 'Script',
  manuscrita: 'Manuscrita',
  caligrafica: 'Caligráfica',
  gotica: 'Gótica',
  retro: 'Retro',
  stencil: 'Stencil',
  pixel: 'Pixel',
  graffiti: 'Graffiti',
  comic: 'Cómic',
  decorativa: 'Decorativa',
  experimental: 'Experimental',
  maquina: 'Máquina de escribir',
  simbolos: 'Símbolos',
  sans: 'Sans serif',
  serif: 'Serif',
  slab: 'Slab serif',
  mono: 'Monoespaciada',
};

/** Photopea category → ours. */
export const FROM_PHOTOPEA = {
  Blackletter: 'gotica', Calligraphic: 'caligrafica', Comic: 'comic', Dingbat: 'simbolos', Display: 'display', Grunge: 'experimental',
  Handdrawn: 'manuscrita', Monospaced: 'mono', Novelty: 'decorativa', Pixel: 'pixel', Programming: 'mono', Retro: 'retro',
  'Sans Serif': 'sans', Script: 'script', Serif: 'serif', 'Slab Serif': 'slab', Stencil: 'stencil', Typewriter: 'maquina',
};
/** Fontsource category → ours. */
export const FROM_FONTSOURCE = { 'sans-serif': 'sans', serif: 'serif', display: 'display', monospace: 'mono', handwriting: 'manuscrita', icons: 'simbolos' };

const KEYWORDS = [
  ['pixel', /pixel|silkscreen|press start|vt323|dotgothic|8 ?bit|jersey 10|micro 5|tiny ?5|sixtyfour|workbench|bytesized|jacquarda bastarda/],
  ['gotica', /fraktur|gotisch|pirata|new rocker|jacquard|texturina|metal mania|germania|grenze|blackletter|old london|manufacturing consent/],
  ['stencil', /stencil|black ops|emblema/],
  ['graffiti', /marker|graffiti|sedgwick|spray|rock salt|wet paint|finger paint/],
  ['experimental', /glitch|distressed|burned|puddles|microbe|maze|vinyl|doodle|\biso\b|moonrocks|beastly|80s fade|kablammo|honk|moirai|foldit|sixtyfour|workbench|bagel|danfo|tint|nabla|bungee spice|bungee shade|wavefont|linefont|rubik (?:glitch|burned)/],
  ['retro', /retro|monoton|bungee|righteous|faster one|audiowide|orbitron|major mono|\btilt\b|shrikhand|rampart|lobster|pacifico|yellowtail|neon|80s|vt323|press start|silkscreen/],
  ['maquina', /typewriter|special elite|courier prime|cutive/],
  ['comic', /comic|bangers|luckiest|chewy|boogaloo|bubblegum/],
  ['script', /script|calligraph/],
];

/** Categories of a Fontsource family `f` with Photopea categories `pp` (may be empty). */
export function categoriesFor(f, pp = []) {
  const set = new Set();
  for (const c of pp) if (FROM_PHOTOPEA[c]) set.add(FROM_PHOTOPEA[c]);
  if (FROM_FONTSOURCE[f.category]) set.add(FROM_FONTSOURCE[f.category]);
  const name = f.family.toLowerCase();
  for (const [cat, re] of KEYWORDS) if (re.test(name)) set.add(cat);
  // A display face that also matched a specific style does not need the generic tag first.
  const order = Object.keys(CATEGORY_LABELS);
  return [...set].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
