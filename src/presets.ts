/** Factory presets, randomizer and variant generator (pure, deterministic given a seed). */
import { MAX_CABLES, PAIRS, PINS, STAGES, STAGE_IDS, defaultState, engageStages, findPair, sanitizeState, type Cable, type GlitchState, type Pin } from './model';
import { mulberry32, pick, randInt, type Rng } from './prng';

type Partial2 = {
  seed?: number;
  effect?: number;
  filter?: number;
  cables: Array<[Pin, Pin, number]>;
  stages?: Partial<Record<'bus' | 'buffer' | 'proc' | 'enc', Record<string, number>>>;
};

function make(p: Partial2): GlitchState {
  const s = defaultState();
  s.seed = p.seed ?? s.seed;
  s.effect = p.effect ?? s.effect;
  s.filter = p.filter ?? s.filter;
  s.cables = p.cables.map(([a, b, amount]) => ({ a, b, amount }));
  for (const [id, params] of Object.entries(p.stages ?? {})) {
    Object.assign(s.stages[id as keyof typeof s.stages].p, params);
  }
  return sanitizeState(engageStages(s));
}

export const FACTORY_PRESETS: Array<{ name: string; state: GlitchState }> = [
  { name: 'Puente RG+TG', state: make({ cables: [['RG', 'TG', 100]] }) },
  { name: 'VHS quemado', state: make({ seed: 77, effect: 55, filter: 30, cables: [['OD', 'TG', 85], ['SUB', 'HCLK', 55]], stages: { proc: { bleed: 60 }, buffer: { echo: 30 } } }) },
  { name: 'Overflow de memoria', state: make({ seed: 4242, effect: 60, filter: 40, cables: [['AB', 'HCLK', 65]], stages: { buffer: { repeat: 45 }, bus: { bits: 4 } } }) },
  { name: 'JPEG fundido', state: make({ seed: 9001, effect: 50, filter: 35, cables: [['RG', 'HCLK', 70]], stages: { enc: { jpg: 35, quality: 30, gens: 1 } } }) },
  { name: 'Ácido', state: make({ seed: 303, effect: 65, filter: 15, cables: [['SUB', 'TG', 90], ['OD', 'HCLK', 60]], stages: { proc: { sat: 45 } } }) },
  { name: 'Sort de memoria', state: make({ seed: 512, effect: 55, filter: 60, cables: [['OD', 'AB', 70]], stages: { enc: { sort: 55, sortLen: 50 }, buffer: { stride: 7 } } }) },
  { name: 'Cinta rebobinada', state: make({ seed: 1984, effect: 60, filter: 45, cables: [['TG', 'HCLK', 75], ['OD', 'HCLK', 40]], stages: { proc: { bleed: 70 }, buffer: { echo: 25 } } }) },
  { name: 'Señal perdida', state: make({ seed: 404, effect: 70, filter: 55, cables: [['AB', 'HCLK', 90]], stages: { bus: { xor: 25 } } }) },
  { name: 'Arcoíris solar', state: make({ seed: 777, effect: 65, filter: 70, cables: [['SUB', 'TG', 100]], stages: { proc: { sat: 55 } } }) },
  { name: 'Negativo quemado', state: make({ seed: 666, effect: 75, filter: 40, cables: [['SUB', 'AB', 95]], stages: { proc: { poster: 35 } } }) },
  { name: 'Estelas de neón', state: make({ seed: 2077, effect: 60, filter: 80, cables: [['SUB', 'HCLK', 85], ['RG', 'TG', 45]], stages: { proc: { sat: 40 } } }) },
  { name: 'Póster pop', state: make({ seed: 1966, effect: 55, filter: 30, cables: [['RG', 'OD', 80]], stages: { proc: { poster: 60, sat: 35 }, bus: { swap: 2 } } }) },
  { name: 'Duotono espectral', state: make({ seed: 1313, effect: 60, filter: 65, cables: [['RG', 'AB', 85]], stages: { buffer: { echo: 40 } } }) },
  { name: 'Bloques rotos', state: make({ seed: 8086, effect: 70, filter: 50, cables: [['RG', 'HCLK', 90]], stages: { enc: { jpg: 25, quality: 20, gens: 2 } } }) },
  { name: 'Cable NTSC', state: make({ seed: 525, effect: 55, filter: 60, cables: [['OD', 'TG', 80]], stages: { proc: { bleed: 50 }, bus: { bits: 6 } } }) },
  { name: 'Canal caído', state: make({ seed: 303030, effect: 60, filter: 45, cables: [['OD', 'AB', 85]], stages: { bus: { swap: 4 } } }) },
  { name: 'Terremoto RGB', state: make({ seed: 9999, effect: 75, filter: 70, cables: [['OD', 'HCLK', 95], ['SUB', 'OD', 50]] }) },
  { name: 'Contornos de color', state: make({ seed: 1212, effect: 60, filter: 35, cables: [['TG', 'AB', 90]], stages: { proc: { sat: 50 } } }) },
  { name: 'Ondas de sync', state: make({ seed: 6060, effect: 65, filter: 40, cables: [['TG', 'HCLK', 90]], stages: { buffer: { stride: -6 } } }) },
  { name: '8 bits', state: make({ seed: 8, effect: 45, filter: 30, cables: [['RG', 'OD', 50]], stages: { bus: { bits: 3 }, proc: { poster: 70, bayer: 20 } } }) },
  { name: 'Ruido de bus', state: make({ seed: 1010, effect: 50, filter: 50, cables: [['SUB', 'RG', 60]], stages: { bus: { xor: 60, rot: 3 } } }) },
  { name: 'Laberinto Bayer', state: make({ seed: 2468, effect: 50, filter: 55, cables: [['RG', 'TG', 60]], stages: { proc: { bayer: 75, sat: 30 } } }) },
  { name: 'Cizalla diagonal', state: make({ seed: 4040, effect: 55, filter: 50, cables: [['SUB', 'OD', 75]], stages: { buffer: { stride: 22, repeat: 20 } } }) },
  { name: 'Lluvia de píxeles', state: make({ seed: 3141, effect: 55, filter: 60, cables: [['SUB', 'HCLK', 65]], stages: { enc: { sort: 70, sortLen: 85, sortDir: 2 } } }) },
  { name: 'Fotocopia infinita', state: make({ seed: 5150, effect: 50, filter: 40, cables: [['RG', 'AB', 55]], stages: { enc: { jpg: 45, quality: 15, gens: 4 } } }) },
  { name: 'Caos total', state: make({ seed: 13, effect: 85, filter: 75, cables: [['SUB', 'TG', 80], ['OD', 'HCLK', 70], ['RG', 'AB', 60]], stages: { bus: { xor: 30 }, buffer: { repeat: 35 }, enc: { jpg: 20, sort: 40 } } }) },
];

function randomCables(rng: Rng, n: number): Cable[] {
  const pairs = [...PAIRS];
  const out: Cable[] = [];
  while (out.length < n && pairs.length) {
    const i = Math.floor(rng() * pairs.length);
    const p = pairs.splice(i, 1)[0];
    out.push({ a: p.a, b: p.b, amount: randInt(rng, 40, 100) });
  }
  return out;
}

/** Ranges that tend to look good when randomizing (subset of the full ranges). */
const RANDOM_RANGES: Record<string, [number, number]> = {
  'bus.bits': [2, 7], 'bus.xor': [10, 70], 'bus.rot': [1, 7], 'bus.swap': [1, 5],
  'buffer.stride': [-20, 20], 'buffer.repeat': [10, 60], 'buffer.echo': [15, 70],
  'proc.bayer': [10, 70], 'proc.bleed': [20, 90], 'proc.poster': [20, 80], 'proc.sat': [15, 60],
  'enc.jpg': [10, 60], 'enc.quality': [10, 60], 'enc.gens': [1, 3], 'enc.sort': [20, 70], 'enc.sortLen': [10, 80], 'enc.sortDir': [0, 3],
};

export function randomState(seed: number): GlitchState {
  const rng = mulberry32(seed);
  const s = defaultState();
  s.seed = seed;
  s.effect = randInt(rng, 35, 85);
  s.filter = randInt(rng, 0, 100);
  s.cables = randomCables(rng, randInt(rng, 1, MAX_CABLES));
  for (const id of STAGE_IDS) {
    if (rng() > 0.4) continue;
    const defs = STAGES.find((d) => d.id === id)!.params;
    const n = randInt(rng, 1, 2);
    for (let k = 0; k < n; k++) {
      const d = pick(rng, defs);
      const r = RANDOM_RANGES[`${id}.${d.id}`] ?? [d.min, d.max];
      s.stages[id].p[d.id] = randInt(rng, r[0], r[1]);
    }
  }
  return sanitizeState(engageStages(s));
}

/** A nearby mutation of `base`: same idea, different details. */
export function variantOf(base: GlitchState, seed: number): GlitchState {
  const rng = mulberry32(seed);
  const s: GlitchState = JSON.parse(JSON.stringify(base));
  s.seed = seed % 1_000_000;
  s.effect = clamp(s.effect + randInt(rng, -15, 15), 10, 100);
  s.filter = clamp(s.filter + randInt(rng, -35, 35), 0, 100);
  s.cables = s.cables.map((c) => ({ ...c, amount: clamp(c.amount + randInt(rng, -25, 25), 20, 100) }));
  if (s.cables.length && rng() < 0.4) {
    // move one end of one wire to another pin
    const i = Math.floor(rng() * s.cables.length);
    const c = s.cables[i];
    const np = pick(rng, PINS.filter((p) => p !== c.a && p !== c.b));
    const cand: Cable = rng() < 0.5 ? { ...c, a: np } : { ...c, b: np };
    const pair = findPair(cand.a, cand.b);
    if (pair && !s.cables.some((x, j) => j !== i && findPair(x.a, x.b) === pair)) s.cables[i] = cand;
  }
  if (s.cables.length < MAX_CABLES && rng() < 0.25) s.cables.push(...randomCables(rng, 1).filter((c) => !s.cables.some((x) => findPair(x.a, x.b) === findPair(c.a, c.b))));
  for (const id of STAGE_IDS) {
    for (const d of STAGES.find((x) => x.id === id)!.params) {
      const v = s.stages[id].p[d.id];
      if (v !== d.def && rng() < 0.7) s.stages[id].p[d.id] = clamp(Math.round(v + (rng() - 0.5) * (d.max - d.min) * 0.3), d.min, d.max);
    }
  }
  if (rng() < 0.3) {
    const id = pick(rng, STAGE_IDS);
    const d = pick(rng, STAGES.find((x) => x.id === id)!.params);
    const r = RANDOM_RANGES[`${id}.${d.id}`] ?? [d.min, d.max];
    s.stages[id].p[d.id] = randInt(rng, r[0], r[1]);
    s.stages[id].on = true;
  }
  return sanitizeState(s);
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}
