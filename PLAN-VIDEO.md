# PLAN-VIDEO — GIF y vídeo con el glitch en directo

## Lo que ya hay (leído del código)
- Documento de **capas** (`doc.ts`). Cada capa apunta a un bitmap por clave (`src`) y lleva sus efectos (`fx`).
- `GLRenderer` compone las capas. Pide los píxeles a un `SourceProvider` (`main.ts`) y los sube **una vez por `key`**
  (`sourceTex`). Las capas con efectos tienen una caché por capa que se invalida con `cacheKey`. La etapa del
  codificador (JPEG + pixel sort) corre en un Worker y escribe en esa caché cuando termina.
- `requestRender()` ya es «bajo demanda»: un rAF por cambio. No hay bucle continuo.
- Dependencias: `konva`, `sortablejs`, `idb-keyval`, `lucide` y fuentes `@fontsource/*`. **Ninguna cubre vídeo ni GIF.**

## Investigación (noviembre 2026)
| API | Chrome/Edge | Firefox | Safari | Uso |
|---|---|---|---|---|
| `<video>` + `texImage2D(video)` | sí | sí | sí | fotograma → textura en la GPU, sin pasar por la CPU |
| `requestVideoFrameCallback` | 83+ | 132+ | 15.4+ (iOS incl.) | avisa de cada fotograma **nuevo**; con `rAF` de reserva |
| `ImageDecoder` (WebCodecs) | 94+ | 133+ | 27.3 escritorio, **no en iOS** | GIF por fotograma, ya compuesto, con su duración |

Fuentes: web.dev/articles/requestvideoframecallback-rvfc, caniuse.com/mdn-api_imagedecoder,
caniuse.com/wf-request-video-frame-callback, bugs de WebKit/Mozilla sobre `texImage2D` de vídeo (el coste
varía mucho según el navegador; hay que medir).

## Decisiones
1. **Sin bucle nuevo, sin pipeline nuevo.** Un vídeo o GIF es una capa más (`layer.media = {kind, animate}`). El
   provider devuelve un `SourceRef` con `frame` (índice del fotograma). Si `frame` cambia, el renderer
   **re-sube la misma textura** (`texImage2D` directo del `<video>` / `ImageBitmap`, con `UNPACK_FLIP_Y`: sin
   el `OffscreenCanvas` intermedio de las imágenes) y la caché de la capa se invalida porque `frame` entra en
   `cacheKey`. El resto (cables, bus, buffer, procesador, modos de fusión, capas) es el código de siempre.
2. **Cuándo se renderiza:** vídeo → `requestVideoFrameCallback` (o `rAF` mientras reproduce, si no existe);
   GIF → temporizador con la duración de cada fotograma. En pausa no hay nada en marcha: solo se renderiza
   al mover un knob, buscar o avanzar un fotograma.
3. **Codificador (JPEG + pixel sort) solo en pausa.** Necesita `readPixels` + Worker por fotograma (decenas de
   ms a 1080p) y su resultado llegaría tarde y a saltos. Mientras se reproduce se salta (`SourceRef.liveOnly`),
   y la barra de vídeo muestra «JPEG/SORT: SOLO EN PAUSA». En pausa, al capturar y en el hash de pruebas se
   aplica completo.
4. **GIF:** `ImageDecoder` cuando existe (decodifica por fotograma bajo demanda, con poca memoria). Si no
   existe (Safari iOS y Safari < 27.3), **`omggif`** decodifica todos los fotogramas una vez, con un tope de
   memoria (si se supera, los fotogramas se reducen y se avisa).
   - `omggif` 1.0.10: licencia MIT, ~38 KB sin comprimir (unos 7 KB minificado), sin dependencias, sin cambios
     desde 2022. El formato GIF89a no cambia, así que no le hace falta mantenimiento. Se importa **dinámicamente**:
     no pesa en la carga si hay `ImageDecoder`, y `build:single` la incrusta igual (sin CDN).
   - Por qué no basta lo nativo: sin `ImageDecoder`, `createImageBitmap` / `<img>` → `texImage2D` dan **solo el
     primer fotograma** (lo dice la especificación de WebGL). Escribir un LZW con la composición por
     «disposal» es reinventar exactamente esta librería.
5. **Glitch animado: activado por defecto.** En un CCD real el ruido de lectura es distinto en cada fotograma:
   un patrón fijo sobre una imagen que se mueve parece una pegatina sucia en la pantalla, no un sensor roto.
   Excepción: si el sistema pide `prefers-reduced-motion`, empieza **desactivado**, porque el ruido que parpadea
   en cada fotograma es justo lo que esa preferencia pide evitar. Seed del fotograma =
   `mixSeed(seed, 0x10000 + frame)`, función pura y determinista: mismo fotograma + misma seed + mismo
   estado = mismos píxeles.
6. **Índice de fotograma del vídeo** = `floor(t · fps + ε)` sobre el `mediaTime` del fotograma **mostrado**. Los
   fps se estiman con las diferencias de `mediaTime` de `requestVideoFrameCallback` (30 hasta medirlos). Avanzar
   o retroceder un fotograma no confía en esos fps: avanzar busca un hueco de fotograma más allá y sigue hasta
   que el fotograma presentado cambia (vídeos de fps variable, estimación con fotogramas perdidos); retroceder
   busca medio hueco antes, que siempre muestra el fotograma anterior.
7. **Capturar / guardar proyecto** congela cada capa de vídeo/GIF en el fotograma actual a resolución completa
   (una imagen nueva). Los proyectos y los `.glitch` siguen siendo imágenes: meter el vídeo como data URL
   en el `.glitch` no es viable. La **sesión** (recargar la página) sí conserva el vídeo: el Blob va a
   IndexedDB y se reabre con un object URL.
8. **Recursos:** un object URL por archivo, revocado al quitar la capa o al cambiar de documento. Al
   quitarla se pausa el vídeo, se vacía su `src` y se llama a `load()`, y se cierran el `ImageDecoder` y los
   `ImageBitmap`. La textura dinámica se borra en el `sweep` del renderer. En `pagehide` se libera todo.
9. **Casos límite:** se importa en silencio con `playsinline` y se reproduce solo. La rotación de los metadatos la aplica
   el navegador (se comprueba con un MP4 con matriz de 90°). Si no se puede decodificar (por ejemplo HEVC): error
   de `<video>`, `videoWidth = 0` o tiempo de espera agotado → aviso claro con el nombre y el códec probable. Un vídeo por encima
   del máximo de textura se rechaza con un aviso. Un archivo corrupto da un aviso, nunca un fallo
   silencioso.

## UI
- Barra de vídeo bajo el visor (estilo hardware): play/pausa · −1/+1 fotograma · búsqueda con tiempo actual y total ·
  velocidad 0,25×–2× · bucle · silencio + volumen · interruptor «Glitch animado» · aviso del codificador.
  Atajos: **Espacio** play/pausa (cuando hay vídeo o GIF; si no, sigue siendo Capturar), **,** / **.** un
  fotograma, **M** silencio.
- EFFECT y FILTER más pequeños y en dos columnas; **Capturar** pasa a la barra superior, a la derecha del
  conmutador claro/oscuro (`#btn-theme`).

## Verificación
- Tests unitarios: `frameSeed`, `frameAt`, `formatTime` y `clampSpeed`.
- Vídeos de prueba generados en Chrome con `MediaRecorder` (WebM y MP4) y GIF animado con Pillow.
- `tools/verify.py`: importar, movimiento, pausa + knob, búsqueda, fotograma ±1, velocidad, volumen, bucle,
  captura a resolución completa, hash determinista, fps a 720p y 1080p, móvil y escritorio, consola limpia.
