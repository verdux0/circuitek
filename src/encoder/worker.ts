/// <reference lib="webworker" />
import { processEnc } from './process';
import type { EncParams } from '../model';

export interface EncRequest {
  id: number;
  w: number;
  h: number;
  buf: ArrayBuffer;
  p: EncParams;
  seed: number;
}
export interface EncResponse {
  id: number;
  w: number;
  h: number;
  buf: ArrayBuffer;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<EncRequest | { ping: true }>) => {
  if ('ping' in e.data) {
    ctx.postMessage({ pong: true });
    return;
  }
  const { id, w, h, buf, p, seed } = e.data;
  const img = await processEnc(new ImageData(new Uint8ClampedArray(buf), w, h), p, seed);
  const out = img.data.buffer as ArrayBuffer;
  const res: EncResponse = { id, w, h, buf: out };
  ctx.postMessage(res, [out]);
};
