/**
 * Collapsible ("desplegable") sections of the side panel:
 *  - `.module[data-collapse=id]` gets a chevron in its header; the title toggles it too.
 *  - `details.sub[data-sub=id]` sub-sections (rebuilt by the layers panel) keep their state.
 * State is remembered per section in localStorage (a viewer convenience).
 */
import { ico } from './icons';

const KEY = 'glitch-editor:collapsed';
let state: Record<string, boolean> = {};
try {
  state = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>;
} catch {
  state = {};
}
function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

function setModule(m: HTMLElement, collapsed: boolean): void {
  m.classList.toggle('collapsed', collapsed);
  m.querySelector('.collapse-btn')?.setAttribute('aria-expanded', String(!collapsed));
}

function apply(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.module[data-collapse]').forEach((m) => {
    if (m.dataset.collapseReady) return;
    m.dataset.collapseReady = '1';
    const id = m.dataset.collapse!;
    const head = m.querySelector<HTMLElement>('.module-head');
    if (!head) return;
    const b = document.createElement('button');
    b.className = 'collapse-btn';
    b.type = 'button';
    b.innerHTML = ico('chevron');
    const title = head.querySelector('h3')?.textContent?.trim() ?? 'sección';
    b.setAttribute('aria-label', `Plegar o desplegar ${title}`);
    b.title = 'Plegar / desplegar';
    head.prepend(b);
    const toggle = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      state[id] = !m.classList.contains('collapsed');
      setModule(m, state[id]);
      save();
    };
    b.addEventListener('click', toggle);
    head.querySelector('h3')?.addEventListener('click', toggle);
    setModule(m, !!state[id]);
  });
  root.querySelectorAll<HTMLDetailsElement>('details.sub[data-sub]').forEach((d) => {
    if (d.dataset.collapseReady) return;
    d.dataset.collapseReady = '1';
    const id = `sub-${d.dataset.sub}`;
    if (id in state) d.open = !state[id];
    d.addEventListener('toggle', () => {
      state[id] = !d.open;
      save();
    });
  });
}

/** Makes every collapsible section inside `root` work, including ones added later. */
export function initCollapsibles(root: HTMLElement): void {
  apply(root);
  new MutationObserver(() => apply(root)).observe(root, { childList: true, subtree: true });
}
