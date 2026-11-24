/**
 * Icons. Lucide (ISC, https://lucide.dev) for almost everything — imported one by one so
 * only the used icons are bundled — plus three drawn here in the same style (24×24 grid,
 * 2px round stroke) that Lucide does not have: mirror horizontally / vertically and bold.
 *
 * "Add" actions put a small plus on the LEFT of the object icon (+🖼 add image, +T add text).
 */
import type { IconNode } from 'lucide';
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Grid3x3,
  Sparkles,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Cpu,
  Crop,
  Crosshair,
  Dices,
  Ellipsis,
  Paintbrush,
  Download,
  Eraser,
  Expand,
  Eye,
  EyeOff,
  FilePlus,
  FileDown,
  FileUp,
  FolderOpen,
  Frame,
  GripVertical,
  Image,
  Italic,
  Layers,
  LayoutGrid,
  Lock,
  LockOpen,
  Maximize2,
  Monitor,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  Repeat,
  RefreshCcw,
  RefreshCw,
  RotateCcw,
  RotateCcwSquare,
  RotateCw,
  Save,
  Scan,
  Scissors,
  Search,
  Shrink,
  Square,
  SquareSplitHorizontal,
  StepBack,
  StepForward,
  Sun,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Trash,
  Type,
  Undo2,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide';

const CUSTOM: Record<string, IconNode> = {
  // Two mirrored triangles about a dashed axis.
  'flip-h': [
    ['path', { d: 'M12 3v2M12 9v2M12 15v2M12 21v-2' }],
    ['path', { d: 'M8 7 3 17h5z' }],
    ['path', { d: 'M16 7l5 10h-5z' }],
  ],
  'flip-v': [
    ['path', { d: 'M3 12h2M9 12h2M15 12h2M21 12h-2' }],
    ['path', { d: 'M7 8 17 3v5z' }],
    ['path', { d: 'M7 16l10 5v-5z' }],
  ],
  bold: [['path', { d: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z' }]],
  // "1:1" — actual size.
  'one-to-one': [
    ['path', { d: 'M5 8l2-2v12' }],
    ['path', { d: 'M17 8l2-2v12' }],
    ['circle', { cx: '12', cy: '10', r: '0.6' }],
    ['circle', { cx: '12', cy: '15', r: '0.6' }],
  ],
};

const LUCIDE: Record<string, IconNode> = {
  image: Image,
  type: Type,
  plus: Plus,
  undo: Undo2,
  redo: Redo2,
  new: FilePlus,
  sun: Sun,
  moon: Moon,
  dices: Dices,
  variants: LayoutGrid,
  compare: SquareSplitHorizontal,
  download: Download,
  save: Save,
  open: FolderOpen,
  camera: Camera,
  chip: Cpu,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  fit: Scan,
  eye: Eye,
  'eye-off': EyeOff,
  lock: Lock,
  unlock: LockOpen,
  grip: GripVertical,
  'rot-l': RotateCcw,
  'rot-r': RotateCw,
  'rot-0': RotateCcwSquare,
  contain: Shrink,
  cover: Expand,
  center: Crosshair,
  reset: RefreshCcw,
  more: RefreshCw,
  up: ArrowUp,
  down: ArrowDown,
  duplicate: CopyPlus,
  trash: Trash,
  pencil: Pencil,
  fx: WandSparkles,
  eraser: Eraser,
  italic: Italic,
  'align-left': TextAlignStart,
  'align-center': TextAlignCenter,
  'align-right': TextAlignEnd,
  'font-local': Monitor,
  'font-file': FileUp,
  crop: Crop,
  frame: Frame,
  close: X,
  layers: Layers,
  maximize: Maximize2,
  stop: Square,
  search: Search,
  play: Play,
  pause: Pause,
  'step-back': StepBack,
  'step-forward': StepForward,
  repeat: Repeat,
  volume: Volume2,
  'volume-x': VolumeX,
  chevron: ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  check: Check,
  thirds: Grid3x3,
  style: Sparkles,
  copy: Copy,
  paste: ClipboardPaste,
  cut: Scissors,
  'file-down': FileDown,
  'file-up': FileUp,
  menu: Ellipsis,
  brush: Paintbrush,
};

function render(node: IconNode): string {
  return node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs as Record<string, string | number>).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('');
}

const cache = new Map<string, string>();

/** SVG markup of an icon (inherits the text color). */
export function ico(name: string, cls = ''): string {
  const key = `${name}|${cls}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const node = LUCIDE[name] ?? CUSTOM[name];
  if (!node) throw new Error(`Icono desconocido: ${name}`);
  const svg = `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${render(node)}</svg>`;
  cache.set(key, svg);
  return svg;
}

/** "Add X": a small plus on the left of the object icon. */
export function addIco(name: string): string {
  return `<span class="ico-add">${ico('plus', 'ico-plus')}${ico(name)}</span>`;
}

/** Replaces every `<i data-ico="name">` (or data-ico-add) placeholder inside root. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('i[data-ico], i[data-ico-add]').forEach((el) => {
    const add = el.dataset.icoAdd;
    el.outerHTML = add ? addIco(add) : ico(el.dataset.ico!);
  });
}
