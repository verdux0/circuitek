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
 * - Columns and blocks are resizable: a separator between each column and the canvas, and one
 *   between neighbour blocks (separator.ts). Dragging previews the size directly on the elements
 *   (no re-render); the layout is committed once, when the drag ends. A column folds to a strip
 *   when dragged far below its minimum; a block folds to its header with its ▾ button.
 * - Compact mode (phones, ≤ 768 px): the columns turn into one column of icons, and a panel opens
 *   as a bottom sheet over the canvas (Layout.floating), with its block's tabs, a close button and
 *   a grab handle on its top edge to drag its height.
 */
import { ico } from '../icons';
import {
  BLOCK_MIN, COL_FOLDED, COL_MIN, FOLD_SLACK, SHEET_MIN, blockOf, clampSheet, effectiveWidth, isHidden, maxColumnWidth, resetBlocks, resetColumn,
  resizeBlocks, setBlockCollapsed, setColumnCollapsed, setColumnWidth, type FloatingPanel, type Layout, type PanelId,
} from './layout';
import { makeSeparator } from './separator';

export interface DockHosts {
  /** One host element per column id. */
  columns: Record<string, HTMLElement>;
  /** Icon column (compact mode). */
  icons: HTMLElement;
  /** Layer over the canvas where floating panels go. */
  float: HTMLElement;
}


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
    // Window resized: keep the columns inside the new limits (widths only, nothing re-rendered).
    let rq = 0;
    window.addEventListener('resize', () => {
      if (!rq) rq = requestAnimationFrame(() => {
        rq = 0;
        this.applyWidths();
      });
    });
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
    // One bottom sheet at a time, as wide as the canvas; it keeps the last height the user chose.
    const h = clampSheet(prev?.h ?? Math.round(area.height * 0.55), area.height);
    this.setLayout({ ...this.current, floating: [{ panel: id, x: 0, y: Math.max(0, area.height - h), w: area.width, h }] });
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
    // A separator with keyboard focus is rebuilt below: the focus goes to its replacement.
    const focusedSep = (document.activeElement as HTMLElement | null)?.dataset?.sep;
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
      host.style.setProperty('--col-w', `${effectiveWidth(this.current, col.id, window.innerWidth)}px`);
      host.classList.toggle('collapsed', col.collapsed);
      if (compact) continue;
      if (col.collapsed) host.append(this.foldedStrip(col.id, col.side));
      else {
        let prev: { id: string; el: HTMLElement } | null = null;
        for (const block of col.blocks) {
          const tabs = block.tabs.filter((t) => visible(t) && !floatingIds.has(t));
          if (!tabs.length) continue;
          const active = tabs.includes(block.activeTab) ? block.activeTab : tabs[0];
          const el = this.renderBlock(block.id, tabs, active, block.size, (id) => this.activate(block.id, id), !!block.collapsed);
          if (prev) host.append(this.blockSeparator(prev, { id: block.id, el }));
          host.append(el);
          prev = { id: block.id, el };
        }
      }
      host.append(this.columnSeparator(col.id, col.side, host));
    }
    this.renderIcons(compact, visible, floatingIds);
    this.hosts.float.replaceChildren();
    for (const f of floating) this.hosts.float.append(this.renderFloating(f, visible));
    if (focusedSep) document.querySelector<HTMLElement>(`[data-sep="${focusedSep}"]`)?.focus();
  }

  /** Widths only (window resize): every column inside the limits of the new window. */
  private applyWidths(): void {
    for (const col of this.current.columns) this.hosts.columns[col.id]?.style.setProperty('--col-w', `${effectiveWidth(this.current, col.id, window.innerWidth)}px`);
  }

  /** A folded column: a strip with one button that unfolds it. */
  private foldedStrip(id: string, side: 'left' | 'right'): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dock-unfold';
    b.setAttribute('aria-label', side === 'left' ? 'Desplegar la columna izquierda' : 'Desplegar la columna derecha');
    b.title = 'Desplegar panel';
    b.innerHTML = ico(side === 'left' ? 'chevron-right' : 'chevron-left');
    b.addEventListener('click', () => this.setLayout(setColumnCollapsed(this.current, id, false)));
    return b;
  }

  /** The separator between a column and the canvas. */
  private columnSeparator(id: string, side: 'left' | 'right', host: HTMLElement): HTMLElement {
    const dir = side === 'left' ? 1 : -1;
    const width = () => effectiveWidth(this.current, id, window.innerWidth);
    let w0 = 0;
    let dragging = false;
    const sep = makeSeparator({
      orientation: 'vertical',
      label: side === 'left' ? 'Ancho de la columna izquierda' : 'Ancho de la columna derecha',
      className: `dock-sep-col dock-sep-${side}`,
      value: () => ({ now: width(), min: COL_MIN, max: maxColumnWidth(this.current, id, window.innerWidth) }),
      move: (d) => {
        if (!dragging) {
          dragging = true;
          w0 = width();
        }
        const w = w0 + d * dir;
        const folding = w < COL_MIN - FOLD_SLACK;
        const max = maxColumnWidth(this.current, id, window.innerWidth);
        host.classList.toggle('fold-preview', folding);
        host.style.setProperty('--col-w', `${folding ? COL_FOLDED : Math.min(max, Math.max(COL_MIN, w))}px`);
      },
      end: (d) => {
        const base = dragging ? w0 : width();
        dragging = false;
        host.classList.remove('fold-preview');
        if (d === 0) return this.applyWidths();
        this.setLayout(setColumnWidth(this.current, id, base + d * dir, window.innerWidth));
      },
      reset: () => this.setLayout(resetColumn(this.current, id)),
    });
    sep.dataset.sep = `col-${id}`;
    return sep;
  }

  /** The separator between two neighbour blocks of a column. */
  private blockSeparator(a: { id: string; el: HTMLElement }, b: { id: string; el: HTMLElement }): HTMLElement {
    let h0 = { a: 0, b: 0 };
    let dragging = false;
    const measure = () => ({ a: a.el.getBoundingClientRect().height, b: b.el.getBoundingClientRect().height });
    const split = (d: number) => {
      const total = h0.a + h0.b;
      const ha = Math.min(total - BLOCK_MIN, Math.max(BLOCK_MIN, h0.a + d));
      return { ha, hb: total - ha };
    };
    const sep = makeSeparator({
      orientation: 'horizontal',
      label: 'Altura de los paneles de la columna',
      className: 'dock-sep-block',
      value: () => {
        const m = measure();
        return { now: m.a, min: BLOCK_MIN, max: Math.max(BLOCK_MIN, m.a + m.b - BLOCK_MIN) };
      },
      move: (d) => {
        if (!dragging) {
          dragging = true;
          h0 = measure();
        }
        const { ha, hb } = split(d);
        a.el.style.flexGrow = String(ha);
        b.el.style.flexGrow = String(hb);
      },
      end: (d) => {
        if (!dragging) h0 = measure();
        dragging = false;
        // A folded block has no height to share: unfold it first (its ▾ button).
        if (d === 0 || a.el.classList.contains('collapsed') || b.el.classList.contains('collapsed')) return this.render();
        const { ha, hb } = split(d);
        this.setLayout(resizeBlocks(this.current, a.id, b.id, ha, hb));
      },
      reset: () => this.setLayout(resetBlocks(this.current, a.id, b.id)),
    });
    sep.dataset.sep = `blk-${a.id}-${b.id}`;
    return sep;
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
    el.classList.add('dock-sheet');
    const areaH = () => this.hosts.float.getBoundingClientRect().height;
    const place = (h: number) => {
      el.style.height = `${h}px`;
    };
    place(clampSheet(f.h, areaH()));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dock-float-close';
    close.setAttribute('aria-label', 'Cerrar panel');
    close.title = 'Cerrar';
    close.innerHTML = ico('close');
    close.addEventListener('click', () => this.toggleFloating(f.panel, false));
    el.querySelector('.dock-head')!.append(close);
    // Grab handle on the top edge: drag up / down to change the sheet's height.
    let h0 = 0;
    let dragging = false;
    const commit = (h: number) => this.setLayout({ ...this.current, floating: this.current.floating.map((x) => (x.panel === f.panel ? { ...x, h } : x)) });
    const grip = makeSeparator({
      orientation: 'horizontal',
      label: 'Altura del panel',
      className: 'dock-sheet-grip',
      value: () => ({ now: el.getBoundingClientRect().height, min: SHEET_MIN, max: Math.max(SHEET_MIN, areaH() - 40) }),
      move: (d) => {
        if (!dragging) {
          dragging = true;
          h0 = el.getBoundingClientRect().height;
        }
        place(clampSheet(h0 - d, areaH()));
      },
      end: (d) => {
        const base = dragging ? h0 : el.getBoundingClientRect().height;
        dragging = false;
        commit(clampSheet(base - d, areaH()));
      },
      reset: () => commit(clampSheet(Math.round(areaH() * 0.55), areaH())),
    });
    grip.dataset.sep = 'sheet';
    el.prepend(grip);
    return el;
  }

  /** A tab of a floating panel: the same window shows the other panel of its block. */
  private swapFloating(from: PanelId, to: PanelId): void {
    if (from === to) return;
    this.setLayout({ ...this.current, floating: this.current.floating.map((f) => (f.panel === from ? { ...f, panel: to } : f)) });
    document.getElementById(`dock-tab-${to}`)?.focus();
  }

  private renderBlock(blockId: string, tabs: PanelId[], active: PanelId, size: number, onTab: (id: PanelId) => void, collapsed = false): HTMLElement {
    const el = document.createElement('section');
    el.className = 'dock-block';
    el.classList.toggle('collapsed', collapsed);
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
    // Docked blocks fold to their header (bottom sheets have their own close button).
    if (!this.compact) {
      const fold = document.createElement('button');
      fold.type = 'button';
      fold.className = 'dock-fold';
      fold.setAttribute('aria-expanded', String(!collapsed));
      fold.setAttribute('aria-label', collapsed ? 'Desplegar panel' : 'Plegar panel');
      fold.title = collapsed ? 'Desplegar' : 'Plegar';
      fold.innerHTML = ico('chevron');
      fold.addEventListener('click', () => this.setLayout(setBlockCollapsed(this.current, blockId, !collapsed)));
      head.append(fold);
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
