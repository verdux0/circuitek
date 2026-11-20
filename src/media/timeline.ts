/**
 * The one transport the media bar drives: the effects clock (every layer's glitch animation)
 * plus every video / GIF player, together. ▶ / ⏸ / seek / step act on all of them, so adding a
 * GIF never takes the effects away from the bar; each source still loops over its own length.
 *
 * The bar's time and length are those of the primary source: the selected (or first) video /
 * GIF when there is one, else the effects loop.
 */
import type { AnimClock, Transport } from './animclock';
import type { MediaPlayer } from './player';

export class Timeline implements Transport {
  constructor(
    private anim: AnimClock,
    /** All open players, the primary one (selected layer's, else the first) first. */
    private media: () => MediaPlayer[],
  ) {}

  private get primary(): Transport {
    return this.media()[0] ?? this.anim;
  }
  get kind(): 'video' | 'gif' | 'anim' {
    return this.primary.kind;
  }
  get w(): number {
    return this.primary.w;
  }
  get h(): number {
    return this.primary.h;
  }
  get duration(): number {
    return this.primary.duration;
  }
  get time(): number {
    return this.primary.time;
  }
  get frame(): number {
    return this.primary.frame;
  }
  get fps(): number {
    return this.primary.fps;
  }
  get stamp(): number {
    return this.primary.stamp;
  }
  get playing(): boolean {
    return this.anim.playing || this.media().some((p) => p.playing);
  }
  get hasAudio(): boolean | null {
    const v = this.media().filter((p) => p.kind === 'video');
    if (!v.length) return false;
    return v.some((p) => p.hasAudio === true) ? true : v.some((p) => p.hasAudio === null) ? null : false;
  }
  /** Only media can stop at its end; the effects loop always wraps. */
  get loop(): boolean {
    const m = this.media();
    return m.length ? m.every((p) => p.loop) : true;
  }
  set loop(v: boolean) {
    for (const p of this.media()) p.loop = v;
  }
  get speed(): number {
    return this.anim.speed;
  }
  set speed(v: number) {
    this.anim.speed = v;
    for (const p of this.media()) p.speed = v;
  }
  get volume(): number {
    return this.media().find((p) => p.kind === 'video')?.volume ?? 0;
  }
  set volume(v: number) {
    for (const p of this.media()) if (p.kind === 'video') p.volume = v;
  }
  get muted(): boolean {
    const v = this.media().filter((p) => p.kind === 'video');
    return v.length ? v.every((p) => p.muted) : true;
  }
  set muted(m: boolean) {
    for (const p of this.media()) if (p.kind === 'video') p.muted = m;
  }

  async play(): Promise<void> {
    // The effects clock may refuse (reduced motion); media then stays paused too.
    await this.anim.play();
    if (!this.anim.playing) return;
    await Promise.all(this.media().map((p) => p.play()));
  }
  pause(): void {
    this.anim.pause();
    for (const p of this.media()) p.pause();
  }
  /** t on the primary source's timeline; the others wrap it into their own length. */
  seek(t: number): void {
    const wrap = (d: number) => (d > 0 ? ((t % d) + d) % d : t);
    this.anim.seek(wrap(this.anim.duration));
    for (const p of this.media()) p.seek(p.duration && t >= p.duration ? wrap(p.duration) : t);
  }
  step(n: number): void {
    this.anim.step(n);
    for (const p of this.media()) p.step(n);
  }
}
