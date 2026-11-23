# 03 · Render en GPU

## 1. Propósito y responsabilidad

Componer el documento por capas en **WebGL2**: subir cada capa como textura, aplicarle sus propias
pasadas glitch, guardar el resultado en una caché por capa, fusionarla con su modo de fusión sobre
un acumulador y presentar el resultado. `Engine` orquesta los tres usos: vista previa en vivo,
miniaturas y export a resolución completa.

## 2. Archivos y componentes clave

| Archivo | Contenido |
|---|---|
| `src/engine.ts` | `Engine`: tamaño adaptativo de la vista previa (`PREVIEW_MAX = 1280`, hasta `PREVIEW_MAX_ZOOMED = 4096` al ampliar), `renderPreview`, `renderThumb` (≤ 320 px), `exportFull`, `exportRenderer`, `renderWith`; cola «solo la última» del codificador global |
| `src/gl/renderer.ts` | `GLRenderer`: programas, objetivos de render (2 acumuladores, `tmp` y 2 de ping-pong por tamaño, máx. 3 tamaños), texturas de fuente (estáticas con mipmaps y dinámicas para vídeo / GIF), caché LRU por capa (`CACHE_BUDGET = 256 MB`), `render` (vivo) y `renderFinal` (espera a los codificadores; modo *stream*) |
| `src/gl/shaders.ts` | `VERT`/`FRAG` (shader «uber»: pasada 0 = 15 modos de CCD, 1 = bus, 2 = buffer, 3 = procesador, 9 = copia), `LAYER_VERT/FRAG` (colocar una capa), `COMP_FRAG` (16 modos de fusión) |

## 3. Flujo de funcionamiento

1. `main.ts` llama a `engine.renderPreview(doc, null, ctx, showOriginal)` una vez por animation frame (`src/main.ts:247-264`).
2. `GLRenderer.render(job)` (`src/gl/renderer.ts:532-547`):
   1. `beginAccum`: limpia el acumulador con el color de fondo, o transparente.
   2. Por cada capa visible, pide al `SourceProvider` (`main.ts`) un `SourceRef` (clave + `load()` + tamaño; para medios, `frame` / `stamp`; para la animación, `noise` / `loop`).
   3. Capa **sin efectos** → `drawLayer` (fusión por hardware si es «Normal», o por shader).
   4. Capa **con efectos** → `layerCache`: si cambió su clave (fuente, transformación, `fx`, fotograma…), `placeAndRun` la coloca en `tmp` y ejecuta sus pasadas (`buildGpuPasses(stateAtFrame(fx))`) hacia la textura de la caché. Si hay etapa de codificador, lee los píxeles y llama al codificador asíncrono, que al terminar sube el resultado y dispara `onAsync` → otro render.
   5. `finishGlobal`: pasadas globales (en la app, ninguna) hacia el canvas.
   6. `sweep`: libera cachés de capas borradas, aplica el presupuesto LRU y suelta texturas de fuente sin uso.
3. `Engine.renderPreview` copia el canvas de WebGL al `<canvas id="screen">` y avisa con `onPresent` (Konva repinta).
4. Export: `exportFull` crea **otro** `GLRenderer` (otro contexto), renderiza con `renderFinal(job, stream = true)` y codifica con `OffscreenCanvas.convertToBlob`. Al terminar, `dispose()` pierde el contexto a propósito.

## 4. Dependencias

- **Salientes:** `renderer.ts` → `shaders.ts`, `model.ts` (`buildGpuPasses`, `encParams`, `encSeed`), `doc.ts` (`layerMatrix`, `BLENDS`), `motion.ts` (`stateAtFrame`); `engine.ts` → `renderer.ts`, `encoder/client.ts`, `model.ts`.
- **Entrantes:** `main.ts` (vista previa, miniaturas, `layerHasFx` en `ui/layers.ts`), `export/exporter.ts` (`exportRenderer`, `renderWith`, `exportFull`).

## 5. Contratos públicos

- `SourceProvider.source(layer, pxScale) → SourceRef | null` (`src/gl/renderer.ts:60-87`): la app decide qué píxeles dar a cada resolución (proxy ≤ 1600 px o completo; texto rasterizado a escalas de potencia de dos).
- `LayerEncoder(img, params, seed) → Promise<ImageData>`: la etapa del codificador inyectada (doc 04).
- `RenderJob { doc, global, layerFx, w, h }`.
- `GLRenderer.memory`, `encStats`: estadísticas para las herramientas de verificación.

## 6. Reglas de negocio e invariantes

- El acumulador y el canvas usan **alfa premultiplicado**; `readFb` lo deshace al leer el canvas (`src/gl/renderer.ts:391-405`).
- Las texturas estáticas se suben volteadas en un canvas 2D (orientación GL); las dinámicas, con `UNPACK_FLIP_Y_WEBGL`.
- **Solo la última petición** del codificador cuenta: los resultados que una petición más nueva ha dejado obsoletos se descartan (`src/engine.ts:88-92`, `src/gl/renderer.ts:479-484`).
- Mientras un medio se reproduce (`liveOnly`), la etapa del codificador se salta; en la animación de imágenes fijas se muestra el último fotograma codificado (textura `side`).
- Las cachés de un render final en curso (`finals > 0`) no se barren desde un render en vivo.
- El codificador JPEG no conserva el alfa: se restaura el de la GPU (`src/gl/renderer.ts:485-486`).

## 7. Configuración

Sin variables de entorno. Constantes: `PREVIEW_MAX`, `PREVIEW_MAX_ZOOMED`, `THUMB_MAX`, `MAX_MEGAPIXELS`, `CACHE_BUDGET`; tamaño máximo de textura = `MAX_TEXTURE_SIZE` del dispositivo, como mucho 16 384.

## 8. Pruebas existentes y huecos

- No hay tests unitarios (necesita WebGL2). La lógica pura que usa (`buildGpuPasses`, `stateAtFrame`, `layerMatrix`) sí tiene tests.
- Se verificaba con `tools/verify.py` (hojas de contacto de los 15 modos), hoy rota (H-032). La prueba de humo `tools/smoke_audit.py` comprueba que la vista previa y el pipeline completo dan píxeles.

## 9. Observaciones técnicas

- H-003: si el codificador falla, `e.encBusy` (`src/gl/renderer.ts:474-478`) y `Engine.encBusy` (`src/engine.ts:85-98`) se quedan en `true` para siempre.
- H-004: no se gestiona `webglcontextlost`.
- H-018: `cacheKey` serializa `l.fx` en cada render (`src/gl/renderer.ts:411-413`).
- H-023: el `9` de la pasada de copia (`src/gl/renderer.ts:313`).
