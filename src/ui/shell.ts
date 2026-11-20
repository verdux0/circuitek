/**
 * App shell: registers the panels (by id) and docks them with the default layout.
 * Panel contents are written in index.html inside #panel-sources (one `#src-<id>` each);
 * this file only says what each panel is called and which icon it uses.
 */
import { Dock, PanelRegistry, type PanelDef } from './dock/dock';
import { defaultLayout, focusPanel, isHidden, setPanelVisible, type PanelId } from './dock/layout';

const PANELS: Omit<PanelDef, 'mount'>[] = [
  { id: 'effects', title: 'Efectos', icon: 'fx' },
  { id: 'motion', title: 'Movimiento', icon: 'play' },
  { id: 'stages', title: 'Etapas', icon: 'chip' },
  { id: 'layers', title: 'Capas', icon: 'layers' },
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
  const dock = new Dock(registry, { left: document.getElementById('dock-left')!, right: document.getElementById('dock-right')! }, defaultLayout());
  document.getElementById('panel-sources')?.remove();
  return {
    dock,
    registry,
    focus: (id) => dock.setLayout(focusPanel(dock.layout, id)),
    toggle: (id, visible) => dock.setLayout(setPanelVisible(dock.layout, id, visible ?? isHidden(dock.layout, id))),
    visible: (id) => !isHidden(dock.layout, id),
  };
}
