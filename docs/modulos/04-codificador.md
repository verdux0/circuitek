# 04 · Codificador (etapa JPEG / pixel sort)

## 1. Propósito y responsabilidad

La última etapa de la cadena de señal: **databending real** (se codifica en JPEG, se corrompen
bytes del flujo comprimido y se decodifica) y **pixel sort**. Trabaja en CPU, en un Web Worker, para
no bloquear la interfaz. Si el worker no arranca, usa el hilo principal.

## 2. Archivos y componentes clave

| Archivo | Contenido |
|---|---|
| `src/encoder/bytes.ts` | Puro: `findScanStart`, `corruptJpegBytes` (nunca escribe `0xFF` ni toca un byte tras `0xFF`, así los marcadores siguen intactos), `corruptionCount`, `STRIPS = 10`, `pixelSort` |
| `src/encoder/process.ts` | `jpegGlitch` (por franjas, como los *restart intervals* de una cámara; hasta 3 intentos si el JPEG corrupto no decodifica) y `processEnc` |
| `src/encoder/worker.ts` | El worker: responde `ping` y procesa `EncRequest` → `EncResponse` (buffers transferidos) |
| `src/encoder/client.ts` | `EncoderClient.run(img, p, seed)`: id por petición, mapa de pendientes, respaldo en el hilo principal si el worker falla o no responde al ping en 3 s |

## 3. Flujo de funcionamiento

1. `GLRenderer` (o `Engine`, para el estado global) lee los píxeles y llama a `EncoderClient.run`.
2. El cliente copia los píxeles (uno para enviar, otro por si hay que repetir en el respaldo) y los transfiere al worker.
3. El worker ejecuta `processEnc`: `jpegGlitch` si `jpg > 0` y después `pixelSort` si `sort > 0`.
4. El cliente resuelve la promesa con el `ImageData` resultante.
5. Si el worker da `error` o no contesta al ping, `fallback()` lo termina y vuelve a ejecutar en el hilo principal lo que estaba pendiente.

## 4. Dependencias

- **Salientes:** `bytes.ts` → `prng.ts` (tipos); `process.ts` → `bytes.ts`, `prng.ts`; `client.ts` → `worker.ts` (Vite `?worker&inline`), `process.ts`, `model.ts` (`EncParams`).
- **Entrantes:** `engine.ts` (crea el `EncoderClient` y lo pasa al renderer como `LayerEncoder`), `tests/core.test.ts` (`bytes.ts`).

## 5. Contratos públicos

- `EncRequest { id, w, h, buf, p: EncParams, seed }` / `EncResponse { id, w, h, buf }` (`src/encoder/worker.ts:5-18`). Mensajes de control: `{ ping: true }` → `{ pong: true }`.
- `EncoderClient.run(img, p, seed): Promise<ImageData>`: no modifica `img`.

## 6. Reglas de negocio e invariantes

- Determinista: el azar sale de `mulberry32(encSeed(state))`.
- Franjas y cantidad de bytes corruptos son **relativos a la imagen**, así que la vista previa, las miniaturas y el export coinciden (`src/encoder/process.ts:6-11`).
- Nunca se tocan las cabeceras ni el marcador EOI.

## 7. Configuración

Ninguna. Plazo del ping: 3 s (`src/encoder/client.ts:31-33`).

## 8. Pruebas existentes y huecos

- `tests/core.test.ts`: `findScanStart`, `corruptJpegBytes` (marcadores intactos, determinismo), `pixelSort`.
- Huecos: `process.ts`, `client.ts` y `worker.ts` no tienen tests (necesitan `OffscreenCanvas` / `Worker`). Los cubre la prueba de humo («encoder stage finishes»).

## 9. Observaciones técnicas

- H-003: los errores no se propagan. El worker no captura (`src/encoder/worker.ts:22-32`), el respaldo no rechaza (`src/encoder/client.ts:46`) y, si `processEnc` lanza en el worker, la promesa no termina nunca.
