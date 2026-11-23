/**
 * Interactive viewport built on Konva: zoom / pan of the document and direct manipulation
 * (move, scale, rotate) of layers with a Transformer.
 *
 * What you see inside the canvas is the glitched composite (the engine's preview canvas,
 * drawn as one Konva.Image). Every layer also has a "proxy" node under it: it carries the
 * hit area and the Transformer, and shows the parts of the layer that stick out of the
 * canvas as a faint ghost.
 *
 * Navigation:
 *   wheel = zoom at the pointer · Ctrl+wheel = scroll ↕ · Alt/Shift+wheel = scroll ↔
 *   Ctrl / Alt / middle button + drag = pan (hand) · two fingers = pinch-zoom + pan
 */
import Konva from 'konva';
import { fromLinear, type BitmapSource, type DocState, type Layer } from '../doc';

export interface ViewportHost {
  doc(): DocState;
  bitmaps: Map<string, BitmapSource>;
  /** Canvas holding the glitched preview of the whole document. */
  result: HTMLCanvasElement;
  resultSize(): [number, number];
  select(id: string | null): void;
  /** Live change of one layer while dragging / transforming. */
  layerLive(id: string, patch: Partial<Layer>): void;
  /** Drag / transform finished: commit to history. */
  layerEnd(): void;
  viewChanged(): void;
  /** Double click / double tap on a layer (opens the text editor on text layers). */
  open(id: string): void;
  /** Right click (or long press) on the viewer: `id` = layer under the pointer, if any. */
  contextMenu(id: string | null, clientX: number, clientY: number): void;
}

const ZOOM_MIN = 0.02;
const ZOOM_MAX = 64;
const GHOST_OPACITY = 0.28;
const ACCENT = '#ff4a1c';

export class Viewport {
  readonly stage: Konva.Stage;
  private proxyLayer = new Konva.Layer();
  private viewLayer = new Konva.Layer({ listening: false });
  private uiLayer = new Konva.Layer();
  private resultNode: Konva.Image;
  /** Checkerboard under the result when the background is transparent (not part of the image). */
  private checker: Konva.Rect;
  private border: Konva.Rect;
  private tr: Konva.Transformer;
  private proxies = new Map<string, Konva.Image>();
  /** Id of the node being dragged / transformed (not overwritten by sync). */
  private busyId: string | null = null;
  /** True while the view follows "fit to screen" (re-fits on resize). */
  private fitted = true;
  private panning: { id: number; x: number; y: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; cx: number; cy: number } | null = null;

  constructor(
    private container: HTMLElement,
    private host: ViewportHost,
  ) {
    container.style.touchAction = 'none';
    this.stage = new Konva.Stage({ container: container as HTMLDivElement, width: container.clientWidth || 600, height: container.clientHeight || 400 });
    this.resultNode = new Konva.Image({ image: host.result, x: 0, y: 0, width: 1, height: 1, listening: false });
    this.border = new Konva.Rect({ x: 0, y: 0, width: 1, height: 1, stroke: '#ffffff55', strokeWidth: 1, strokeScaleEnabled: false, listening: false });
    const tile = document.createElement('canvas');
    tile.width = tile.height = 16;
    const g = tile.getContext('2d')!;
    g.fillStyle = '#9a9a9a';
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#6a6a6a';
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    this.checker = new Konva.Rect({ x: 0, y: 0, width: 1, height: 1, fillPatternImage: tile as unknown as HTMLImageElement, fillPatternRepeat: 'repeat', listening: false, visible: false });
    this.viewLayer.add(this.checker, this.resultNode, this.border);
    this.tr = new Konva.Transformer({
      rotateEnabled: true,
      flipEnabled: false,
      keepRatio: true,
      // Shift on a corner = free aspect ratio; Shift while rotating = 15° steps.
      shiftBehavior: 'inverted',
      rotationSnaps: [0, 90, 180, 270],
      rotationSnapTolerance: 4,
      rotateAnchorOffset: 26,
      anchorSize: 11,
      anchorCornerRadius: 2,
      anchorStroke: ACCENT,
      anchorFill: '#fff',
      borderStroke: ACCENT,
      borderStrokeWidth: 1.5,
      ignoreStroke: true,
      boundBoxFunc: (oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox),
    });
    this.uiLayer.add(this.tr);
    this.stage.add(this.proxyLayer, this.viewLayer, this.uiLayer);

    // Click on empty space → deselect.
    this.stage.on('pointerdown', (e) => {
      if (e.target === this.stage) host.select(null);
    });
    this.tr.on('transformstart', () => {
      this.busyId = this.tr.nodes()[0]?.id() ?? null;
    });
    this.tr.on('transform', () => this.readTransform(false));
    this.tr.on('transformend', () => this.readTransform(true));

    container.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // Capture phase: decide pan / pinch before Konva sees the event.
    container.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
    container.addEventListener('touchstart', (e) => this.blockWhileGesture(e), { capture: true, passive: false });
    container.addEventListener('touchmove', (e) => this.blockWhileGesture(e), { capture: true, passive: false });
    window.addEventListener('pointermove', (e) => this.onPointerMove(e), true);
    window.addEventListener('pointerup', (e) => this.onPointerUp(e), true);
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e), true);
    container.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
    // Our own menu replaces the browser's on the whole viewer.
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.panning || this.pinch) return;
      const id = this.layerAt(e);
      if (id) host.select(id);
      host.contextMenu(id, e.clientX, e.clientY);
    });
    window.addEventListener('keydown', (e) => this.updateCursor(e));
    window.addEventListener('keyup', (e) => this.updateCursor(e));
    window.addEventListener('blur', () => container.classList.remove('pan-ready'));
    // Dragging a panel separator resizes the viewer on every pointer move: once per frame is enough.
    let rq = 0;
    new ResizeObserver(() => {
      if (!rq) rq = requestAnimationFrame(() => {
        rq = 0;
        this.resize();
      });
    }).observe(container);
  }

  /* ------------------------------ camera ------------------------------ */

  get zoom(): number {
    return this.stage.scaleX();
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.stage.size({ width: w, height: h });
    if (this.fitted) this.fit();
    else this.present();
  }

  fit(): void {
    const d = this.host.doc();
    const pad = 24;
    const k = Math.min((this.stage.width() - pad * 2) / d.w, (this.stage.height() - pad * 2) / d.h);
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k));
    this.stage.scale({ x: z, y: z });
    this.stage.position({ x: (this.stage.width() - d.w * z) / 2, y: (this.stage.height() - d.h * z) / 2 });
    this.fitted = true;
    this.changed();
  }

  /** Zoom to `z` (1 = 100 %, one document pixel per CSS pixel) keeping point p fixed. */
  zoomTo(z: number, p = { x: this.stage.width() / 2, y: this.stage.height() / 2 }): void {
    const old = this.zoom;
    const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    const pos = this.stage.position();
    const wx = (p.x - pos.x) / old;
    const wy = (p.y - pos.y) / old;
    this.stage.scale({ x: nz, y: nz });
    this.stage.position({ x: p.x - wx * nz, y: p.y - wy * nz });
    this.fitted = false;
    this.changed();
  }

  zoomBy(factor: number, p?: { x: number; y: number }): void {
    this.zoomTo(this.zoom * factor, p);
  }

  panBy(dx: number, dy: number): void {
    const pos = this.stage.position();
    this.stage.position({ x: pos.x + dx, y: pos.y + dy });
    this.fitted = false;
    this.changed();
  }

  private changed(): void {
    // Squares keep 8 screen px at any zoom.
    const z = this.stage.scaleX() || 1;
    this.checker.fillPatternScale({ x: 1 / z, y: 1 / z });
    this.present();
    this.host.viewChanged();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.container.getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    // Trackpad pinch arrives as ctrl+wheel with fractional deltas: treat it as zoom.
    const pinch = e.ctrlKey && !Number.isInteger(e.deltaY);
    if (pinch) return this.zoomBy(Math.exp(-dy * 0.01), p);
    if (e.ctrlKey || e.metaKey) return this.panBy(-dx, -dy);
    if (e.altKey || e.shiftKey) return this.panBy(-(dx || dy), 0);
    // Two-finger trackpad scroll (has a horizontal component) pans; the wheel zooms.
    if (dx !== 0 && Math.abs(dx) > Math.abs(dy) * 0.3) return this.panBy(-dx, -dy);
    this.zoomBy(Math.exp(-Math.max(-100, Math.min(100, dy)) * 0.0022), p);
  }

  /* ------------------------------ pan & pinch ------------------------------ */

  private localPoint(e: PointerEvent | Touch): { x: number; y: number } {
    const r = this.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onTransformerAnchor(e: PointerEvent): boolean {
    this.stage.setPointersPositions(e);
    const pos = this.stage.getPointerPosition();
    const shape = pos ? this.stage.getIntersection(pos) : null;
    return !!shape && shape.getParent() === this.tr;
  }

  /** Id of the topmost unlocked, visible layer under a screen point (or of the transformer's node). */
  private layerAt(e: MouseEvent): string | null {
    this.stage.setPointersPositions(e);
    const pos = this.stage.getPointerPosition();
    const shape = pos ? this.stage.getIntersection(pos) : null;
    if (!shape) return null;
    if (shape.getParent() === this.tr) return this.tr.nodes()[0]?.id() ?? null;
    return this.proxies.has(shape.id()) ? shape.id() : null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, this.localPoint(e));
      if (this.touches.size === 2) {
        this.stopInteractions();
        this.pinch = this.pinchState();
        e.stopPropagation();
      }
      return;
    }
    const wantsPan = e.button === 1 || ((e.ctrlKey || e.altKey || e.metaKey) && e.button === 0 && !this.onTransformerAnchor(e));
    if (!wantsPan) return;
    e.preventDefault();
    e.stopPropagation();
    this.panning = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.container.classList.add('panning');
  }

  private pinchState(): { dist: number; cx: number; cy: number } {
    const [a, b] = [...this.touches.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.panning && e.pointerId === this.panning.id) {
      this.panBy(e.clientX - this.panning.x, e.clientY - this.panning.y);
      this.panning.x = e.clientX;
      this.panning.y = e.clientY;
      e.stopPropagation();
      return;
    }
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.localPoint(e));
      if (this.pinch && this.touches.size >= 2) {
        e.stopPropagation();
        const next = this.pinchState();
        this.panBy(next.cx - this.pinch.cx, next.cy - this.pinch.cy);
        if (this.pinch.dist > 0) this.zoomBy(next.dist / this.pinch.dist, { x: next.cx, y: next.cy });
        this.pinch = next;
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.panning && e.pointerId === this.panning.id) {
      this.panning = null;
      this.container.classList.remove('panning');
      e.stopPropagation();
    }
    if (this.touches.delete(e.pointerId) && this.pinch) {
      e.stopPropagation();
      if (this.touches.size === 0) this.pinch = null;
      else if (this.touches.size === 1) this.pinch = { dist: 0, cx: 0, cy: 0 };
      if (this.touches.size === 0) return;
    }
  }

  /** While pinching, Konva must not see touch events (it would drag the layer under a finger). */
  private blockWhileGesture(e: TouchEvent): void {
    if (e.touches.length >= 2 || this.pinch) {
      e.stopPropagation();
      e.preventDefault();
      if (e.type === 'touchstart' && e.touches.length >= 2) this.stopInteractions();
    }
  }

  private stopInteractions(): void {
    for (const n of this.proxies.values()) if (n.isDragging()) n.stopDrag();
    if (this.tr.isTransforming()) this.tr.stopTransform();
  }

  private updateCursor(e: KeyboardEvent): void {
    this.container.classList.toggle('pan-ready', e.ctrlKey || e.altKey || e.metaKey);
  }

  /* ------------------------------ layers ------------------------------ */

  /** Reconciles the Konva nodes with the document. */
  sync(): void {
    const d = this.host.doc();
    // Canvas resized / rotated: keep it framed if the user had not zoomed by hand.
    const sizeChanged = d.w !== this.resultNode.width() || d.h !== this.resultNode.height();
    if (sizeChanged && this.fitted && d.layers.length) queueMicrotask(() => this.fit());
    this.resultNode.size({ width: d.w, height: d.h });
    this.border.size({ width: d.w, height: d.h });
    this.checker.size({ width: d.w, height: d.h });
    this.checker.visible(!!d.transparent);
    const seen = new Set<string>();
    d.layers.forEach((l, i) => {
      seen.add(l.id);
      let n = this.proxies.get(l.id);
      const bm = this.host.bitmaps.get(l.src);
      if (!n) {
        n = new Konva.Image({ id: l.id, image: bm?.proxy as CanvasImageSource, opacity: GHOST_OPACITY });
        this.attach(n);
        this.proxies.set(l.id, n);
        this.proxyLayer.add(n);
      }
      n.zIndex(i);
      if (l.id === this.busyId) return;
      n.setAttrs({
        image: bm?.proxy,
        width: l.w,
        height: l.h,
        offsetX: l.w / 2,
        offsetY: l.h / 2,
        x: l.x,
        y: l.y,
        rotation: l.rotation,
        scaleX: l.scaleX * (l.flipX ? -1 : 1),
        scaleY: l.scaleY * (l.flipY ? -1 : 1),
        skewX: 0,
        skewY: 0,
        visible: l.visible,
        listening: !l.locked,
        draggable: !l.locked,
      });
    });
    for (const [id, n] of this.proxies) {
      if (!seen.has(id)) {
        n.destroy();
        this.proxies.delete(id);
      }
    }
    const active = d.layers.find((l) => l.id === d.active);
    const node = active && active.visible && !active.locked ? this.proxies.get(active.id) : undefined;
    const cur = this.tr.nodes()[0];
    if (node !== cur) this.tr.nodes(node ? [node] : []);
    else this.tr.forceUpdate();
    this.present();
  }

  private attach(n: Konva.Image): void {
    n.on('pointerdown', () => this.host.select(n.id()));
    n.on('dblclick dbltap', () => this.host.open(n.id()));
    n.on('dragstart', () => {
      this.busyId = n.id();
      this.host.select(n.id());
    });
    n.on('dragmove', () => this.host.layerLive(n.id(), { x: n.x(), y: n.y() }));
    n.on('dragend', () => {
      this.host.layerLive(n.id(), { x: n.x(), y: n.y() });
      this.busyId = null;
      this.host.layerEnd();
    });
    n.on('mouseenter', () => !n.isDragging() && (this.container.style.cursor = 'move'));
    n.on('mouseleave', () => (this.container.style.cursor = ''));
  }

  private readTransform(end: boolean): void {
    const n = this.tr.nodes()[0] as Konva.Image | undefined;
    if (!n) return;
    const l = this.host.doc().layers.find((x) => x.id === n.id());
    if (!l) return;
    const m = n.getTransform().getMatrix();
    const r = fromLinear(m[0], m[1], m[2], m[3], l.flipX, l.flipY);
    this.host.layerLive(l.id, { x: n.x(), y: n.y(), ...r });
    if (end) {
      this.busyId = null;
      this.host.layerEnd();
    }
  }

  /** Re-draws the stage (call after new pixels land in the result canvas). */
  present(): void {
    const [rw] = this.host.resultSize();
    const d = this.host.doc();
    // Screen pixels per preview pixel: show crisp pixels when zoomed into the glitch.
    const k = rw ? (this.zoom * d.w) / rw : 1;
    this.viewLayer.imageSmoothingEnabled(k < 2);
    this.stage.batchDraw();
  }

  /** The world-space size on screen of one document pixel (for adaptive preview resolution). */
  get docPixelsOnScreen(): number {
    const d = this.host.doc();
    return d.w * this.zoom * (window.devicePixelRatio || 1);
  }
}
