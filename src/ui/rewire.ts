/** The "Rewire" sheet: a CCD chip on a PCB. Drag (or tap-tap) between pins to bridge them. */
import { MAX_CABLES, PINS, PIN_INFO, findPair, pairLabel, type GlitchState, type Pin } from '../model';
import { Knob } from './knob';

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
}

export class RewirePanel {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private cablesG: SVGGElement;
  private temp: SVGPathElement;
  private list: HTMLElement;
  private selected: Pin | null = null;
  private knobs: Knob[] = [];

  constructor(private host: RewireHost) {
    const el = document.createElement('div');
    el.className = 'sheet-backdrop';
    el.hidden = true;
    const pinsSvg = PINS.map((p) => {
      const [x, y] = PIN_POS[p];
      const left = PIN_INFO[p].side === 'L';
      const leadX = left ? 250 : 390;
      return `
        <line class="lead" x1="${x}" y1="${y}" x2="${leadX}" y2="${y}"/>
        <g class="pin" data-pin="${p}" tabindex="0" role="button" aria-label="Pin ${p}: ${PIN_INFO[p].name}">
          <circle class="pin-hit" cx="${x}" cy="${y}" r="22"/>
          <circle class="pin-pad" cx="${x}" cy="${y}" r="8"/>
          <text class="pin-label" x="${left ? x - 20 : x + 20}" y="${y + 6}" text-anchor="${left ? 'end' : 'start'}">${p}</text>
        </g>`;
    }).join('');
    el.innerHTML = `
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="rw-title">
        <header class="sheet-head">
          <h2 id="rw-title">Cortocircuita el CCD</h2>
          <button class="hw-btn sheet-close" data-act="close" aria-label="Cerrar">Listo</button>
        </header>
        <p class="sheet-intro">El CCD convierte la luz en señal de vídeo línea a línea. Puentea dos de sus pines y las señales de funciones distintas se mezclan: la imagen se corrompe. Cada par falla a su manera. Hasta ${MAX_CABLES} cables a la vez.</p>
        <div class="pcb">
          <svg viewBox="0 0 640 300" class="pcb-svg">
            <defs>
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
            <text class="silk" x="618" y="18" text-anchor="end">J1 CCD</text>
            <rect class="chip-shadow" x="254" y="38" width="136" height="232" rx="8"/>
            <rect class="chip" x="250" y="32" width="140" height="236" rx="8"/>
            <circle class="chip-notch" cx="270" cy="52" r="5"/>
            <text class="chip-label" x="320" y="150" transform="rotate(90 320 150)" text-anchor="middle">CCD-01</text>
            ${pinsSvg}
            <g class="cables"></g>
            <path class="cable-temp" d="" />
          </svg>
        </div>
        <div class="rw-list" aria-live="polite"></div>
        <dl class="pin-legend">
          ${PINS.map((p) => `<div><dt><b>${p}</b> ${PIN_INFO[p].name}</dt><dd>${PIN_INFO[p].desc}</dd></div>`).join('')}
        </dl>
      </section>`;
    this.el = el;
    this.svg = el.querySelector('svg')!;
    this.cablesG = el.querySelector('.cables')!;
    this.temp = el.querySelector('.cable-temp')!;
    this.list = el.querySelector('.rw-list')!;
    this.bind();
  }

  open(): void {
    this.el.hidden = false;
    this.sync();
    (this.el.querySelector('.sheet-close') as HTMLElement).focus();
  }

  close(): void {
    this.el.hidden = true;
    this.setSelected(null);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private toSvg(e: PointerEvent): [number, number] {
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const r = pt.matrixTransform(m.inverse());
    return [r.x, r.y];
  }

  private pinAt(e: PointerEvent): Pin | null {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const g = t?.closest('[data-pin]');
    return (g?.getAttribute('data-pin') as Pin | null) ?? null;
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

  private bind(): void {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-act="close"]')) this.close();
      const rm = t.closest('[data-remove]');
      if (rm) {
        const i = Number(rm.getAttribute('data-remove'));
        this.host.edit((s) => s.cables.splice(i, 1), 'once');
      }
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      const g = (e.target as Element).closest?.('[data-pin]');
      if (g && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.tapPin(g.getAttribute('data-pin') as Pin);
      }
    });

    let from: Pin | null = null;
    this.svg.addEventListener('pointerdown', (e) => {
      const cable = (e.target as Element).closest('[data-cable]');
      if (cable) {
        const i = Number(cable.getAttribute('data-cable'));
        this.host.edit((s) => s.cables.splice(i, 1), 'once');
        return;
      }
      const p = this.pinAt(e);
      if (!p) {
        this.setSelected(null);
        return;
      }
      e.preventDefault();
      from = p;
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!from) return;
      const [x1, y1] = PIN_POS[from];
      const [x, y] = this.toSvg(e);
      if (Math.hypot(x - x1, y - y1) < 12) return;
      this.temp.setAttribute('d', `M${x1},${y1} Q${(x1 + x) / 2},${Math.max(y1, y) + 60} ${x},${y}`);
    });
    this.svg.addEventListener('pointerup', (e) => {
      if (!from) return;
      const start = from;
      from = null;
      this.temp.setAttribute('d', '');
      const to = this.pinAt(e);
      if (to && to !== start) {
        this.setSelected(null);
        this.connect(start, to);
      } else if (to === start) {
        this.tapPin(start);
      }
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

    this.knobs = [];
    this.list.innerHTML = '';
    if (!s.cables.length) {
      this.list.innerHTML = '<p class="rw-empty">Sin cables: la señal pasa limpia. Arrastra de un pin a otro (o toca dos pines) para puentearlos.</p>';
      return;
    }
    s.cables.forEach((c, i) => {
      const pair = findPair(c.a, c.b)!;
      const row = document.createElement('div');
      row.className = 'rw-row';
      row.innerHTML = `
        <span class="rw-swatch" style="background:${CABLE_COLORS[i % CABLE_COLORS.length]}"></span>
        <div class="rw-text">
          <div class="rw-name"><b>${pair.a}+${pair.b}</b> · ${pair.name}</div>
          <div class="rw-desc">${pair.desc}</div>
          <div class="rw-filter">FILTER → ${pair.filter}</div>
        </div>
        <div class="rw-knob"></div>
        <button class="hw-btn hw-btn-sm" data-remove="${i}" aria-label="Quitar cable ${pair.a}+${pair.b}">Quitar</button>`;
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
