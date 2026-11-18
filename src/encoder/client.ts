import EncoderWorker from './worker?worker&inline';
import type { EncRequest, EncResponse } from './worker';
import { processEnc } from './process';
import type { EncParams } from '../model';

/**
 * Runs the encoder stage in a Web Worker. If the worker cannot start (e.g. some browsers
 * block workers on file:// pages) it falls back to running on the main thread, so the
 * app never hangs.
 */
export class EncoderClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: ImageData) => void; img: ImageData; p: EncParams; seed: number }>();
  private ready = false;

  constructor() {
    try {
      this.worker = new EncoderWorker();
      this.worker.onmessage = (e: MessageEvent<EncResponse | { pong: true }>) => {
        this.ready = true;
        if ('pong' in e.data) return;
        const { id, w, h, buf } = e.data;
        const job = this.pending.get(id);
        this.pending.delete(id);
        job?.resolve(new ImageData(new Uint8ClampedArray(buf), w, h));
      };
      this.worker.onerror = () => this.fallback();
      this.worker.postMessage({ ping: true });
      // a worker that never answers the ping (blocked silently) also triggers the fallback
      setTimeout(() => {
        if (!this.ready) this.fallback();
      }, 3000);
    } catch {
      this.worker = null;
    }
  }

  /** Switch to main-thread processing and re-run anything in flight. */
  private fallback(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const j of jobs) void processEnc(j.img, j.p, j.seed).then(j.resolve);
  }

  run(img: ImageData, p: EncParams, seed: number): Promise<ImageData> {
    const copy = new ImageData(img.data.slice(), img.width, img.height);
    if (!this.worker) return processEnc(copy, p, seed);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, img: new ImageData(copy.data.slice(), copy.width, copy.height), p, seed });
      const buf = copy.data.buffer as ArrayBuffer;
      const req: EncRequest = { id, w: img.width, h: img.height, buf, p, seed };
      this.worker!.postMessage(req, [buf]);
    });
  }
}
