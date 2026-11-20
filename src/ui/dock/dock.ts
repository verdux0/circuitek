/**
 * Renders a Layout (layout.ts) into the left / right dock columns.
 *
 * - The panel registry maps an id to a definition (title, icon, mount). The layout stores ids
 *   only; a panel never knows which column, block or tab it sits in.
 * - Each panel's element is mounted once and then moved around, so its listeners and state
 *   survive re-renders. Panels that are not on screen wait in a hidden holder that stays in
 *   the document (code that looks elements up by id keeps working).
 * - Columns keep their width even when every panel in them is hidden: the canvas never moves
 *   when panels are opened or closed.
 * - Compact mode (phones, ≤ 768 px; Photopea reference, section 9): the columns turn into one
 *   column of icons, and a panel opens as a floating panel over the canvas (Layout.floating),
 *   with its block's tabs, a close button and a resize handle in the bottom-left corner.
 */
import { ico } from '../icons';
import { blockOf, isHidden, type FloatingPanel, type Layout, type PanelId } from './layout';

export interface DockHosts {
  /** One host element per column id. */
  columns: Record<string, HTMLElement>;
  /** Icon column (compact mode). */
  icons: HTMLElement;
  /** Layer over the canvas where floating panels go. */
  float: HTMLElement;
}

const FLOAT_MIN_W = 220;
const FLOAT_MIN_H = 160;
const FLOAT_GAP = 4;

export interface PanelDef {
  id: PanelId;
  /** Tab / Ventana label. */
  title: string;
  /** Icon name (ui/icons.ts) for the collapsed icon column. */
  icon: string;
  /** Builds (or returns) the panel's content. Called once. */
  mount(): HTMLElement;
}

export class PanelRegistry {
  private defs = new Map<PanelId, PanelDef>();
  register(def: PanelDef): void {
    this.defs.set(def.id, def);
  }
  get(id: PanelId): PanelDef | undefined {
    return this.defs.get(id);
  }
  ids(): PanelId[] {
    return [...this.defs.keys()];
  }
}

export class Dock {
  private bodies = new Map<PanelId, HTMLElement>();
  private holder: HTMLElement;
  onChange: (l: Layout) => void = () => {};

  constructor(
    private registry: PanelRegistry,
    private hosts: DockHosts,
    private current: Layout,
    /** Matches on phones: compact mode. */
    private compactQuery: MediaQueryList,
  ) {
    compactQuery.addEventListener('change', () => {
      // Floating panels belong to the phone layout: back on a wide screen they dock again.
      if (!compactQuery.matches && this.current.floating.length) this.setLayout({ ...this.current, floating: [] });
      else this.render();
    });
    this.holder = document.createElement('div');
    this.holder.className = 'dock-holder';
    this.holder.hidden = true;
    document.body.append(this.holder);
    // Every panel is mounted up front, so hidden ones exist in the document too.
    for (const id of registry.ids()) this.body(id);
    this.render();
  }

  get layout(): Layout {
    return this.current;
  }

  get compact(): boolean {
    return this.compactQuery.matches;
  }

  /** Compact mode: opens the panel floating over the canvas, or closes it if it is open. */
  toggleFloating(id: PanelId, open?: boolean): void {
    const cur = this.current.floating.find((f) => f.panel === id);
    const want = open ?? !cur;
    if (!want) return this.setLayout({ ...this.current, floating: this.current.floating.filter((f) => f.panel !== id) });
    if (cur) return;
    const area = this.hosts.float.getBoundingClientRect();
    const prev = this.current.floating[0];
    const w = Math.max(FLOAT_MIN_W, Math.min(prev?.w ?? 300, area.width - FLOAT_GAP * 2));
    const h = Math.max(FLOAT_MIN_H, Math.min(prev?.h ?? 560, area.height - FLOAT_GAP * 2));
    // One floating panel at a time, next to the icon column (as in the reference, capture 13).
    this.setLayout({ ...this.current, floating: [{ panel: id, x: Math.max(0, area.width - w - FLOAT_GAP), y: FLOAT_GAP, w, h }] });
  }

  setLayout(l: Layout): void {
    this.current = l;
    this.render();
    this.onChange(l);
  }

  /** The panel's content element (mounted on first use). */
  body(id: PanelId): HTMLElement | null {
    let el = this.bodies.get(id);
    if (el) return el;
    const def = this.registry.get(id);
    if (!def) return null;
    el = def.mount();
    el.classList.add('panel-body');
    el.dataset.panel = id;
    this.bodies.set(id, el);
    this.holder.append(el);
    return el;
  }

  private render(): void {
    // Park every mounted panel first; the visible ones are moved back below.
    for (const el of this.bodies.values()) this.holder.append(el);
    const compact = this.compact;
    const visible = (t: PanelId) => !isHidden(this.current, t) && !!this.registry.get(t);
    const floating = this.current.floating.filter((f) => visible(f.panel));
    const floatingIds = new Set(floating.map((f) => f.panel));
    for (const col of this.current.columns) {
      const host = this.hosts.columns[col.id];
      if (!host) continue;
      host.replaceChildren();
      host.dataset.side = col.side;
      host.style.setProperty('--col-w', `${col.width}px`);
      host.classList.toggle('collapsed', col.collapsed);
      if (compact) continue;
      for (const block of col.blocks) {
        const tabs = block.tabs.filter((t) => visible(t) && !floatingIds.has(t));
        if (!tabs.length) continue;
        const active = tabs.includes(block.activeTab) ? block.activeTab : tabs[0];
        host.append(this.renderBlock(block.id, tabs, active, block.size, (id) => this.activate(block.id, id)));
      }
    }
    this.renderIcons(compact, visible, floatingIds);
    this.hosts.float.replaceChildren();
    for (const f of floating) this.hosts.float.append(this.renderFloating(f, visible));
  }

  private renderIcons(compact: boolean, visible: (t: PanelId) => boolean, open: Set<PanelId>): void {
    const host = this.hosts.icons;
    host.replaceChildren();
    if (!compact) return;
    let first = true;
    for (const col of this.current.columns) {
      for (const block of col.blocks) {
        const tabs = block.tabs.filter(visible);
        if (!tabs.length) continue;
        if (!first) host.insertAdjacentHTML('beforeend', '<span class="dock-icon-sep" aria-hidden="true"></span>');
        first = false;
        for (const id of tabs) {
          const def = this.registry.get(id)!;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'dock-icon';
          b.dataset.panel = id;
          b.setAttribute('aria-pressed', String(open.has(id)));
          b.setAttribute('aria-label', def.title);
          b.title = def.title;
          b.innerHTML = ico(def.icon);
          b.addEventListener('click', () => this.toggleFloating(id));
          host.append(b);
        }
      }
    }
  }

  private renderFloating(f: FloatingPanel, visible: (t: PanelId) => boolean): HTMLElement {
    const block = blockOf(this.current, f.panel);
    const tabs = (block?.tabs ?? [f.panel]).filter(visible);
    const el = this.renderBlock(block?.id ?? f.panel, tabs, f.panel, 1, (id) => this.swapFloating(f.panel, id));
    el.classList.add('dock-float');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', this.registry.get(f.panel)!.title);
    const place = (x: number, y: number, w: number, h: number) => Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    place(f.x, f.y, f.w, f.h);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dock-float-close';
    close.setAttribute('aria-label', 'Cerrar panel');
    close.title = 'Cerrar';
    close.innerHTML = ico('close');
    close.addEventListener('click', () => this.toggleFloating(f.panel, false));
    el.querySelector('.dock-head')!.append(close);
    // Resize handle in the bottom-left corner: the right edge stays next to the icon column.
    const grip = document.createElement('span');
    grip.className = 'dock-float-resize';
    grip.setAttribute('aria-hidden', 'true');
    let sx = 0;
    let sy = 0;
    let g = { ...f };
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      sx = e.clientX;
      sy = e.clientY;
      g = { ...f };
    });
    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      const area = this.hosts.float.getBoundingClientRect();
      const right = f.x + f.w;
      const w = Math.max(FLOAT_MIN_W, Math.min(right, f.w - (e.clientX - sx)));
      const h = Math.max(FLOAT_MIN_H, Math.min(area.height - f.y, f.h + (e.clientY - sy)));
      g = { ...f, x: right - w, w, h };
      place(g.x, g.y, g.w, g.h);
    });
    const end = (e: PointerEvent) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      grip.releasePointerCapture(e.pointerId);
      this.setLayout({ ...this.current, floating: this.current.floating.map((x) => (x.panel === f.panel ? g : x)) });
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    el.append(grip);
    return el;
  }

  /** A tab of a floating panel: the same window shows the other panel of its block. */
  private swapFloating(from: PanelId, to: PanelId): void {
    if (from === to) return;
    this.setLayout({ ...this.current, floating: this.current.floating.map((f) => (f.panel === from ? { ...f, panel: to } : f)) });
    document.getElementById(`dock-tab-${to}`)?.focus();
  }

  private renderBlock(blockId: string, tabs: PanelId[], active: PanelId, size: number, onTab: (id: PanelId) => void): HTMLElement {
    const el = document.createElement('section');
    el.className = 'dock-block';
    el.dataset.block = blockId;
    el.style.flexGrow = String(size);
    const head = document.createElement('div');
    head.className = 'dock-head';
    head.setAttribute('role', 'tablist');
    for (const id of tabs) {
      const def = this.registry.get(id)!;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dock-tab';
      b.setAttribute('role', 'tab');
      b.id = `dock-tab-${id}`;
      b.dataset.panel = id;
      b.setAttribute('aria-selected', String(id === active));
      b.setAttribute('aria-controls', `dock-panel-${id}`);
      b.tabIndex = id === active ? 0 : -1;
      b.innerHTML = `${ico(def.icon)}<span>${def.title}</span>`;
      b.addEventListener('click', () => onTab(id));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = tabs.indexOf(id);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        onTab(next);
        document.getElementById(`dock-tab-${next}`)?.focus();
      });
      head.append(b);
    }
    const body = this.body(active)!;
    body.id = `dock-panel-${active}`;
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', `dock-tab-${active}`);
    const wrap = document.createElement('div');
    wrap.className = 'dock-content';
    wrap.append(body);
    el.append(head, wrap);
    return el;
  }

  private activate(blockId: string, id: PanelId): void {
    this.setLayout({
      ...this.current,
      columns: this.current.columns.map((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === blockId ? { ...b, activeTab: id } : b)) })),
    });
  }
}
