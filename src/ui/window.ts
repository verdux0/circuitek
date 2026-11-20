/**
 * Floating window inside the page (Photopea-style dialog): title bar with the title on the
 * left and × on the right, body below. Modal: the page behind is dimmed and inert to clicks.
 * Esc or × closes; focus moves into the window and returns where it was on close.
 */
import { ico } from './icons';

export interface WindowHandle {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
}

let seq = 0;

export function openWindow(opts: { title: string; body: HTMLElement; className?: string; onClose?: () => void }): WindowHandle {
  const back = document.createElement('div');
  back.className = 'win-backdrop';
  const id = `win-title-${++seq}`;
  back.innerHTML = `
    <section class="win ${opts.className ?? ''}" role="dialog" aria-modal="true" aria-labelledby="${id}">
      <header class="win-title">
        <h2 id="${id}">${opts.title}</h2>
        <button type="button" class="win-close" aria-label="Cerrar" title="Cerrar (Esc)">${ico('close')}</button>
      </header>
    </section>`;
  const win = back.querySelector<HTMLElement>('.win')!;
  opts.body.classList.add('win-body');
  win.append(opts.body);
  const restore = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    opts.onClose?.();
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // The window owns the keyboard: editor shortcuts do not fire underneath.
    if (!win.contains(e.target as Node)) return;
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    // Keep Tab inside the window.
    const f = [...win.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  back.querySelector('.win-close')!.addEventListener('click', close);
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  (win.querySelector<HTMLElement>('input, select, button:not(.win-close)') ?? win.querySelector<HTMLElement>('.win-close'))?.focus();
  return { el: win, body: opts.body, close };
}
