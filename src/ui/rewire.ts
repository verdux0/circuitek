/**
 * The rewire board: a CCD chip on a PCB. Drag (or tap-tap) between pins to bridge them.
 *
 * One component, two modes over the same state (`host.state()` / `host.edit()`):
 * - `full`: the detailed sheet (pop-up) with the big board, pair descriptions and resistance knobs.
 * - `compact`: an inline mini board for the controls bar, with one slider per cable and an
 *   "expand" button that opens the full sheet.
 */
import { MAX_CABLES, PINS, PIN_INFO, findPair, pairLabel, type GlitchState, type Pin } from '../model';
import { Knob } from './knob';
import { ico } from './icons';

export type RewireMode = 'full' | 'compact';

/** Radius (svg units) around a pin pad that counts as the pin. The mini board is drawn smaller, so its pins catch more. */
const PIN_HIT: Record<RewireMode, number> = { full: 24, compact: 32 };
/** The mini board crops the PCB around the chip and the cable loops. */
const VIEWBOX: Record<RewireMode, string> = { full: '0 0 640 300', compact: '104 26 432 248' };

export const CABLE_COLORS = ['#ff4a1c', '#ffb01f', '#ff2d78'];

const PIN_POS: Record<Pin, [number, number]> = {
  SUB: [196, 82], RG: [196, 150], OD: [196, 218],
  TG: [444, 82], AB: [444, 150], HCLK: [444, 218],
};

export function cablePath(a: Pin, b: Pin): string {
  const [x1, y1] = PIN_POS[a];
  const [x2, y2] = PIN_POS[b];
  const sa = PIN_INFO[a].side;
  const sb = PIN_INFO[b].side;
  if (sa === sb) {
    const out = sa === 'L' ? -1 : 1;
    const reach = 70 + Math.abs(y2 - y1) * 0.35;
    return `M${x1},${y1} C${x1 + out * reach},${y1 + 10} ${x2 + out * reach},${y2 + 10} ${x2},${y2}`;
  }
  const dx = x2 - x1;
  return `M${x1},${y1} C${x1 + dx * 0.55},${y1 + 70} ${x2 - dx * 0.55},${y2 - 70} ${x2},${y2}`;
}

export interface RewireHost {
  state: () => GlitchState;
  edit: (fn: (s: GlitchState) => void, phase: 'live' | 'end' | 'once') => void;
  toast: (msg: string) => void;
  /** compact mode: open the detailed view. */
  expand?: () => void;
}

function boardSvg(mode: RewireMode): string {
  const pins = PINS.map((p) => {
    const [x, y] = PIN_POS[p];
    const left = PIN_INFO[p].side === 'L';
    const leadX = left ? 250 : 390;
    return `
      <line class="lead" x1="${x}" y1="${y}" x2="${leadX}" y2="${y}"/>
      <g class="pin" data-pin="${p}" tabindex="0" role="button" aria-label="Pin ${p}: ${PIN_INFO[p].name}">
        <circle class="pin-hit" cx="${x}" cy="${y}" r="22"/>
        <circle class="pin-pad" cx="${x}" cy="${y}" r="8"/>
        <text class="pin-label" x="${left ? x - 20 : x + 20}" y="${y + 7}" text-anchor="${left ? 'end' : 'start'}">${p}</text>
      </g>`;
  }).join('');
  // Decoration only in the big board (and the pattern id must exist once in the page).
  const deco = mode === 'full'
    ? `<defs>
        <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="640" height="300" fill="url(#grid)"/>
      <g class="traces">
        <path d="M20 40H120V20M620 260H520V280M20 270H90L110 250M600 30H560L540 50" />
        <circle cx="120" cy="20" r="4"/><circle cx="520" cy="280" r="4"/><circle cx="110" cy="250" r="4"/><circle cx="540" cy="50" r="4"/>
      </g>
      <text class="silk" x="22" y="290">REV.B · BENT</text>
      <text class="silk" x="618" y="18" text-anchor="end">J1 CCD</text>`
    : '';
  return `
    <svg viewBox="${VIEWBOX[mode]}" class="pcb-svg" role="group" aria-label="Placa del CCD: arrastra de un pin a otro, o toca dos pines, para puentearlos">
      ${deco}
      <rect class="chip-shadow" x="254" y="38" width="136" height="232" rx="8"/>
      <rect class="chip" x="250" y="32" width="140" height="236" rx="8"/>
      <circle class="chip-notch" cx="270" cy="52" r="5"/>
      <text class="chip-label" x="320" y="150" transform="rotate(90 320 150)" text-anchor="middle">CCD-01</text>
      ${pins}
      <g class="cables"></g>
      <path class="cable-temp" d="" />
    </svg>`;
}

export class RewirePanel {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private cablesG: SVGGElement;
  private temp: SVGPathElement;
  private list: HTMLElement;
  private count: HTMLElement | null;
  private selected: Pin | null = null;
  private knobs: Knob[] = [];
  /** Cable pairs the list was last built for: same pairs = update values in place (keeps focus). */
  private built = '';

  constructor(private host: RewireHost, readonly mode: RewireMode = 'full') {
    const el = document.createElement(mode === 'full' ? 'div' : 'section');
    if (mode === 'full') {
      el.className = 'sheet-backdrop';
      el.hidden = true;
      el.innerHTML = `
        <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="rw-title">
          <header class="sheet-head">
            <h2 id="rw-title">Cortocircuita el CCD</h2>
            <button class="hw-btn icon sheet-close" data-act="close" aria-label="Cerrar" title="Listo (Esc)">${ico('close')}</button>
          </header>
          <p class="sheet-intro">El CCD convierte la luz en señal de vídeo línea a línea. Puentea dos de sus pines y las señales de funciones distintas se mezclan: la imagen se corrompe. Cada par falla a su manera. Hasta ${MAX_CABLES} cables a la vez.</p>
          <div class="pcb">${boardSvg('full')}</div>
          <div class="rw-list" aria-live="polite"></div>
          <dl class="pin-legend">
            ${PINS.map((p) => `<div><dt><b>${p}</b> ${PIN_INFO[p].name}</dt><dd>${PIN_INFO[p].desc}</dd></div>`).join('')}
          </dl>
        </section>`;
    } else {
      el.className = 'rw-mini';
      el.setAttribute('aria-label', 'Recableado del CCD');
      el.innerHTML = `
        <div class="pcb pcb-mini">${boardSvg('compact')}</div>
        <div class="rw-side">
          <div class="rw-side-head">
            <span class="rw-side-title">CABLES <span class="rw-count"></span></span>
            <button class="hw-btn icon-sm rw-expand" id="btn-rewire" data-act="expand" aria-label="Ampliar el recableado del CCD" title="Vista ampliada: descripciones y knobs (W)">${ico('maximize')}</button>
          </div>
          <div class="rw-list rw-list-mini" aria-live="polite"></div>
        </div>`;
    }
    this.el = el;
    // The PCB svg, NOT the first svg of the panel (buttons carry svg icons too).
    this.svg = el.querySelector<SVGSVGElement>('svg.pcb-svg')!;
    this.cablesG = el.querySelector('.cables')!;
    this.temp = el.querySelector('.cable-temp')!;
    this.list = el.querySelector('.rw-list')!;
    this.count = el.querySelector('.rw-count');
    this.bind();
    if (mode === 'compact') this.sync();
  }

  open(): void {
    if (this.mode !== 'full') return;
    this.el.hidden = false;
    this.sync();
    (this.el.querySelector('.sheet-close') as HTMLElement).focus();
  }

  close(): void {
    if (this.mode !== 'full') return;
    this.el.hidden = true;
    this.setSelected(null);
  }

  /** Full: the sheet is showing. Compact: always on screen. */
  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private toSvg(e: MouseEvent): [number, number] {
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const r = pt.matrixTransform(m.inverse());
    return [r.x, r.y];
  }

  /**
   * Pin under the pointer, by geometry (not by hit element): cables end on the pads and
   * their wide hit stroke covers them, so a wired pin must still start / end a new cable.
   */
  private pinAt(e: MouseEvent): Pin | null {
    const [x, y] = this.toSvg(e);
    let best: Pin | null = null;
    let bestD = PIN_HIT[this.mode];
    for (const p of PINS) {
      const [px, py] = PIN_POS[p];
      const d = Math.hypot(x - px, y - py);
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  private setSelected(p: Pin | null): void {
    this.selected = p;
    this.svg.querySelectorAll('.pin').forEach((g) => g.classList.toggle('selected', g.getAttribute('data-pin') === p));
  }

  private connect(a: Pin, b: Pin): void {
    const pair = findPair(a, b);
    if (!pair) return;
    const s = this.host.state();
    if (s.cables.some((c) => findPair(c.a, c.b) === pair)) {
      this.host.toast(`${pairLabel(a, b)} ya está puenteado`);
      return;
    }
    if (s.cables.length >= MAX_CABLES) {
      this.host.toast(`Máximo ${MAX_CABLES} cables: quita uno primero`);
      return;
    }
    this.host.edit((st) => st.cables.push({ a: pair.a, b: pair.b, amount: 100 }), 'once');
  }

  private remove(i: number): void {
    this.host.edit((s) => s.cables.splice(i, 1), 'once');
  }

  private bind(): void {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (this.mode === 'full' && (t === this.el || t.closest('[data-act="close"]'))) this.close();
      if (t.closest('[data-act="expand"]')) this.host.expand?.();
      const rm = t.closest('[data-remove]');
      if (rm) this.remove(Number(rm.getAttribute('data-remove')));
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.mode === 'full') this.close();
        else if (this.selected) {
          this.setSelected(null);
          e.stopPropagation();
        }
      }
      const g = (e.target as Element).closest?.('[data-pin]');
      if (g && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        // Space on a pin must not also reach the global shortcuts (Space = capture).
        e.stopPropagation();
        this.tapPin(g.getAttribute('data-pin') as Pin);
      }
    });
    // Sliders of the mini board: live while dragging, one undo step on release.
    this.el.addEventListener('input', (e) => {
      const r = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-amount]');
      if (!r) return;
      const i = Number(r.dataset.amount);
      const v = Number(r.value);
      this.host.edit((st) => { if (st.cables[i]) st.cables[i].amount = v; }, 'live');
      const out = r.parentElement?.querySelector('.rw-mval');
      if (out) out.textContent = String(v);
    });
    this.el.addEventListener('change', (e) => {
      if ((e.target as HTMLElement).closest('input[data-amount]')) this.host.edit(() => {}, 'end');
    });

    let from: Pin | null = null;
    let fromId = -1;
    const cancel = () => {
      from = null;
      fromId = -1;
      this.temp.setAttribute('d', '');
      this.svg.classList.remove('wiring');
    };
    this.svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = this.pinAt(e);
      if (!p) {
        // Clicks on a cable (away from the pins) remove it on click, below.
        if (!(e.target as Element).closest('[data-cable]')) this.setSelected(null);
        return;
      }
      e.preventDefault();
      from = p;
      fromId = e.pointerId;
      this.svg.setPointerCapture(e.pointerId);
      this.svg.classList.add('wiring');
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!from || e.pointerId !== fromId) return;
      const [x1, y1] = PIN_POS[from];
      const [x, y] = this.toSvg(e);
      if (Math.hypot(x - x1, y - y1) < 12) return this.temp.setAttribute('d', '');
      // Snap the loose end to a pin under the pointer.
      const to = this.pinAt(e);
      const [ex, ey] = to && to !== from ? PIN_POS[to] : [x, y];
      this.temp.setAttribute('d', to && to !== from ? cablePath(from, to) : `M${x1},${y1} Q${(x1 + ex) / 2},${Math.max(y1, ey) + 60} ${ex},${ey}`);
    });
    this.svg.addEventListener('pointerup', (e) => {
      if (!from || e.pointerId !== fromId) return;
      const start = from;
      cancel();
      const to = this.pinAt(e);
      if (to && to !== start) {
        this.setSelected(null);
        this.connect(start, to);
      } else if (to === start) {
        this.tapPin(start);
      }
    });
    this.svg.addEventListener('pointercancel', cancel);
    this.svg.addEventListener('lostpointercapture', () => from && cancel());
    this.svg.addEventListener('click', (e) => {
      if (this.pinAt(e)) return;
      const cable = (e.target as Element).closest('[data-cable]');
      if (!cable) return;
      this.remove(Number(cable.getAttribute('data-cable')));
    });
  }

  private tapPin(p: Pin): void {
    if (this.selected && this.selected !== p) {
      const a = this.selected;
      this.setSelected(null);
      this.connect(a, p);
    } else {
      this.setSelected(this.selected === p ? null : p);
    }
  }

  /**
   * Cheap update while a value is being dragged (here or in the other view): moves the knobs /
   * sliders to the state's amounts without rebuilding anything.
   */
  syncValues(): void {
    const s = this.host.state();
    if (s.cables.map((c) => c.a + c.b).join() !== this.built) return;
    s.cables.forEach((c, i) => {
      if (this.mode === 'full') {
        if (this.knobs[i] && this.knobs[i].get() !== c.amount) this.knobs[i].set(c.amount);
        return;
      }
      const r = this.list.querySelector<HTMLInputElement>(`input[data-amount="${i}"]`);
      if (r && Number(r.value) !== c.amount) r.value = String(c.amount);
      const out = r?.parentElement?.querySelector('.rw-mval');
      if (out) out.textContent = String(c.amount);
    });
  }

  /** Re-render cables and the cable list from state. */
  sync(): void {
    const s = this.host.state();
    this.cablesG.innerHTML = s.cables
      .map((c, i) => {
        const d = cablePath(c.a, c.b);
        const col = CABLE_COLORS[i % CABLE_COLORS.length];
        const [x1, y1] = PIN_POS[c.a];
        const [x2, y2] = PIN_POS[c.b];
        return `<g class="cable" data-cable="${i}" aria-label="Quitar cable ${pairLabel(c.a, c.b)}">
          <path class="cable-hit" d="${d}"/>
          <path class="cable-shade" d="${d}"/>
          <path class="cable-wire" d="${d}" style="stroke:${col}"/>
          <circle class="cable-end" cx="${x1}" cy="${y1}" r="7" style="fill:${col}"/>
          <circle class="cable-end" cx="${x2}" cy="${y2}" r="7" style="fill:${col}"/>
        </g>`;
      })
      .join('');
    this.svg.querySelectorAll('.pin').forEach((g) => {
      const p = g.getAttribute('data-pin') as Pin;
      g.classList.toggle('wired', s.cables.some((c) => c.a === p || c.b === p));
    });
    if (this.count) this.count.textContent = `${s.cables.length}/${MAX_CABLES}`;

    // Same cables as the list shows: only the values changed (keeps a focused slider / knob alive).
    const sig = s.cables.map((c) => c.a + c.b).join();
    if (sig === this.built && (s.cables.length || this.list.childElementCount)) return this.syncValues();
    this.built = sig;
    this.knobs = [];
    this.list.innerHTML = '';
    if (!s.cables.length) {
      this.list.innerHTML = this.mode === 'full'
        ? '<p class="rw-empty">Sin cables: la señal pasa limpia. Arrastra de un pin a otro (o toca dos pines) para puentearlos.</p>'
        : '<p class="rw-empty">Sin cables. Arrastra de un pin a otro, o toca dos pines.</p>';
      return;
    }
    s.cables.forEach((c, i) => {
      const pair = findPair(c.a, c.b)!;
      const col = CABLE_COLORS[i % CABLE_COLORS.length];
      const row = document.createElement('div');
      if (this.mode === 'compact') {
        row.className = 'rw-mrow';
        row.title = `${pair.a}+${pair.b} · ${pair.name}`;
        row.innerHTML = `
          <span class="rw-swatch" style="background:${col}"></span>
          <b class="rw-mname">${pair.a}+${pair.b}</b>
          <output class="rw-mval">${c.amount}</output>
          <button class="rw-mx" data-remove="${i}" aria-label="Quitar cable ${pair.a}+${pair.b}" title="Quitar cable">${ico('close')}</button>
          <input class="rw-range" type="range" min="0" max="100" step="1" value="${c.amount}" data-amount="${i}"
            style="--c:${col}" aria-label="Resistencia del cable ${pair.a}+${pair.b}" />`;
        this.list.append(row);
        return;
      }
      row.className = 'rw-row';
      row.innerHTML = `
        <span class="rw-swatch" style="background:${col}"></span>
        <div class="rw-text">
          <div class="rw-name"><b>${pair.a}+${pair.b}</b> · ${pair.name}</div>
          <div class="rw-desc">${pair.desc}</div>
          <div class="rw-filter">FILTER → ${pair.filter}</div>
        </div>
        <div class="rw-knob"></div>
        <button class="hw-btn icon-sm" data-remove="${i}" aria-label="Quitar cable ${pair.a}+${pair.b}" title="Quitar cable">${ico('trash')}</button>`;
      const k = new Knob({
        label: 'RESIST.', min: 0, max: 100, value: c.amount, def: 100, size: 'sm',
        info: 'Resistencia del cable: cuánta señal pasa por este puente.',
        onInput: (v) => this.host.edit((st) => { if (st.cables[i]) st.cables[i].amount = v; }, 'live'),
        onChange: () => this.host.edit(() => {}, 'end'),
      });
      row.querySelector('.rw-knob')!.append(k.el);
      this.knobs.push(k);
      this.list.append(row);
    });
  }
}
