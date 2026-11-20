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
 */
import { ico } from '../icons';
import { isHidden, type Layout, type PanelId } from './layout';

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
    /** One host element per column id. */
    private hosts: Record<string, HTMLElement>,
    private current: Layout,
  ) {
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
    for (const col of this.current.columns) {
      const host = this.hosts[col.id];
      if (!host) continue;
      host.replaceChildren();
      host.dataset.side = col.side;
      host.style.setProperty('--col-w', `${col.width}px`);
      host.classList.toggle('collapsed', col.collapsed);
      for (const block of col.blocks) {
        const tabs = block.tabs.filter((t) => !isHidden(this.current, t) && this.registry.get(t));
        if (!tabs.length) continue;
        const active = tabs.includes(block.activeTab) ? block.activeTab : tabs[0];
        host.append(this.renderBlock(block.id, tabs, active, block.size));
      }
    }
  }

  private renderBlock(blockId: string, tabs: PanelId[], active: PanelId, size: number): HTMLElement {
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
      b.addEventListener('click', () => this.activate(blockId, id));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = tabs.indexOf(id);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        this.activate(blockId, next);
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
