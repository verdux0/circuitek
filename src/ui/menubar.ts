/**
 * Application menu bar (Archivo, Editar, Imagen, Ver, Ventana…), described as data.
 *
 * - A click on a title opens its menu; another click closes it. While one is open, pointing
 *   at another title switches to it (as in desktop menu bars).
 * - Submenus (▸) open on hover, and on click / Enter / → for touch and keyboard.
 * - Items that do not apply right now are shown greyed out (with the reason as a tooltip),
 *   not removed. Checkable items show ✓.
 * - Keyboard: ← → between menus, ↑ ↓ Home End inside, Enter / Space choose, Esc closes.
 * Entries are built when the menu opens, so their state (disabled, ✓) is always current.
 */
export interface MenuItemDef {
  label: string;
  /** Shortcut on the right, in grey. */
  keys?: string;
  /** File extension on the right, in grey (Exportar como ▸). */
  ext?: string;
  action?: () => void;
  submenu?: () => MenuEntryDef[];
  /** true / a reason → greyed out (the reason becomes the tooltip). */
  disabled?: boolean | string | null;
  /** Defined → checkable item; true shows ✓. */
  checked?: boolean;
}
export type MenuEntryDef = MenuItemDef | 'sep';

export interface MenuDef {
  id: string;
  label: string;
  /** Items, rebuilt every time the menu opens. */
  items?: () => MenuEntryDef[];
  /** A title that acts directly instead of opening a menu (e.g. Atajos). */
  action?: () => void;
}

const MARGIN = 4;

export class MenuBar {
  private titles: HTMLButtonElement[] = [];
  private open: { index: number; el: HTMLElement; sub: HTMLElement | null } | null = null;
  private subTimer = 0;
  private restoreFocus: HTMLElement | null = null;

  private readonly onDocPointer = (e: Event) => {
    const t = e.target as Node;
    if (this.open && !this.open.el.contains(t) && !this.open.sub?.contains(t) && !this.root.contains(t)) this.close();
  };
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onClose = () => this.close();

  constructor(private root: HTMLElement, private menus: MenuDef[]) {
    root.setAttribute('role', 'menubar');
    root.setAttribute('aria-label', 'Menú principal');
    menus.forEach((m, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-title';
      b.dataset.menu = m.id;
      b.textContent = m.label;
      b.setAttribute('role', 'menuitem');
      if (m.items) b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.tabIndex = i === 0 ? 0 : -1;
      b.addEventListener('click', () => {
        if (m.action) {
          this.close();
          m.action();
        } else if (this.open?.index === i) this.close();
        else this.show(i, false);
      });
      b.addEventListener('pointerenter', (e) => {
        if (this.open && this.open.index !== i && (e as PointerEvent).pointerType === 'mouse' && m.items) this.show(i, false);
      });
      b.addEventListener('keydown', (e) => this.titleKey(e, i));
      root.append(b);
      this.titles.push(b);
    });
  }

  get isOpen(): boolean {
    return this.open !== null;
  }

  /** Opens menu `id` (tests, shortcuts). */
  openMenu(id: string): void {
    const i = this.menus.findIndex((m) => m.id === id);
    if (i >= 0) this.show(i, true);
  }

  close(): void {
    if (!this.open) return;
    clearTimeout(this.subTimer);
    this.open.sub?.remove();
    this.open.el.remove();
    this.titles[this.open.index].setAttribute('aria-expanded', 'false');
    this.titles[this.open.index].classList.remove('open');
    this.open = null;
    document.removeEventListener('pointerdown', this.onDocPointer, true);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onClose);
    window.removeEventListener('blur', this.onClose);
    if (this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
    this.restoreFocus = null;
  }

  private show(i: number, focusFirst: boolean): void {
    const m = this.menus[i];
    if (!m.items) return;
    const wasOpen = !!this.open;
    if (this.open) {
      // Switching menus: drop the old list only (listeners and focus target stay).
      clearTimeout(this.subTimer);
      this.open.sub?.remove();
      this.open.el.remove();
      this.titles[this.open.index].setAttribute('aria-expanded', 'false');
      this.titles[this.open.index].classList.remove('open');
      this.open = null;
    } else this.restoreFocus = document.activeElement as HTMLElement | null;
    const title = this.titles[i];
    const el = this.buildList(m.items(), m.label);
    document.body.append(el);
    const r = title.getBoundingClientRect();
    this.place(el, r.left, r.bottom);
    title.setAttribute('aria-expanded', 'true');
    title.classList.add('open');
    this.open = { index: i, el, sub: null };
    if (!wasOpen) {
      document.addEventListener('pointerdown', this.onDocPointer, true);
      document.addEventListener('keydown', this.onKey, true);
      window.addEventListener('resize', this.onClose);
      window.addEventListener('blur', this.onClose);
    }
    if (focusFirst) this.items(el)[0]?.focus({ preventScroll: true });
  }

  private buildList(entries: MenuEntryDef[], label: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'menu-drop';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', label);
    entries.forEach((it, k) => {
      if (it === 'sep') {
        if (k > 0 && k < entries.length - 1) el.insertAdjacentHTML('beforeend', '<div class="menu-sep" role="separator"></div>');
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item';
      b.tabIndex = -1;
      const checkable = it.checked !== undefined;
      b.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
      if (checkable) b.setAttribute('aria-checked', String(!!it.checked));
      const off = !!it.disabled;
      if (off) {
        b.setAttribute('aria-disabled', 'true');
        b.classList.add('disabled');
        if (typeof it.disabled === 'string') b.title = it.disabled;
      }
      if (it.submenu) b.setAttribute('aria-haspopup', 'menu');
      const right = it.submenu ? '<span class="menu-arrow" aria-hidden="true">▸</span>' : it.keys ? `<kbd>${it.keys}</kbd>` : it.ext ? `<span class="menu-ext">${it.ext}</span>` : '';
      b.innerHTML = `<span class="menu-check" aria-hidden="true">${it.checked ? '✓' : ''}</span><span class="menu-label">${it.label}</span>${right}`;
      if (it.submenu) {
        const openSub = () => {
          if (!off) this.showSub(b, it.submenu!(), it.label);
        };
        b.addEventListener('pointerenter', (e) => {
          clearTimeout(this.subTimer);
          if ((e as PointerEvent).pointerType === 'mouse') this.subTimer = window.setTimeout(openSub, 120);
        });
        b.addEventListener('click', () => {
          openSub();
          if (this.open?.sub) this.items(this.open.sub)[0]?.focus({ preventScroll: true });
        });
      } else {
        b.addEventListener('pointerenter', () => {
          clearTimeout(this.subTimer);
          // Leaving a submenu parent closes its submenu (only for items of the main list).
          if (this.open && b.parentElement === this.open.el) this.subTimer = window.setTimeout(() => this.hideSub(), 120);
        });
        b.addEventListener('click', () => {
          if (off) return;
          this.close();
          it.action?.();
        });
      }
      el.append(b);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }

  private showSub(parent: HTMLElement, entries: MenuEntryDef[], label: string): void {
    if (!this.open) return;
    this.hideSub();
    const sub = this.buildList(entries, label);
    sub.classList.add('menu-sub');
    document.body.append(sub);
    const r = parent.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const w = sub.getBoundingClientRect().width;
    // To the right of the parent; to the left when it would not fit; overlapping on phones.
    const x = r.right + w <= vw - MARGIN ? r.right : r.left - w >= MARGIN ? r.left - w : Math.max(MARGIN, vw - w - MARGIN);
    this.place(sub, x, r.top - MARGIN);
    parent.setAttribute('aria-expanded', 'true');
    this.open.sub = sub;
  }

  private hideSub(): void {
    if (!this.open?.sub) return;
    this.open.sub.remove();
    this.open.sub = null;
    this.open.el.querySelector('[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
  }

  private place(el: HTMLElement, x: number, y: number): void {
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    el.style.left = `${Math.round(Math.max(MARGIN, Math.min(x, vw - r.width - MARGIN)))}px`;
    el.style.top = `${Math.round(Math.max(MARGIN, Math.min(y, vh - r.height - MARGIN)))}px`;
  }

  private items(list: HTMLElement): HTMLButtonElement[] {
    return [...list.querySelectorAll<HTMLButtonElement>('.menu-item:not(.disabled)')];
  }

  private titleKey(e: KeyboardEvent, i: number): void {
    const n = this.titles.length;
    const move = (j: number) => {
      e.preventDefault();
      const k = (j + n) % n;
      this.titles.forEach((t, x) => (t.tabIndex = x === k ? 0 : -1));
      this.titles[k].focus();
      if (this.open) this.show(k, false);
    };
    if (e.key === 'ArrowRight') move(i + 1);
    else if (e.key === 'ArrowLeft') move(i - 1);
    else if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && this.menus[i].items) {
      e.preventDefault();
      this.show(i, true);
    }
  }

  /** Keyboard while a menu is open (it owns the keyboard: no editor shortcuts underneath). */
  private key(e: KeyboardEvent): void {
    if (!this.open) return;
    const inTitle = this.titles.includes(document.activeElement as HTMLButtonElement);
    if (inTitle && e.key !== 'Escape') return;
    e.stopPropagation();
    const list = this.open.sub?.contains(document.activeElement) ? this.open.sub : this.open.el;
    const items = this.items(list);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (k: number) => {
      e.preventDefault();
      items[(k + items.length) % items.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      if (list === this.open.sub) {
        const parent = this.open.el.querySelector<HTMLElement>('[aria-expanded="true"]');
        this.hideSub();
        parent?.focus();
      } else this.close();
    } else if (e.key === 'Tab') this.close();
    else if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = items[at];
      if (cur?.getAttribute('aria-haspopup')) cur.click();
      else this.show((this.open.index + 1) % this.titles.length, true);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (list === this.open.sub) {
        const parent = this.open.el.querySelector<HTMLElement>('[aria-expanded="true"]');
        this.hideSub();
        parent?.focus();
      } else this.show((this.open.index - 1 + this.titles.length) % this.titles.length, true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (items[at] ?? items[0])?.click();
    }
  }
}
