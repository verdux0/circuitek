/**
 * Small context menu (one at a time). Opens next to the cursor, kept inside the viewport;
 * closes on a choice, a click / right click outside, Escape, scroll, resize or window blur.
 * Keyboard: ↑ ↓ Home End move, Enter / Space choose.
 */
import { ico } from './icons';

export interface MenuItem {
  label: string;
  icon?: string;
  /** Shortcut shown on the right (informative). */
  keys?: string;
  disabled?: boolean;
  danger?: boolean;
  action: () => void;
}
export type MenuEntry = MenuItem | 'sep';

const MARGIN = 6;

export class ContextMenu {
  private el: HTMLElement | null = null;
  private restoreFocus: HTMLElement | null = null;
  private readonly onDocPointer = (e: Event) => {
    if (this.el && !this.el.contains(e.target as Node)) this.close();
  };
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onClose = () => this.close();

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(clientX: number, clientY: number, entries: MenuEntry[], label = 'Menú'): void {
    this.close();
    const el = document.createElement('div');
    el.className = 'ctx-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', label);
    entries.forEach((it, i) => {
      if (it === 'sep') {
        if (i > 0 && i < entries.length - 1) el.insertAdjacentHTML('beforeend', '<div class="ctx-sep" role="separator"></div>');
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.disabled = !!it.disabled;
      b.innerHTML = `${it.icon ? ico(it.icon) : '<span class="ico"></span>'}<span class="ctx-label">${it.label}</span>${it.keys ? `<kbd>${it.keys}</kbd>` : ''}`;
      b.addEventListener('click', () => {
        this.close();
        it.action();
      });
      el.append(b);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(el);
    this.el = el;
    this.restoreFocus = document.activeElement as HTMLElement | null;

    // Next to the cursor; flipped to the other side when it would leave the viewport.
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let x = clientX + 2;
    let y = clientY + 2;
    if (x + r.width > vw - MARGIN) x = Math.max(MARGIN, clientX - r.width - 2);
    if (y + r.height > vh - MARGIN) y = Math.max(MARGIN, Math.min(clientY - r.height - 2, vh - r.height - MARGIN));
    // Never past the left / right edge either (narrow phones, menus opened near a border).
    x = Math.max(MARGIN, Math.min(x, vw - r.width - MARGIN));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;

    // Listeners are added after this event finishes so the opening click does not close it.
    setTimeout(() => {
      if (this.el !== el) return;
      document.addEventListener('pointerdown', this.onDocPointer, true);
      document.addEventListener('contextmenu', this.onDocPointer, true);
      document.addEventListener('wheel', this.onClose, { capture: true, passive: true });
      window.addEventListener('resize', this.onClose);
      window.addEventListener('blur', this.onClose);
      document.addEventListener('keydown', this.onKey, true);
    });
    this.items()[0]?.focus({ preventScroll: true });
  }

  /** Called once when the open menu closes (e.g. to reset aria-expanded on its button). */
  onClosed: (() => void) | null = null;

  close(): void {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    const cb = this.onClosed;
    this.onClosed = null;
    cb?.();
    document.removeEventListener('pointerdown', this.onDocPointer, true);
    document.removeEventListener('contextmenu', this.onDocPointer, true);
    document.removeEventListener('wheel', this.onClose, { capture: true });
    window.removeEventListener('resize', this.onClose);
    window.removeEventListener('blur', this.onClose);
    document.removeEventListener('keydown', this.onKey, true);
    if (this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
    this.restoreFocus = null;
  }

  private items(): HTMLButtonElement[] {
    return this.el ? [...this.el.querySelectorAll<HTMLButtonElement>('.ctx-item:not(:disabled)')] : [];
  }

  private key(e: KeyboardEvent): void {
    // The menu owns the keyboard while open (no editor shortcuts underneath).
    e.stopPropagation();
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (items[i] ?? items[0])?.click();
    }
  }
}
