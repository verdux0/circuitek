/**
 * App shell: registers the panels (by id) and docks them with the default layout.
 * Panel contents are written in index.html inside #panel-sources (one `#src-<id>` each);
 * this file only says what each panel is called and which icon it uses.
 */
import { Dock, PanelRegistry, type PanelDef } from './dock/dock';
import { defaultLayout, focusPanel, isHidden, sanitizeLayout, setPanelVisible, type Layout, type PanelId } from './dock/layout';

/** Panel sizes, folds, tabs and hidden panels survive a reload (validated on load). */
export const LAYOUT_KEY = 'circuitek:layout';

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? sanitizeLayout(JSON.parse(raw)) : defaultLayout();
  } catch {
    return defaultLayout(); // storage blocked or garbage
  }
}
function saveLayout(l: Layout): void {
  try {
    // Bottom sheets belong to one phone session: not stored.
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...l, floating: [] }));
  } catch {
    /* storage full or blocked: the layout only lives in memory */
  }
}

const PANELS: Omit<PanelDef, 'mount'>[] = [
  { id: 'effects', title: 'Efectos', icon: 'fx' },
  { id: 'motion', title: 'Movimiento', icon: 'play' },
  { id: 'stages', title: 'Etapas', icon: 'chip' },
  { id: 'layers', title: 'Capas', icon: 'layers' },
  { id: 'properties', title: 'Propiedades', icon: 'contain' },
  { id: 'projects', title: 'Proyectos', icon: 'save' },
];

export interface Shell {
  dock: Dock;
  registry: PanelRegistry;
  /** Shows a panel and makes it the active tab of its block. */
  focus(id: PanelId): void;
  /** Ventana → panel. */
  toggle(id: PanelId, visible?: boolean): void;
  visible(id: PanelId): boolean;
  /** Ventana → Restablecer diseño de paneles. */
  resetLayout(): void;
}

export function initShell(): Shell {
  const registry = new PanelRegistry();
  for (const p of PANELS) {
    registry.register({
      ...p,
      mount: () => {
        const el = document.getElementById(`src-${p.id}`);
        if (!el) throw new Error(`Panel ${p.id}: no #src-${p.id} in index.html`);
        return el;
      },
    });
  }
  const dock = new Dock(
    registry,
    {
      columns: { left: document.getElementById('dock-left')!, right: document.getElementById('dock-right')! },
      icons: document.getElementById('dock-icons')!,
      float: document.getElementById('dock-float')!,
    },
    loadLayout(),
    matchMedia('(max-width: 768px)'),
  );
  let saveTimer = 0;
  dock.onChange = (l) => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveLayout(l), 300);
  };
  document.getElementById('panel-sources')?.remove();
  return {
    dock,
    registry,
    focus: (id) => {
      dock.setLayout(focusPanel(dock.layout, id));
      // Phones: panels are not docked, so showing one means opening it floating.
      if (dock.compact) dock.toggleFloating(id, true);
    },
    toggle: (id, visible) => dock.setLayout(setPanelVisible(dock.layout, id, visible ?? isHidden(dock.layout, id))),
    visible: (id) => !isHidden(dock.layout, id),
    resetLayout: () => dock.setLayout(defaultLayout()),
  };
}
