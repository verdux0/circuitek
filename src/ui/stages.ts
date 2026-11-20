/** Extra signal stages after the CCD: one "module" card per stage with bypass, LED and knobs. */
import { STAGES, stageActive, type GlitchState, type StageId } from '../model';
import { Knob } from './knob';
import { ico } from './icons';

export interface StagesHost {
  state: () => GlitchState;
  edit: (fn: (s: GlitchState) => void, phase: 'live' | 'end' | 'once') => void;
}

export class StagesPanel {
  readonly el: HTMLElement;
  private knobs = new Map<string, Knob>();
  private cards = new Map<StageId, HTMLElement>();

  constructor(private host: StagesHost) {
    const el = document.createElement('div');
    el.className = 'stages';
    for (const def of STAGES) {
      const card = document.createElement('section');
      card.className = 'module';
      card.dataset.collapse = `stage-${def.id}`;
      card.innerHTML = `
        <header class="module-head" title="${def.info}">
          <span class="led" aria-hidden="true"></span>
          <h3>${def.name}</h3>
          <span class="module-chip">${def.chip}</span>
          <label class="switch" title="Bypass: activa o puentea esta etapa">
            <input type="checkbox" aria-label="Activar etapa ${def.name}">
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </header>
        <div class="module-knobs"></div>`;
      const box = card.querySelector('.module-knobs')!;
      for (const p of def.params) {
        const k = new Knob({
          label: p.label, min: p.min, max: p.max, def: p.def, step: p.step, value: p.def, size: 'sm', info: p.info,
          format: (v) => (p.names ? p.names[v] ?? String(v) : p.unit === '%' ? `${v}%` : p.unit ? `${v} ${p.unit}` : String(v)),
          onInput: (v) => this.host.edit((s) => { s.stages[def.id].p[p.id] = v; s.stages[def.id].on = true; }, 'live'),
          onChange: () => this.host.edit(() => {}, 'end'),
        });
        this.knobs.set(`${def.id}.${p.id}`, k);
        box.append(k.el);
      }
      const input = card.querySelector('input')!;
      input.addEventListener('change', () => this.host.edit((s) => { s.stages[def.id].on = input.checked; }, 'once'));
      const reset = document.createElement('button');
      reset.className = 'hw-btn icon-sm module-reset';
      reset.innerHTML = ico('reset');
      reset.title = 'Restablecer los knobs de esta etapa';
      reset.setAttribute('aria-label', `Restablecer ${def.name}`);
      reset.addEventListener('click', () => this.host.edit((s) => {
        for (const p of def.params) s.stages[def.id].p[p.id] = p.def;
        // At defaults the stage does nothing: it no longer shows as engaged.
        s.stages[def.id].on = false;
      }, 'once'));
      card.querySelector('.module-head')!.append(reset);
      this.cards.set(def.id, card);
      el.append(card);
    }
    this.el = el;
  }

  sync(): void {
    const s = this.host.state();
    for (const def of STAGES) {
      const card = this.cards.get(def.id)!;
      const st = s.stages[def.id];
      (card.querySelector('input') as HTMLInputElement).checked = st.on;
      card.classList.toggle('bypassed', !st.on);
      card.querySelector('.led')!.classList.toggle('on', stageActive(s, def.id));
      for (const p of def.params) this.knobs.get(`${def.id}.${p.id}`)!.set(st.p[p.id]);
    }
  }

  /**
   * Shows the values of `s` on the knobs without editing anything (an animation frame).
   * The knob the user is dragging is left alone: its value is the new base.
   */
  showValues(s: GlitchState): void {
    for (const def of STAGES) {
      for (const p of def.params) {
        const k = this.knobs.get(`${def.id}.${p.id}`)!;
        if (!k.el.classList.contains('active')) k.set(s.stages[def.id].p[p.id]);
      }
    }
  }

  /** Cheap update while dragging (LEDs only). */
  syncLeds(): void {
    const s = this.host.state();
    for (const def of STAGES) this.cards.get(def.id)!.querySelector('.led')!.classList.toggle('on', stageActive(s, def.id));
  }
}
