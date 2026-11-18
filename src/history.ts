/** Undo/redo stack of serialized snapshots. */
export class History<T = unknown> {
  private past: string[] = [];
  private future: string[] = [];
  constructor(private limit = 200) {}

  push(prev: T): void {
    const j = JSON.stringify(prev);
    if (this.past[this.past.length - 1] === j) return;
    this.past.push(j);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(prev) as T;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(next) as T;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
