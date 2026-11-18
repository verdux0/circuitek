/**
 * Rotary knob. Drag vertically (Shift = fine), mouse wheel, arrow keys / PageUp / Home / End,
 * double click resets to default. Exposed to assistive tech as role="slider".
 */
export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  def: number;
  step?: number;
  size?: 'lg' | 'md' | 'sm';
  info?: string;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onChange: (v: number) => void;
}

const SWEEP = 270;

export class Knob {
  readonly el: HTMLElement;
  private dial: HTMLElement;
  private ind: SVGGElement;
  private valueEl: HTMLElement;
  private value: number;
  private o: KnobOptions;
  private step: number;
  private wheelTimer = 0;

  constructor(o: KnobOptions) {
    this.o = o;
    this.step = o.step ?? 1;
    this.value = o.value;
    const el = document.createElement('div');
    el.className = `knob knob-${o.size ?? 'md'}`;
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const a = ((-SWEEP / 2 + (SWEEP * i) / 10) * Math.PI) / 180;
      const r1 = 47, r2 = i % 5 === 0 ? 41 : 43.5;
      return `<line x1="${50 + Math.sin(a) * r1}" y1="${50 - Math.cos(a) * r1}" x2="${50 + Math.sin(a) * r2}" y2="${50 - Math.cos(a) * r2}"/>`;
    }).join('');
    el.innerHTML = `
      <div class="knob-dial" role="slider" tabindex="0">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <g class="knob-ticks">${ticks}</g>
          <circle class="knob-shadow" cx="50" cy="53" r="35"/>
          <circle class="knob-body" cx="50" cy="50" r="35"/>
          <circle class="knob-cap" cx="50" cy="50" r="27"/>
          <g class="knob-ind"><circle class="knob-dot" cx="50" cy="26" r="4.2"/></g>
        </svg>
      </div>
      <div class="knob-label">${o.label}</div>
      <div class="knob-value"></div>`;
    this.el = el;
    this.dial = el.querySelector('.knob-dial')!;
    this.ind = el.querySelector('.knob-ind')!;
    this.valueEl = el.querySelector('.knob-value')!;
    this.dial.setAttribute('aria-label', o.label);
    this.dial.setAttribute('aria-valuemin', String(o.min));
    this.dial.setAttribute('aria-valuemax', String(o.max));
    if (o.info) {
      this.dial.title = `${o.info}\n(arrastra ↕ · Shift = fino · doble clic = reset)`;
    }
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
    const t = (this.value - this.o.min) / (this.o.max - this.o.min);
    this.ind.setAttribute('transform', `rotate(${-SWEEP / 2 + SWEEP * t} 50 50)`);
    const txt = this.o.format ? this.o.format(this.value) : String(this.value);
    this.valueEl.textContent = txt;
    this.dial.setAttribute('aria-valuenow', String(this.value));
    this.dial.setAttribute('aria-valuetext', txt);
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
    const range = this.o.max - this.o.min;
    let startY = 0;
    let startV = 0;
    let dragging = false;
    this.dial.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dial.focus();
      this.dial.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startV = this.value;
      dragging = true;
      this.el.classList.add('active');
    });
    this.dial.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const px = e.shiftKey ? 900 : 180; // pixels for full sweep
      const dy = startY - e.clientY;
      this.apply(startV + (dy / px) * range, false);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('active');
      this.o.onChange(this.value);
    };
    this.dial.addEventListener('pointerup', end);
    this.dial.addEventListener('pointercancel', end);
    this.dial.addEventListener('dblclick', () => this.apply(this.o.def, true));
    this.dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = Math.max(this.step, range / (e.shiftKey ? 400 : 50));
      this.apply(this.value + (e.deltaY < 0 ? unit : -unit), false);
      clearTimeout(this.wheelTimer);
      this.wheelTimer = window.setTimeout(() => this.o.onChange(this.value), 250);
    }, { passive: false });
    this.dial.addEventListener('keydown', (e) => {
      const big = Math.max(this.step, range / 10);
      const fine = e.shiftKey ? this.step : Math.max(this.step, range / 50);
      let v: number | null = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = this.value + fine;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = this.value - fine;
      else if (e.key === 'PageUp') v = this.value + big;
      else if (e.key === 'PageDown') v = this.value - big;
      else if (e.key === 'Home') v = this.o.min;
      else if (e.key === 'End') v = this.o.max;
      else if (e.key === 'Delete' || e.key === 'Backspace') v = this.o.def;
      if (v === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.apply(v, true);
    });
  }
}
