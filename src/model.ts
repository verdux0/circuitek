/**
 * Domain model: the simulated CCD chip, its pins, the 15 pin-pair modes,
 * the extra signal stages and the serializable editor state.
 */
import { mixSeed } from './prng';
import { cloneStyle, sanitizeStyle, type LayerStyle } from './layerstyle';

export const PINS = ['SUB', 'RG', 'OD', 'TG', 'AB', 'HCLK'] as const;
export type Pin = (typeof PINS)[number];

export const PIN_INFO: Record<Pin, { name: string; desc: string; side: 'L' | 'R' }> = {
  SUB: { name: 'Substrate bias', desc: 'Exposición y ganancia', side: 'L' },
  RG: { name: 'Reset gate', desc: 'Saturación y bandas de color', side: 'L' },
  OD: { name: 'Output drain', desc: 'Separación de canales R/G/B', side: 'L' },
  TG: { name: 'Transfer gate', desc: 'Desplaza tono y fase', side: 'R' },
  AB: { name: 'Anti-bloom drain', desc: 'Mata la señal de color', side: 'R' },
  HCLK: { name: 'Horizontal clock', desc: 'Rompe el timing de las líneas', side: 'R' },
};

export interface PairDef {
  a: Pin;
  b: Pin;
  mode: number;
  name: string;
  /** What the short circuit does, in "electrical" terms. */
  desc: string;
  /** What the Filter knob does in this mode. */
  filter: string;
}

/** The 15 pin pairs, in PINS order (i < j). `mode` is the shader mode index. */
export const PAIRS: PairDef[] = [
  { a: 'SUB', b: 'RG', mode: 0, name: 'Overflow de ganancia', desc: 'El bias del sustrato dispara la ganancia y el reset satura: las altas luces desbordan el ADC y vuelven a cero, el color se rompe en bandas.', filter: 'Nº de bandas de color' },
  { a: 'SUB', b: 'OD', mode: 1, name: 'Split por exposición', desc: 'La carga del sustrato se filtra al drenaje de salida: los canales R y B se separan más cuanto más brilla la zona.', filter: 'Dirección de la separación' },
  { a: 'SUB', b: 'TG', mode: 2, name: 'Fase solar', desc: 'La ganancia modula la puerta de transferencia: el tono pasa a depender del brillo y la imagen se solariza en arcoíris.', filter: 'Desfase de tono' },
  { a: 'SUB', b: 'AB', mode: 3, name: 'Quemado mono', desc: 'Sin anti-bloom y con el sustrato sobrecargado: el color muere, los blancos se pliegan en negativo y hay líneas invertidas.', filter: 'Punto de pliegue' },
  { a: 'SUB', b: 'HCLK', mode: 4, name: 'Arrastre de línea', desc: 'La ganancia entra en el reloj horizontal: los píxeles brillantes arrastran estelas hacia la derecha y cada línea parpadea.', filter: 'Longitud de la estela' },
  { a: 'RG', b: 'OD', mode: 5, name: 'Poster partido', desc: 'El reset vacía el drenaje antes de tiempo: cada canal se cuantiza a pocos niveles y se desplaza en vertical.', filter: 'Niveles por canal' },
  { a: 'RG', b: 'TG', mode: 6, name: 'Franjas de tono', desc: 'Reset y transferencia se pisan: bandas horizontales con el tono girado y saturado, alguna invertida.', filter: 'Nº de franjas' },
  { a: 'RG', b: 'AB', mode: 7, name: 'Duotono fantasma', desc: 'El reset descarga en el anti-bloom: la luminancia se cuantiza a 2-5 niveles, aparece un fantasma lateral y el color queda en dos tintas.', filter: 'Tinta del duotono' },
  { a: 'RG', b: 'HCLK', mode: 8, name: 'Desgarro de bloques', desc: 'Pulsos de reset fuera de reloj: bloques de líneas saltan de lado, se posterizan y cruzan canales.', filter: 'Altura de los bloques' },
  { a: 'OD', b: 'TG', mode: 9, name: 'Error de fase NTSC', desc: 'El drenaje inyecta ruido en la fase de transferencia: la crominancia gira en ondas y se adelanta a la luminancia.', filter: 'Frecuencia de la onda' },
  { a: 'OD', b: 'AB', mode: 10, name: 'Caída de canal', desc: 'Drenajes puenteados: por bandas se pierde un canal, se duplica otro o se rotan, y el color general se apaga.', filter: 'Altura de las bandas' },
  { a: 'OD', b: 'HCLK', mode: 11, name: 'Jitter RGB', desc: 'El reloj horizontal tiembla distinto para cada canal: R, G y B se desplazan por separado línea a línea.', filter: 'Densidad de líneas' },
  { a: 'TG', b: 'AB', mode: 12, name: 'Croma de bordes', desc: 'Sin color y con la fase suelta: solo los bordes conservan croma, coloreados según su orientación.', filter: 'Grosor de los bordes' },
  { a: 'TG', b: 'HCLK', mode: 13, name: 'Ondulación de sync', desc: 'La transferencia modula el reloj de línea: las líneas ondulan en horizontal y el tono sigue a la onda.', filter: 'Frecuencia de la onda' },
  { a: 'AB', b: 'HCLK', mode: 14, name: 'Sync perdido', desc: 'El monitor pierde el pulso horizontal: la imagen se inclina y se enrolla, mono, con la barra de sync visible.', filter: 'Deriva vertical' },
];

export function pinIndex(p: Pin): number {
  return PINS.indexOf(p);
}

export function findPair(a: Pin, b: Pin): PairDef | undefined {
  if (a === b) return undefined;
  const [x, y] = pinIndex(a) < pinIndex(b) ? [a, b] : [b, a];
  return PAIRS.find((p) => p.a === x && p.b === y);
}

export function pairLabel(a: Pin, b: Pin): string {
  const p = findPair(a, b);
  return p ? `${p.a}+${p.b}` : `${a}+${b}`;
}

export interface Cable {
  a: Pin;
  b: Pin;
  /** Wire "resistance": 0..100 intensity of this short circuit. */
  amount: number;
}

export const MAX_CABLES = 3;

export type StageId = 'bus' | 'buffer' | 'proc' | 'enc';
export const STAGE_IDS: StageId[] = ['bus', 'buffer', 'proc', 'enc'];

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  step: number;
  unit: string;
  info: string;
  /** Labels for discrete values (e.g. channel permutations). */
  names?: string[];
}

export interface StageDef {
  id: StageId;
  name: string;
  chip: string;
  info: string;
  params: ParamDef[];
}

const P = (id: string, label: string, min: number, max: number, def: number, unit: string, info: string, step = 1, names?: string[]): ParamDef => ({ id, label, min, max, def, step, unit, info, names });

export const STAGES: StageDef[] = [
  {
    id: 'bus', name: 'Bus de datos / ADC', chip: 'ADC-8',
    info: 'Las 8 líneas de datos entre el conversor y el procesador. Cortarlas, cruzarlas o acoplarles ruido cambia los bits de cada canal.',
    params: [
      P('bits', 'BITS', 1, 8, 8, 'bit', 'Líneas del bus desconectadas: menos bits efectivos por canal.'),
      P('xor', 'RUIDO', 0, 100, 0, '%', 'Ruido acoplado al bus: bandas de bytes con bits invertidos.'),
      P('rot', 'ROTAR', 0, 7, 0, 'bit', 'Bus soldado desplazado: rota los bits de cada byte.'),
      P('swap', 'CANAL', 0, 5, 0, '', 'Líneas de canal cruzadas: permuta R, G y B.', 1, ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR']),
    ],
  },
  {
    id: 'buffer', name: 'Buffer / memoria', chip: 'SDRAM',
    info: 'La memoria donde se ensambla el fotograma. Un stride mal configurado, líneas que no se refrescan o lecturas fantasma.',
    params: [
      P('stride', 'STRIDE', -40, 40, 0, 'px', 'Ancho de línea mal programado: la imagen se cizalla en diagonal.'),
      P('repeat', 'OVERFLOW', 0, 100, 0, '%', 'Overflow: bandas donde el buffer repite la misma línea.'),
      P('echo', 'ECO', 0, 100, 0, '%', 'Lecturas de una dirección vecina: eco desplazado de la imagen.'),
    ],
  },
  {
    id: 'proc', name: 'Procesador de imagen', chip: 'DSP',
    info: 'El DSP que demosaica, filtra y ajusta el color. Con los registros corruptos, cada paso deja su huella.',
    params: [
      P('bayer', 'BAYER', 0, 100, 0, '%', 'Matriz Bayer desalineada: el demosaico mezcla píxeles equivocados (laberinto de color).'),
      P('bleed', 'SANGRADO', 0, 100, 0, '%', 'Filtro de croma roto: el color se corre horizontalmente.'),
      P('poster', 'POSTER', 0, 100, 0, '%', 'Tabla de gamma truncada: menos niveles de color.'),
      P('sat', 'SATUR.', 0, 100, 0, '%', 'Registro de saturación desbordado.'),
    ],
  },
  {
    id: 'enc', name: 'Codificador JPEG', chip: 'JPEG',
    info: 'El codificador que escribe la foto en la tarjeta. Aquí se corrompen bytes reales del JPEG y el bus de escritura ordena píxeles.',
    params: [
      P('jpg', 'CORRUP.', 0, 100, 0, '%', 'Bytes corruptos en el flujo comprimido (databending real).'),
      P('quality', 'CALIDAD', 1, 100, 35, '%', 'Calidad de compresión antes de corromper: menos calidad, bloques más grandes.'),
      P('gens', 'GENER.', 1, 6, 1, '×', 'Generaciones: recomprimir y volver a corromper.'),
      P('sort', 'SORT', 0, 100, 0, '%', 'Pixel sort: el bus de escritura ordena los tramos brillantes.'),
      P('sortLen', 'TRAMO', 1, 100, 40, '%', 'Longitud máxima de los tramos ordenados.'),
      P('sortDir', 'DIREC.', 0, 3, 0, '', 'Dirección del orden.', 1, ['→', '←', '↓', '↑']),
    ],
  },
];

export function stageDef(id: StageId): StageDef {
  const s = STAGES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown stage ${id}`);
  return s;
}

export interface StageState {
  on: boolean;
  p: Record<string, number>;
}

/** "Movimiento": how an animated layer moves frame by frame (see src/motion.ts). */
export type MotionMode = 'flicker' | 'drift' | 'jumps';
export const MOTION_MODES: MotionMode[] = ['flicker', 'drift', 'jumps'];
/** GIF-exact rates (whole centiseconds per frame). */
export const MOTION_FPS = [10, 12.5, 20, 25] as const;
export const MOTION_SECONDS = [1, 2, 3, 4, 5, 6, 8, 10] as const;

export interface Motion {
  /** Parpadeo (noise per frame) · Deriva suave (sines) · Saltos (held jumps). */
  mode: MotionMode;
  /** 0..100: how far parameters move from their base value. */
  intensity: number;
  /** 0..100: cycles per loop (drift) / how often they jump (jumps). */
  speed: number;
  /** Which parameters move (drift / jumps). */
  targets: { effect: boolean; filter: boolean; cables: boolean; stages: boolean };
  /** Loop length and rate: the preview and the default GIF use them, so both match frame by frame. */
  seconds: number;
  fps: number;
}

export function defaultMotion(): Motion {
  return { mode: 'flicker', intensity: 50, speed: 50, targets: { effect: true, filter: true, cables: false, stages: false }, seconds: 3, fps: 20 };
}

export interface GlitchState {
  /** Schema version: 2 added `motion` (version 1 states load with the default motion). */
  v: 2;
  seed: number;
  /** Global intensity knob (0..100). */
  effect: number;
  /** Global character knob (0..100), meaning depends on each mode. */
  filter: number;
  cables: Cable[];
  stages: Record<StageId, StageState>;
  motion: Motion;
}

export function defaultStageState(id: StageId): StageState {
  const p: Record<string, number> = {};
  for (const d of stageDef(id).params) p[d.id] = d.def;
  // Off: at their defaults the knobs change nothing, so the stage must not look engaged.
  return { on: false, p };
}

export function defaultState(): GlitchState {
  return {
    v: 2,
    seed: 1337,
    effect: 50,
    filter: 50,
    cables: [{ a: 'RG', b: 'TG', amount: 100 }],
    stages: {
      bus: defaultStageState('bus'),
      buffer: defaultStageState('buffer'),
      proc: defaultStageState('proc'),
      enc: defaultStageState('enc'),
    },
    motion: defaultMotion(),
  };
}

/** Does this stage currently alter the image? (drives LEDs and skips no-op passes) */
export function stageActive(s: GlitchState, id: StageId): boolean {
  return s.stages[id].on && stageAlters(id, s.stages[id].p);
}

/** Would these knob values alter the image if the stage were on? */
export function stageAlters(id: StageId, p: Record<string, number>): boolean {
  switch (id) {
    case 'bus': return p.bits < 8 || p.xor > 0 || p.rot > 0 || p.swap > 0;
    case 'buffer': return p.stride !== 0 || p.repeat > 0 || p.echo > 0;
    case 'proc': return p.bayer > 0 || p.bleed > 0 || p.poster > 0 || p.sat > 0;
    case 'enc': return p.jpg > 0 || p.sort > 0;
  }
}

/** Turns on every stage whose knobs alter the image (presets / random set knobs only). */
export function engageStages(s: GlitchState): GlitchState {
  for (const id of STAGE_IDS) s.stages[id].on = stageAlters(id, s.stages[id].p);
  return s;
}

export function cloneState(s: GlitchState): GlitchState {
  return JSON.parse(JSON.stringify(s)) as GlitchState;
}

function num(v: unknown, d: ParamDef | { min: number; max: number; def: number; step?: number }): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d.def;
  const c = Math.min(d.max, Math.max(d.min, n));
  const step = d.step ?? 0;
  return step >= 1 ? Math.round(c) : c;
}

/** Validates any parsed JSON into a well-formed state (unknown keys dropped, ranges clamped). */
export function sanitizeState(input: unknown): GlitchState {
  const base = defaultState();
  if (!input || typeof input !== 'object') return base;
  const o = input as Record<string, unknown>;
  const out: GlitchState = {
    v: 2,
    seed: num(o.seed, { min: 0, max: 4294967295, def: base.seed, step: 1 }),
    effect: num(o.effect, { min: 0, max: 100, def: 50, step: 1 }),
    filter: num(o.filter, { min: 0, max: 100, def: 50, step: 1 }),
    cables: [],
    stages: base.stages,
    // v1 states (no `motion`) get the default motion.
    motion: sanitizeMotion(o.motion),
  };
  if (Array.isArray(o.cables)) {
    for (const c of o.cables) {
      if (out.cables.length >= MAX_CABLES) break;
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const a = cc.a as Pin;
      const b = cc.b as Pin;
      if (!PINS.includes(a) || !PINS.includes(b) || !findPair(a, b)) continue;
      if (out.cables.some((x) => findPair(x.a, x.b) === findPair(a, b))) continue;
      out.cables.push({ a, b, amount: num(cc.amount, { min: 0, max: 100, def: 100, step: 1 }) });
    }
  }
  const st = o.stages as Record<string, unknown> | undefined;
  if (st && typeof st === 'object') {
    for (const id of STAGE_IDS) {
      const raw = st[id] as Record<string, unknown> | undefined;
      if (!raw || typeof raw !== 'object') continue;
      const p = (raw.p ?? {}) as Record<string, unknown>;
      const ss = defaultStageState(id);
      for (const d of stageDef(id).params) ss.p[d.id] = num(p[d.id], d);
      // On only if it really does something (older states stored every stage on at defaults).
      ss.on = raw.on !== false && stageAlters(id, ss.p);
      out.stages[id] = ss;
    }
  }
  return out;
}

/** Validates motion settings (anything missing or out of range → default). */
export function sanitizeMotion(input: unknown): Motion {
  const d = defaultMotion();
  if (!input || typeof input !== 'object') return d;
  const m = input as Record<string, unknown>;
  const t = (m.targets && typeof m.targets === 'object' ? m.targets : {}) as Record<string, unknown>;
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    mode: MOTION_MODES.includes(m.mode as MotionMode) ? (m.mode as MotionMode) : d.mode,
    intensity: num(m.intensity, { min: 0, max: 100, def: d.intensity, step: 1 }),
    speed: num(m.speed, { min: 0, max: 100, def: d.speed, step: 1 }),
    targets: { effect: bool(t.effect, d.targets.effect), filter: bool(t.filter, d.targets.filter), cables: bool(t.cables, d.targets.cables), stages: bool(t.stages, d.targets.stages) },
    seconds: (MOTION_SECONDS as readonly number[]).includes(m.seconds as number) ? (m.seconds as number) : d.seconds,
    fps: (MOTION_FPS as readonly number[]).includes(m.fps as number) ? (m.fps as number) : d.fps,
  };
}

/** Frames in one motion loop. */
export const motionFrames = (m: Motion): number => Math.max(2, Math.round(m.seconds * m.fps));

export interface PresetFile {
  app: 'circuitek';
  /** 2: the state carries `motion`; 3: optional layer `style`. Versions 1 and 2 still load. */
  version: 3;
  name: string;
  state: GlitchState;
  /** Layer style (shadows, glows) saved with the preset (absent = the preset leaves the style alone). */
  style?: LayerStyle;
}

export function toPresetFile(name: string, s: GlitchState, style?: LayerStyle): PresetFile {
  const f: PresetFile = { app: 'circuitek', version: 3, name, state: cloneState(s) };
  if (style) f.style = cloneStyle(style);
  return f;
}

export function parsePresetFile(text: string): { name: string; state: GlitchState; style?: LayerStyle } {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const state = sanitizeState('state' in raw ? raw.state : raw);
  const name = typeof raw.name === 'string' ? raw.name : 'Preset';
  const style = sanitizeStyle(raw.style);
  return style ? { name, state, style } : { name, state };
}

/* ---------- Render plan (pure, shared by GPU renderer and tests) ---------- */

export interface GpuPass {
  /** 0 = CCD short, 1 = bus, 2 = buffer, 3 = processor */
  pass: 0 | 1 | 2 | 3;
  mode: number;
  amt: number;
  filter: number;
  p: [number, number, number, number];
  seed: number;
}

/** Intensity of a cable: global Effect × wire amount. 50/100 -> 0.75, max 1.5. */
export function cableAmount(s: GlitchState, c: Cable): number {
  return (s.effect / 100) * (c.amount / 100) * 1.5;
}

export function buildGpuPasses(s: GlitchState): GpuPass[] {
  const passes: GpuPass[] = [];
  s.cables.forEach((c, i) => {
    const pair = findPair(c.a, c.b);
    if (!pair) return;
    const amt = cableAmount(s, c);
    if (amt <= 0) return;
    passes.push({ pass: 0, mode: pair.mode, amt, filter: s.filter / 100, p: [0, 0, 0, 0], seed: mixSeed(s.seed, i + 1) });
  });
  if (stageActive(s, 'bus')) {
    const p = s.stages.bus.p;
    passes.push({ pass: 1, mode: 0, amt: 1, filter: 0, p: [p.bits, p.xor / 100, p.rot, p.swap], seed: mixSeed(s.seed, 101) });
  }
  if (stageActive(s, 'buffer')) {
    const p = s.stages.buffer.p;
    passes.push({ pass: 2, mode: 0, amt: 1, filter: 0, p: [p.stride, p.repeat / 100, p.echo / 100, 0], seed: mixSeed(s.seed, 102) });
  }
  if (stageActive(s, 'proc')) {
    const p = s.stages.proc.p;
    passes.push({ pass: 3, mode: 0, amt: 1, filter: 0, p: [p.bayer / 100, p.bleed / 100, p.poster / 100, p.sat / 100], seed: mixSeed(s.seed, 103) });
  }
  return passes;
}

export interface EncParams {
  jpg: number;
  quality: number;
  gens: number;
  sort: number;
  sortLen: number;
  sortDir: number;
}

export function encParams(s: GlitchState): EncParams | null {
  if (!stageActive(s, 'enc')) return null;
  const p = s.stages.enc.p;
  return { jpg: p.jpg, quality: p.quality, gens: p.gens, sort: p.sort, sortLen: p.sortLen, sortDir: p.sortDir };
}

export function encSeed(s: GlitchState): number {
  return mixSeed(s.seed, 104);
}
