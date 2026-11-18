# PLAN-EXPORT — botón Exportar ▾ con PNG, JPG, GIF y MP4

## Lo que ya hay (leído del código)
- `Engine.exportFull()` renderiza el documento a resolución completa en un contexto WebGL propio, con todas las etapas
  (el codificador incluido) → PNG/JPG. La llaman los botones `#btn-png` / `#btn-jpg` del panel Herramientas.
- Las capas de vídeo/GIF (`layer.media`) entran en el renderer como fuente dinámica (`SourceRef.frame/stamp`), y su seed
  se mezcla con el índice de fotograma cuando «Glitch animado» está activo. Ya tenemos `omggif`, `idb-keyval`, el
  `ContextMenu` accesible (role=menu, flechas, Esc) y los diálogos `.sheet`.

## Investigación (noviembre 2026) y librerías
| Candidata | Versión / licencia | Tamaño | Mantenimiento | Decisión |
|---|---|---|---|---|
| **Mediabunny** | 1.66.0 · MPL-2.0 | escritura MP4 ≈ 17 kB min+gz; tree-shakeable; 0 dependencias de ejecución | muy activa (publicada el 13-11-2026) | **Sí.** Muxer MP4/WebM sobre WebCodecs, `StreamTarget` que escribe en un `FileSystemWritableFileStream` por posición (streaming a disco), y también **lee** el vídeo original: fotogramas exactos por tiempo (`CanvasSink`, con la rotación aplicada) y el audio (`AudioSampleSink`) para meterlo en el MP4. MPL-2.0 es copyleft por archivo: se usa sin modificar y desde npm, así que no obliga a nada en nuestro código (anotado en THIRD-PARTY.md). |
| mp4-muxer | 5.2.2 · MIT | 8,8 kB gz | **obsoleta** («superseded by Mediabunny») | No: el propio autor la retiró. |
| **gifenc** | 1.0.3 · MIT | ~9 kB min, 0 dependencias | estable desde 2022 (el formato GIF no cambia) | **Sí.** Cuantización PnnQuant rápida, `applyPalette` y escritor GIF con NETSCAPE2.0. En modo manual permite **streaming** (`bytes()` + `reset()` por fotograma). No trae dithering: Floyd–Steinberg y Bayer son algoritmos de dominio público de ~40 líneas, escritos aquí. |
| @techsquidtv/gifenc | 2.0.0 · MIT | 595 kB sin comprimir | fork activo | No: añade solo el dithering, a cambio de un fork poco probado y más pesado. |
| gif.js | 0.2.0 · MIT | ~40 kB + worker en archivo aparte | sin cambios desde 2022 | No: NeuQuant más lento, exige servir `gif.worker.js` aparte (choca con `build:single`) y acumula todos los fotogramas. |
| `MediaRecorder` + `captureStream` | nativa | 0 | — | No como vía principal: graba en **tiempo real** (depende de la potencia del equipo y no es determinista). |

Compatibilidad comprobada (MDN/caniuse + prueba en este equipo):
- `VideoEncoder`: Chrome/Edge 94+, Firefox 130+, Safari 16.4+. H.264 depende de la plataforma. En Chrome 146 de Windows,
  `isConfigSupported` da H.264, VP9, AV1, AAC y Opus **también sin interfaz** (headless).
- File System Access (`showSaveFilePicker` / `showDirectoryPicker`): **solo Chromium** (Chrome/Edge 86+). Firefox
  tiene posición negativa y Safari solo implementa OPFS. Firefox/Safari → descarga normal + aviso.

## Decisiones
1. **Un render por fotograma, fuera de tiempo real**, con el mismo `GLRenderer` (contexto propio) y un provider de
   exportación. El fotograma *i* tiene el tiempo `t = i / fps` y el índice de ruido *i*. Los vídeos se leen con
   Mediabunny (`CanvasSink`: fotograma exacto, sin buscar en el `<video>`); si el contenedor no se puede leer, se busca
   en el `<video>` como reserva. Los GIF se leen por tiempo desde su reproductor. Se aplican todas las etapas,
   el codificador JPEG/sort incluido. Mismo estado + mismo instante = mismos píxeles.
2. **GIF:** paleta **global** (cuantizada una vez con fotogramas de muestra de toda la animación). Los colores no
   parpadean entre fotogramas y el bucle cierra sin cambio de paleta. Dithering por defecto **ordenado (Bayer 4×4)**:
   es estable en el tiempo, y Floyd–Steinberg «hierve» en animación y hace los GIF más grandes; Floyd–Steinberg queda
   como opción. Cuantización y LZW en un **Worker**, que devuelve los bytes por trozos (streaming).
3. **Retardos GIF en centésimas:** si `100/fps` es entero, el retardo es uniforme (exacto). Si no (p. ej. 30 fps), se
   reparten por error acumulado (3-3-4 cs: media exacta) y la interfaz lo avisa y sugiere 25 / 33,3 / 50 fps. Mínimo
   2 cs: los navegadores tratan ≤ 1 cs como 10 cs.
4. **Bucle perfecto:**
   - *Animación generada* (imagen fija con «Glitch animado»): N = duración·fps fotogramas; ruido = `frameSeed(seed, i mod N)`;
     el «pulso» opcional del EFFECT es `sin(2π·k·i/N)` con *k* ciclos enteros. Todo es periódico con N: el fotograma N
     sería el 0.
   - *Vídeo de entrada:* (1) **fundido cruzado** (predeterminado), (2) ida y vuelta, (3) recortar al bucle más cercano.
     El fundido es el predeterminado porque funciona con cualquier vídeo y conserva el sentido del movimiento: la
     ida y vuelta invierte el movimiento (la gente anda hacia atrás) y el recorte depende de que el contenido se
     repita. El fundido mezcla los renders finales: fotograma *i* = mezcla(render(t + D′), render(t), α = t/solape),
     con D′ = D − solape. Así el paso del último al primero es un paso normal de D′−dt a D′.
   - Etiqueta NETSCAPE2.0 con repeticiones = 0 (infinito) por defecto.
5. **MP4:** H.264 (`avc`) + AAC, con Mediabunny. Si no hay H.264 pero sí VP9 → se ofrece **WebM** (VP9 + Opus), dicho en
   la lista. Sin `VideoEncoder` → MP4 desactivado con el motivo. El audio solo se incluye si el vídeo original tiene
   pista de audio, Mediabunny la puede leer y el navegador puede codificar AAC u Opus; si no, el diálogo dice por qué
   no se incluye. Dimensiones pares (exigencia de H.264).
6. **Guardar:**
   - con File System Access → carpeta elegida (`showDirectoryPicker`), handle en IndexedDB y permiso pedido otra
     vez si caduca. Se escribe en streaming en un `FileSystemWritableFileStream`, que no confirma nada hasta `close()`;
     al cancelar, `abort()` y se borra la entrada creada: **no quedan archivos a medias**.
   - sin esa API → descarga con `<a download>` al terminar, con el aviso «la carpeta la decide el navegador».
7. **Predeterminado:** formato + ajustes + plantilla + modo de carpeta en `localStorage` (saneados al leer). El handle
   de la carpeta va en IndexedDB. «Restablecer» vuelve a los de fábrica.
8. **Plantilla de nombre:** `{nombre}-{seed}-{fecha}` con `{nombre} {seed} {fecha} {hora} {formato} {ancho} {alto}`.
   Se sanean los caracteres no válidos en Windows/macOS, los nombres reservados (CON, NUL…) y la longitud (≤ 120).
9. **Interfaz:** botón partido «Exportar · PNG ▾» en Herramientas (en lugar de PNG y JPG). La lista es un `role="menu"`
   (reutiliza `ContextMenu`) con los formatos que no aplican **desactivados y con el motivo**. El diálogo usa `.sheet`
   (a pantalla completa en móvil) y tiene progreso, cancelar y la interfaz viva (se cede el hilo entre fotogramas).
   Hay un interruptor «Glitch animado» también para capas de imagen fija (en Efectos), que es lo que habilita GIF/MP4 sin
   vídeo.
10. **Límites:** aviso por encima de 1500 fotogramas o de unos 40 MB estimados en GIF. Tope duro de 3600 fotogramas.

## Verificación
- Tests puros: plantilla y saneado del nombre, saneado de ajustes, retardos GIF, mapas de tiempo de los bucles (periodicidad,
  ida y vuelta, fundido), estimación de tamaño.
- Playwright + Chrome: PNG/JPG (firma, dimensiones, el JPG se decodifica); GIF (cabecera, NETSCAPE2.0 con bucle infinito,
  nº de fotogramas, retardos, dimensiones; costura último → primero comparable al paso medio entre fotogramas); MP4
  (parser Mediabunny en el navegador: códec, resolución, fps, duración; y se reproduce en un `<video>`). Además:
  plantilla de nombre, predeterminado tras recargar, cancelar sin archivo a medias (carpeta OPFS como sustituto del
  selector nativo, que Playwright no puede manejar), capturas, consola limpia y cero peticiones externas.
