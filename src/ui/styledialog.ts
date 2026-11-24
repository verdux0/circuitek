/**
 * «Estilo de capa» (Photoshop / Photopea model): a list of effects with their checkbox on the
 * left, the settings of the selected effect on the right. Every change shows live on the canvas
 * (one 'live' edit); «Aceptar» commits the whole visit as ONE undo step, «Cancelar» / Esc / ×
 * puts the style back as it was. On phones the window is a bottom sheet (CSS).
 *
 * Global light: in a shadow with «Usar luz global», the angle edited is the document's light, so
 * every effect of every layer that uses it turns too.
 */
import { BLENDS, getLayer, type Blend, type DocState } from '../doc';
import {
  CONTOURS, DEFAULT_LIGHT, EFFECTS, STYLE_PRESETS, cloneStyle, defaultStyle, scaleStyle, type EffectKey, type GlobalLight, type GlowFx, type InnerGlowFx,
  type LayerStyle, type ShadowFx,
} from '../layerstyle';
import { SliderRow } from './slider';
import { openWindow, type WindowHandle } from './window';

export interface StyleHost {
  doc(): DocState;
  /** Edits the layer's style (created with the defaults when missing); 'live' = no undo step yet. */
  edit(id: string, fn: (s: LayerStyle, d: DocState) => void): void;
  /** Ends the visit: commit (one undo step) or put back the style / light it started with. */
  finish(id: string, commit: boolean, before: { style: LayerStyle | undefined; light: GlobalLight | undefined }): void;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class StyleDialog {
  private win: WindowHandle | null = null;
  private id = '';
  private sel: EffectKey = 'dropShadow';
  private list!: HTMLElement;
  private settings!: HTMLElement;
  private enabled!: HTMLInputElement;

  constructor(private host: StyleHost) {}

  get isOpen(): boolean {
    return this.win !== null;
  }

  /** Opens the dialog on layer `id`, on effect `focus` (default: the first one in use, else drop shadow). */
  open(id: string, focus?: EffectKey): void {
    const d = this.host.doc();
    const l = getLayer(d, id);
    if (!l || this.win) return;
    this.id = id;
    const before = { style: l.style ? cloneStyle(l.style) : undefined, light: d.light ? { ...d.light } : undefined };
    const s = l.style ?? defaultStyle();
    this.sel = focus ?? EFFECTS.find((e) => s[e.key].on)?.key ?? 'dropShadow';
    const body = document.createElement('div');
    body.className = 'st';
    body.innerHTML = `
      <div class="st-grid">
        <nav class="st-list" aria-label="Efectos">
          <label class="st-preset"><span>Estilo predefinido</span>
            <select class="st-presets" aria-label="Aplicar un estilo predefinido">
              <option value="">Elegir…</option>
              ${STYLE_PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}
            </select>
          </label>
          <div class="st-items" role="listbox" aria-label="Efectos de la capa"></div>
        </nav>
        <section class="st-settings" aria-live="polite"></section>
      </div>
      <div class="st-foot">
        <label class="st-chk"><input type="checkbox" class="st-enabled" /> Mostrar efectos</label>
        <span class="st-scale">
          <label for="st-scale-v">Escalar efectos</label>
          <input id="st-scale-v" type="number" min="1" max="1000" step="1" value="100" aria-label="Escalar efectos (%)" /> %
          <button type="button" class="hw-btn hw-btn-sm st-scale-go">Escalar</button>
        </span>
        <button type="button" class="hw-btn hw-btn-sm st-clear" title="Quita todos los efectos de la capa">Borrar estilo</button>
        <span class="st-end">
          <button type="button" class="hw-btn st-cancel">Cancelar</button>
          <button type="button" class="hw-btn accent st-ok">Aceptar</button>
        </span>
      </div>`;
    this.list = body.querySelector('.st-items')!;
    this.settings = body.querySelector('.st-settings')!;
    this.enabled = body.querySelector('.st-enabled')!;
    let committed = false;
    this.win = openWindow({
      // Static title: openWindow writes it as HTML; the layer name is set below as text.
      title: 'Estilo de capa',
      body,
      className: 'win-style',
      onClose: () => {
        this.win = null;
        this.host.finish(this.id, committed, before);
      },
    });
    // The title is set as text: the layer name may come from a file name or a .glitch file.
    const h2 = this.win.el.querySelector('h2');
    if (h2) h2.textContent = `Estilo de capa · ${l.name}`;
    body.querySelector('.st-ok')!.addEventListener('click', () => {
      committed = true;
      this.win?.close();
    });
    body.querySelector('.st-cancel')!.addEventListener('click', () => this.win?.close());
    body.querySelector<HTMLSelectElement>('.st-presets')!.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      const p = STYLE_PRESETS[Number(sel.value)];
      sel.value = '';
      if (!p) return;
      this.edit((st) => Object.assign(st, cloneStyle(p.style)));
      this.sel = EFFECTS.find((x) => p.style[x.key].on)?.key ?? this.sel;
      this.render();
    });
    this.enabled.addEventListener('change', () => this.edit((st) => (st.enabled = this.enabled.checked)));
    body.querySelector('.st-scale-go')!.addEventListener('click', () => {
      const k = Number(body.querySelector<HTMLInputElement>('#st-scale-v')!.value) / 100;
      if (!(k > 0)) return;
      this.edit((st) => Object.assign(st, scaleStyle(st, k)));
      this.render();
    });
    body.querySelector('.st-clear')!.addEventListener('click', () => {
      this.edit((st) => Object.assign(st, defaultStyle()));
      this.render();
    });
    this.render();
  }

  private style(): LayerStyle {
    return getLayer(this.host.doc(), this.id)?.style ?? defaultStyle();
  }

  private edit(fn: (s: LayerStyle, d: DocState) => void): void {
    this.host.edit(this.id, fn);
    this.renderList();
  }

  private render(): void {
    this.renderList();
    this.renderSettings();
  }

  /** Left column: one row per effect, checkbox + name (the selected one highlighted). */
  private renderList(): void {
    const s = this.style();
    this.enabled.checked = s.enabled;
    this.list.replaceChildren(
      ...EFFECTS.map((e) => {
        const row = document.createElement('div');
        row.className = `st-item${e.key === this.sel ? ' sel' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(e.key === this.sel));
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = s[e.key].on;
        cb.setAttribute('aria-label', `Activar ${e.label}`);
        cb.addEventListener('change', () => {
          this.edit((st) => {
            st[e.key].on = cb.checked;
            if (cb.checked) st[e.key].hidden = false;
          });
          if (cb.checked && this.sel !== e.key) {
            this.sel = e.key;
            this.render();
          }
        });
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'st-name';
        b.textContent = e.label;
        b.addEventListener('click', () => {
          this.sel = e.key;
          this.render();
          (this.settings.querySelector('input, select') as HTMLElement | null)?.focus();
        });
        row.append(cb, b);
        return row;
      }),
    );
  }

  /** Right column: the settings of the selected effect. */
  private renderSettings(): void {
    const key = this.sel;
    const meta = EFFECTS.find((e) => e.key === key)!;
    const s = this.style();
    const fx = s[key];
    const shadow = key === 'dropShadow' || key === 'innerShadow';
    const inner = !meta.outer;
    const box = this.settings;
    box.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = meta.label;
    box.append(h);
    const set = (fn: (f: ShadowFx & GlowFx & InnerGlowFx & { knockout?: boolean }, d: DocState, st: LayerStyle) => void) =>
      this.edit((st, d) => {
        st[key].on = true;
        fn(st[key] as ShadowFx & GlowFx & InnerGlowFx & { knockout?: boolean }, d, st);
      });
    const slider = (label: string, min: number, max: number, value: number, def: number, unit: string, apply: (v: number) => void, info?: string) => {
      const r = new SliderRow({ label, min, max, value, def, size: 'sm', info, format: (v) => `${v}${unit}`, onInput: apply, onChange: apply });
      box.append(r.el);
      return r;
    };
    const select = (label: string, opts: [string, string][], value: string, apply: (v: string) => void) => {
      const l = document.createElement('label');
      l.className = 'st-field';
      const sp = document.createElement('span');
      sp.textContent = label;
      const sel = document.createElement('select');
      sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
      sel.value = value;
      sel.addEventListener('change', () => apply(sel.value));
      l.append(sp, sel);
      box.append(l);
      return sel;
    };
    const color = (label: string, value: string, apply: (v: string) => void) => {
      const l = document.createElement('label');
      l.className = 'st-field';
      const sp = document.createElement('span');
      sp.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = value;
      inp.addEventListener('input', () => apply(inp.value));
      l.append(sp, inp);
      box.append(l);
    };
    const check = (label: string, value: boolean, apply: (v: boolean) => void) => {
      const l = document.createElement('label');
      l.className = 'st-chk';
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = value;
      inp.addEventListener('change', () => apply(inp.checked));
      l.append(inp, ` ${label}`);
      box.append(l);
      return inp;
    };
    const d0 = defaultStyle()[key];
    select('Modo de fusión', BLENDS.map(([v, t]) => [v, t]), fx.blend, (v) => set((f) => (f.blend = v as Blend)));
    if (shadow) color('Color', (fx as ShadowFx).color, (v) => set((f) => (f.color = v)));
    slider('Opacidad', 0, 100, fx.opacity, d0.opacity, ' %', (v) => set((f) => (f.opacity = v)));
    if (shadow) {
      const sf = fx as ShadowFx;
      const light = this.host.doc().light?.angle ?? DEFAULT_LIGHT;
      slider(sf.useGlobal ? 'Ángulo (luz global)' : 'Ángulo', -180, 180, sf.useGlobal ? light : sf.angle, DEFAULT_LIGHT, '°', (v) =>
        set((f, d) => {
          // With global light the document's light turns: every effect that uses it follows.
          if (f.useGlobal) d.light = { angle: v };
          else f.angle = v;
        }),
        'Dirección de la luz: la sombra cae hacia el lado contrario.');
      check('Usar luz global', sf.useGlobal, (on) => {
        set((f, d) => {
          // Switching keeps the shadow where it is: the angle it had becomes the new one.
          if (on) f.angle = d.light?.angle ?? DEFAULT_LIGHT;
          f.useGlobal = on;
        });
        this.renderSettings();
      });
      slider('Distancia', 0, 300, sf.distance, 5, ' px', (v) => set((f) => (f.distance = v)));
      slider(inner ? 'Contracción' : 'Expansión', 0, 100, sf.spread, 0, ' %', (v) => set((f) => (f.spread = v)), inner ? 'Endurece el borde hacia dentro antes del desenfoque.' : 'Ensancha el borde antes del desenfoque.');
      slider('Tamaño', 0, 250, sf.size, 5, ' px', (v) => set((f) => (f.size = v)), 'Radio del desenfoque.');
    } else {
      const g = fx as GlowFx;
      slider('Ruido', 0, 100, g.noise, 0, ' %', (v) => set((f) => (f.noise = v)));
      select('Relleno', [['color', 'Color'], ['gradient', 'Degradado']], g.fill, (v) => {
        set((f) => (f.fill = v as 'color' | 'gradient'));
        this.renderSettings();
      });
      color(g.fill === 'gradient' ? 'Color (borde)' : 'Color', g.color, (v) => set((f) => (f.color = v)));
      if (g.fill === 'gradient') color('Color (final)', g.color2, (v) => set((f) => (f.color2 = v)));
      select('Técnica', [['softer', 'Suave'], ['precise', 'Precisa']], g.technique, (v) => set((f) => (f.technique = v as 'softer' | 'precise')));
      if (key === 'innerGlow') select('Origen', [['edge', 'Borde'], ['center', 'Centro']], (g as InnerGlowFx).source, (v) => set((f) => (f.source = v as 'edge' | 'center')));
      slider(inner ? 'Contracción' : 'Expansión', 0, 100, g.spread, 0, ' %', (v) => set((f) => (f.spread = v)));
      slider('Tamaño', 0, 250, g.size, 5, ' px', (v) => set((f) => (f.size = v)));
    }
    select('Contorno', CONTOURS.map(([v, t]) => [v, t]), fx.contour, (v) => set((f) => (f.contour = v as ShadowFx['contour'])));
    if (shadow) slider('Ruido', 0, 100, fx.noise, 0, ' %', (v) => set((f) => (f.noise = v)));
    else slider('Rango', 1, 100, (fx as GlowFx).range, 50, ' %', (v) => set((f) => (f.range = v)), 'Qué parte del resplandor moldea el contorno.');
    if (key === 'dropShadow') check('La capa recorta la sombra', s.dropShadow.knockout, (on) => set((f) => (f.knockout = on)));
  }
}
