/**
 * The state of frame N of an animated layer. ONE function, used by the renderer for both the
 * live preview and the exports (they reach it through SourceRef.noise / SourceRef.loop), and
 * by the UI to show the frame's values on the knobs. Pure: same input → same output.
 */
import type { GlitchState } from './model';
import { frameSeed } from './media/timing';

/**
 * Effects of frame `frame` (0-based) of a loop of `loopFrames` frames. `frame` undefined or
 * `animate` false → the base state itself (what the user set, untouched).
 * `out` (optional) is reused as the result object so a running preview allocates nothing.
 */
export function stateAtFrame(base: GlitchState, frame: number | undefined, loopFrames: number, animate: boolean, out?: GlitchState): GlitchState {
  if (frame === undefined || !animate) return base;
  const o = out ?? ({} as GlitchState);
  o.v = base.v;
  o.effect = base.effect;
  o.filter = base.filter;
  o.cables = base.cables;
  o.stages = base.stages;
  // "Parpadeo": the noise changes every frame (deterministic: seed + frame index).
  o.seed = frameSeed(base.seed, loopFrames > 0 ? frame % loopFrames : frame, true);
  return o;
}
