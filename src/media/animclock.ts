/**
 * Clock of the effects animation (every layer, stills and media alike): drives the preview
 * frame by frame; the media bar drives it together with the videos / GIFs (media/timeline.ts).
 *
 * - Stopped by default (frame = undefined → the base state, exactly as without animation).
 * - requestAnimationFrame with a FIXED step (1000 / fps): elapsed time accumulates, every
 *   frame that is due is skipped over and only the latest one is painted (late frames are
 *   dropped, never queued). Paused while the page is hidden.
 * - The tick is a pre-bound method: nothing is allocated per frame.
 */
import { clampSpeed } from './timing';

/** What the transport bar needs (videos, GIFs and this clock). */
export interface Transport {
  readonly kind: 'video' | 'gif' | 'anim';
  readonly w: number;
  readonly h: number;
  readonly duration: number;
  readonly time: number;
  readonly frame: number;
  readonly fps: number;
  readonly stamp: number;
  readonly playing: boolean;
  readonly hasAudio: boolean | null;
  loop: boolean;
  speed: number;
  volume: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  step(n: number): void;
}

export const ANIM_FPS = 20;
export const ANIM_SECONDS = 3;

export class AnimClock implements Transport {
  readonly kind = 'anim' as const;
  readonly hasAudio = false;
  w = 0;
  h = 0;
  loop = true;
  volume = 0;
  muted = true;
  fps = ANIM_FPS;
  loopFrames = ANIM_FPS * ANIM_SECONDS;
  stamp = 0;
  /** Frames skipped because the page could not keep up (stats). */
  dropped = 0;
  /** Frames painted while playing (stats). */
  painted = 0;
  private cur: number | undefined = undefined;
  private isPlaying = false;
  private rate = 1;
  private raf = 0;
  private last = 0;
  private acc = 0;
  onFrame: () => void = () => {};
  onState: () => void = () => {};
  /** Asked before starting when the system prefers reduced motion; return false to stay still. */
  allowMotion: () => boolean = () => true;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (!this.isPlaying) return;
      if (document.hidden) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      } else this.schedule();
    });
  }

  /** Frame shown, or undefined when stopped (base state). */
  get current(): number | undefined {
    return this.cur;
  }
  get frame(): number {
    return this.cur ?? 0;
  }
  get playing(): boolean {
    return this.isPlaying;
  }
  get duration(): number {
    return this.loopFrames / this.fps;
  }
  get time(): number {
    return this.frame / this.fps;
  }
  get speed(): number {
    return this.rate;
  }
  set speed(v: number) {
    this.rate = clampSpeed(v);
    this.onState();
  }

  /** Loop length and rate (motion settings); keeps the current frame inside the loop. */
  configure(fps: number, loopFrames: number): void {
    if (fps === this.fps && loopFrames === this.loopFrames) return;
    this.fps = fps;
    this.loopFrames = Math.max(1, loopFrames);
    if (this.cur !== undefined) this.cur %= this.loopFrames;
    this.onState();
  }

  async play(): Promise<void> {
    if (this.isPlaying) return;
    if (!this.allowMotion()) return;
    this.isPlaying = true;
    if (this.cur === undefined) this.cur = 0;
    this.present();
    this.schedule();
    this.onState();
  }

  /** Pause on the current frame (still animated, just not advancing). */
  pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onState();
  }

  /** ■: stop and go back to the base state. */
  stop(): void {
    this.pause();
    if (this.cur === undefined) return;
    this.cur = undefined;
    this.present();
    this.onState();
  }

  seek(t: number): void {
    this.show(Math.round(t * this.fps));
  }
  step(n: number): void {
    this.pause();
    this.show(this.frame + n);
  }
  /** Shows frame i (paused unless playing). */
  show(i: number): void {
    const n = this.loopFrames;
    this.cur = ((Math.round(i) % n) + n) % n;
    this.present();
    this.onState();
  }

  private present(): void {
    this.stamp++;
    this.onFrame();
  }

  private schedule(): void {
    if (this.raf || document.hidden) return;
    this.last = 0;
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (!this.isPlaying) return;
    if (this.last) this.acc += (now - this.last) * this.rate;
    this.last = now;
    const step = 1000 / this.fps;
    if (this.acc >= step) {
      const due = Math.floor(this.acc / step);
      this.acc -= due * step;
      this.dropped += due - 1;
      this.painted++;
      this.cur = ((this.cur ?? 0) + due) % this.loopFrames;
      this.present();
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
