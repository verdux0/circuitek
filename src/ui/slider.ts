/**
 * Slider row: «label · slider · number» (Photopea reference, section 7: the blending options
 * column of «Estilo de capa»). Replaces the rotary knobs with the same API and callbacks, so
 * every control keeps doing exactly what its knob did:
 *  - onInput while the value moves (slider drag, label scrub, arrows), onChange when it settles;
 *  - double click on the slider or Supr / Retroceso on it go back to the default value;
 *  - dragging the label sideways also changes the value (Shift = fine), as in Photoshop.
 * Values with names (e.g. a channel) show the name instead of the number field.
 */
export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  def: number;
  step?: number;
  /** Kept for compatibility with the knob options; sliders have one size. */
  size?: 'lg' | 'md' | 'sm';
  info?: string;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onChange: (v: number) => void;
}

let seq = 0;

/** "EFFECT" → "Effect", "RUIDO" → "Ruido" (labels were written for the knobs, in capitals). */
const sentence = (s: string): string => (s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s);

export class SliderRow {
  readonly el: HTMLElement;
  private range: HTMLInputElement;
  private num: HTMLInputElement;
  private out: HTMLElement;
  private unit: HTMLElement;
  private value: number;
  private step: number;

  constructor(private o: SliderOptions) {
    this.step = o.step ?? 1;
    this.value = this.clamp(o.value);
    const id = `sl-${++seq}`;
    const el = document.createElement('div');
    el.className = 'slider-row';
    el.innerHTML = `
      <label class="sl-label" for="${id}">${sentence(o.label)}</label>
      <input class="sl-range" id="${id}" type="range" min="${o.min}" max="${o.max}" step="${this.step}">
      <input class="sl-num" type="number" min="${o.min}" max="${o.max}" step="${this.step}" inputmode="decimal" aria-label="${sentence(o.label)} (valor)">
      <output class="sl-out" aria-hidden="true"></output>
      <span class="sl-unit" aria-hidden="true"></span>`;
    this.el = el;
    this.range = el.querySelector('.sl-range')!;
    this.num = el.querySelector('.sl-num')!;
    this.out = el.querySelector('.sl-out')!;
    this.unit = el.querySelector('.sl-unit')!;
    if (o.info) el.title = `${o.info}\n(doble clic = valor por defecto · arrastra el nombre para ajustar)`;
    this.bind();
    this.paint();
  }

  get(): number {
    return this.value;
  }

  /** Update without firing callbacks. */
  set(v: number): void {
    this.value = this.clamp(v);
    this.paint();
  }

  private clamp(v: number): number {
    const s = this.step;
    const q = Math.round((v - this.o.min) / s) * s + this.o.min;
    return Math.min(this.o.max, Math.max(this.o.min, Number(q.toFixed(4))));
  }

  private paint(): void {
    const v = this.value;
    const txt = this.o.format ? this.o.format(v) : String(v);
    if (this.range.value !== String(v)) this.range.value = String(v);
    this.range.setAttribute('aria-valuetext', txt);
    // "50%", "8 bit" → number + unit; a name ("RGB") → the name, no number field.
    const named = !txt.startsWith(String(v));
    this.el.classList.toggle('named', named);
    if (named) this.out.textContent = txt;
    else {
      if (document.activeElement !== this.num) this.num.value = String(v);
      this.unit.textContent = txt.slice(String(v).length).trim();
    }
  }

  private apply(v: number, commit: boolean): void {
    const n = this.clamp(v);
    const changed = n !== this.value;
    this.value = n;
    this.paint();
    if (changed) this.o.onInput(n);
    if (commit) this.o.onChange(n);
  }

  private bind(): void {
    const r = this.range;
    r.addEventListener('pointerdown', () => this.el.classList.add('active'));
    const up = () => this.el.classList.remove('active');
    r.addEventListener('pointerup', up);
    r.addEventListener('pointercancel', up);
    r.addEventListener('input', () => this.apply(Number(r.value), false));
    r.addEventListener('change', () => {
      up();
      this.o.onChange(this.value);
    });
    r.addEventListener('dblclick', () => this.apply(this.o.def, true));
    r.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      e.preventDefault();
      e.stopPropagation();
      this.apply(this.o.def, true);
    });
    this.num.addEventListener('change', () => {
      const v = Number(this.num.value);
      if (this.num.value === '' || !Number.isFinite(v)) return this.paint();
      this.apply(v, true);
    });
    this.num.addEventListener('keydown', (e) => e.stopPropagation());

    // Label scrub: drag sideways to change the value.
    const label = this.el.querySelector<HTMLElement>('.sl-label')!;
    let startX = 0;
    let startV = 0;
    let scrubbing = false;
    label.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      startX = e.clientX;
      startV = this.value;
      scrubbing = false;
      label.setPointerCapture(e.pointerId);
    });
    label.addEventListener('pointermove', (e) => {
      if (!label.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      if (!scrubbing && Math.abs(dx) < 3) return;
      if (!scrubbing) {
        scrubbing = true;
        this.el.classList.add('active');
      }
      const px = e.shiftKey ? 900 : 180; // pixels for the whole range
      this.apply(startV + (dx / px) * (this.o.max - this.o.min), false);
    });
    const end = (e: PointerEvent) => {
      if (!label.hasPointerCapture(e.pointerId)) return;
      label.releasePointerCapture(e.pointerId);
      if (!scrubbing) return;
      scrubbing = false;
      this.el.classList.remove('active');
      this.o.onChange(this.value);
    };
    label.addEventListener('pointerup', end);
    label.addEventListener('pointercancel', end);
    // A click on the label (no drag) focuses the slider, as a normal <label for>.
    label.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - startX) >= 3) e.preventDefault();
    });
  }
}
