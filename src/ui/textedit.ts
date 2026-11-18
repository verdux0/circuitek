/**
 * In-place text editing: a native <textarea> laid exactly over the text layer
 * (same font, size, line height, rotation and scale), as Konva recommends — canvas
 * text cannot be edited directly. Every keystroke updates the layer live, so the
 * glitch under it follows what you type.
 *
 * Esc, Ctrl+Enter or clicking outside closes it. Enter = new line.
 */
import { cssFont, textPadding } from '../text';
import { getLayer, type DocState } from '../doc';
import type { Viewport } from './viewport';

export interface TextEditHost {
  doc(): DocState;
  live(id: string, content: string): void;
  end(id: string): void;
}

export class TextEditor {
  private ta: HTMLTextAreaElement | null = null;
  private id: string | null = null;

  constructor(
    private container: HTMLElement,
    private viewport: Viewport,
    private host: TextEditHost,
  ) {}

  get isOpen(): boolean {
    return this.ta !== null;
  }
  get editingId(): string | null {
    return this.id;
  }

  open(id: string, selectAll = false): void {
    const l = getLayer(this.host.doc(), id);
    if (!l?.text) return;
    if (this.ta) this.close();
    this.id = id;
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Editar texto de la capa');
    ta.value = l.text.content;
    ta.addEventListener('input', () => {
      if (this.id) this.host.live(this.id, ta.value);
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this.close();
      }
    });
    ta.addEventListener('blur', () => this.close());
    // Wheel over the editor still zooms the view.
    ta.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.container.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    this.container.append(ta);
    this.ta = ta;
    this.position();
    ta.focus();
    if (selectAll) ta.select();
    else ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  close(): void {
    const ta = this.ta;
    const id = this.id;
    if (!ta || !id) return;
    this.ta = null;
    this.id = null;
    ta.remove();
    this.host.end(id);
  }

  /** Follows the layer and the camera. Call after any change. */
  position(): void {
    const ta = this.ta;
    if (!ta || !this.id) return;
    const l = getLayer(this.host.doc(), this.id);
    if (!l?.text) {
      // Layer gone (undo / delete): drop the editor without committing.
      ta.remove();
      this.ta = null;
      this.id = null;
      return;
    }
    const t = l.text;
    const z = this.viewport.zoom;
    const st = this.viewport.stage;
    const cx = st.x() + l.x * z;
    const cy = st.y() + l.y * z;
    const pad = textPadding(t);
    Object.assign(ta.style, {
      left: `${cx - l.w / 2}px`,
      top: `${cy - l.h / 2}px`,
      width: `${l.w}px`,
      height: `${l.h}px`,
      padding: `${pad}px`,
      font: cssFont(t),
      lineHeight: `${t.size * t.lineHeight}px`,
      textAlign: t.align,
      color: t.color,
      transform: `rotate(${l.rotation}deg) scale(${l.scaleX * z}, ${l.scaleY * z})`,
      outlineWidth: `${2 / Math.max(0.01, l.scaleX * z)}px`,
    });
  }
}
