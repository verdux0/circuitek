/**
 * A draggable separator between two areas (a dock column and the canvas, two blocks of a column,
 * or the top edge of a bottom sheet). Pointer events with capture (mouse, pen and touch), arrows
 * on the keyboard (Shift = bigger steps), double click / Enter on Home to reset, and the ARIA of a
 * focusable separator (role, orientation, value now / min / max).
 *
 * The separator does not know what it resizes: it reports the pointer offset since the drag
 * started (`move`, at most once per animation frame) and `end` when the drag finishes, so the owner
 * can preview the size cheaply while dragging and commit the layout once.
 */

export interface SeparatorOptions {
  /** 'vertical' = a vertical bar that moves left / right (columns). */
  orientation: 'vertical' | 'horizontal';
  label: string;
  /** Current value and its range, for aria-valuenow / min / max (px). */
  value(): { now: number; min: number; max: number };
  /** Pointer offset (px) along the separator's axis since pointerdown. */
  move(delta: number): void;
  /** Drag finished (or a keyboard step: delta = the step). */
  end(delta: number): void;
  /** Double click or Home: back to the default size. */
  reset(): void;
  /** Extra class names. */
  className?: string;
}

const STEP = 10;
const BIG_STEP = 40;

export function makeSeparator(o: SeparatorOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = `dock-sep dock-sep-${o.orientation}${o.className ? ` ${o.className}` : ''}`;
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', o.orientation);
  el.setAttribute('aria-label', o.label);
  el.title = `${o.label} · arrastra, o flechas · doble clic = tamaño por defecto`;
  el.tabIndex = 0;
  const aria = () => {
    const v = o.value();
    el.setAttribute('aria-valuenow', String(Math.round(v.now)));
    el.setAttribute('aria-valuemin', String(Math.round(v.min)));
    el.setAttribute('aria-valuemax', String(Math.round(v.max)));
  };
  aria();
  const axis = (e: PointerEvent) => (o.orientation === 'vertical' ? e.clientX : e.clientY);
  let start = 0;
  let last = 0;
  let raf = 0;
  let id: number | null = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    id = e.pointerId;
    start = last = axis(e);
    el.classList.add('dragging');
    document.body.classList.add(o.orientation === 'vertical' ? 'resizing-x' : 'resizing-y');
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    last = axis(e);
    // One layout update per frame, however fast the pointer moves.
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      o.move(last - start);
    });
  });
  const finish = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    cancelAnimationFrame(raf);
    raf = 0;
    el.classList.remove('dragging');
    document.body.classList.remove('resizing-x', 'resizing-y');
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    o.end(e.type === 'pointercancel' ? 0 : last - start);
    aria();
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('dblclick', () => {
    o.reset();
    aria();
  });
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const keys: Record<string, number> = o.orientation === 'vertical' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
    if (e.key === 'Home') {
      e.preventDefault();
      o.reset();
      aria();
      return;
    }
    const d = keys[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    o.end(d);
    aria();
  });
  return el;
}
