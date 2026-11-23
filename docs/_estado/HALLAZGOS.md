# Registro de hallazgos

Registro vivo de la auditoría de `circuitek`. Las rutas son relativas a la raíz del repositorio y las
líneas corresponden al commit `7714dc4` (línea base), salvo que se indique otra cosa.

**Estados:** Abierto · Resuelto (commit) · Pospuesto (motivo) · Descartado (motivo).
**Verificación:** «Confirmado» = reproducido o comprobado por lectura completa del flujo;
«Hipótesis» = deducido del código, sin reproducir.

---

## H-001 · XSS por la miniatura de un archivo `.glitch`

- **Categoría:** Seguridad · **Severidad:** Alta · **Verificación:** Confirmado (prueba de humo: `pwned=True`)
- **Ubicación:** `src/main.ts:1144` (sumidero `innerHTML`); `src/projects.ts:63` (validación débil); `src/main.ts:2063` (la misma validación para capturas antiguas)
- **Descripción:** `renderProjects` interpola `p.thumb` sin escapar dentro de `src="…"`. `sanitizeRecord` solo comprueba que empiece por `data:image/`, así que un valor como `data:image/png;base64,AAAA" onerror="…` cierra el atributo y añade un manejador de eventos.
- **Impacto:** el formato `.glitch` está pensado para pasarse entre personas («un proyecto puede viajar como un único archivo», `src/projects.ts:12`). Abrir un archivo manipulado ejecuta JavaScript en el origen de la app: puede leer o borrar todos los proyectos y la sesión (IndexedDB), y el código sigue ahí cada vez que se abre la galería.
- **Solución propuesta:** (1) validar la miniatura con una expresión estricta (`^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$`) en un único helper que usen `projects.ts` y `migrateShots`; (2) defensa en profundidad: escapar también el atributo al pintar.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-002 · Menús y ventanas interpolan textos en `innerHTML`

- **Categoría:** Seguridad · **Severidad:** Media · **Verificación:** Confirmado (prueba de humo: 2 elementos inyectados)
- **Ubicación:** `src/ui/contextmenu.ts:51` (`it.label`, `it.keys`); `src/ui/menubar.ts:161` (`it.label`, `it.keys`, `it.ext`); `src/ui/window.ts:23` (`opts.title`); origen de datos del usuario: `src/main.ts:1845` (nombre de capa en «Pegar estilo de «…»»)
- **Descripción:** los componentes de menú construyen sus filas con `innerHTML` y sus etiquetas sin escapar. Hoy casi todas las etiquetas son constantes, pero «Pegar estilo de «nombre»» lleva el nombre de una capa (de un nombre de archivo o de un `.glitch` importado), recortado a 18 caracteres.
- **Impacto:** inyección de HTML en el menú contextual. Con 18 caracteres es difícil, pero no imposible, ejecutar código; y cualquier etiqueta futura con datos del usuario heredaría el problema.
- **Solución propuesta:** construir las filas con nodos DOM y `textContent` para `label`, `keys`, `ext` y `title`; los iconos (SVG de confianza) siguen por `innerHTML`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-003 · Un error en la etapa del codificador congela la vista previa

- **Categoría:** Manejo de errores · **Severidad:** Media · **Verificación:** Confirmado por lectura del flujo completo (sin reproducir: hace falta un fallo del navegador al codificar o decodificar)
- **Ubicación:** `src/encoder/worker.ts:22-32`; `src/encoder/client.ts:46` y `:55-59`; `src/engine.ts:87-98`; `src/gl/renderer.ts:472-497`
- **Descripción:** si `processEnc` lanza dentro del worker (p. ej. `convertToBlob` o `createImageBitmap` fallan), el `onmessage` asíncrono rechaza sin responder: la promesa de `EncoderClient.run` queda pendiente para siempre. El camino sin worker (`fallback`) hace `.then(j.resolve)` sin rechazo. En `Engine.renderPreview`, `encBusy` solo vuelve a `false` en el `.then`. En `GLRenderer.runLayerEncoder`, `e.encBusy` solo vuelve a `false` si `encode` resuelve.
- **Impacto:** tras un único fallo, la etapa JPEG / pixel sort deja de actualizarse en esa capa hasta recargar (la caché se queda «ocupada»), el indicador de actividad puede quedarse encendido y un export puede quedarse esperando para siempre.
- **Solución propuesta:** el worker captura el error y responde `{ id, error }`; el cliente rechaza la promesa (también en `fallback`); `Engine` y `GLRenderer` liberan sus banderas en `finally` y el resultado fallido se descarta (se ve el resultado de GPU).
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-004 · No se gestiona la pérdida del contexto WebGL

- **Categoría:** Manejo de errores · **Severidad:** Media · **Verificación:** Confirmado (no hay `webglcontextlost` en `src/`)
- **Ubicación:** `src/gl/renderer.ts:134`; `src/engine.ts:41`
- **Descripción:** el navegador puede quitar el contexto WebGL (driver reiniciado, falta de memoria de GPU, muchas pestañas). No se escucha `webglcontextlost` / `webglcontextrestored`, y texturas, programas y cachés no se recrean.
- **Impacto:** la vista previa se queda en negro o congelada sin aviso hasta recargar la página.
- **Solución propuesta:** escuchar los dos eventos; al perder el contexto, avisar con un toast; al recuperarlo, recrear `GLRenderer` (programas y VAO) y vaciar las cachés. Requiere diseño y prueba en navegador.
- **Esfuerzo:** M · **Riesgo de regresión:** Medio · **Dependencias:** H-032 (una E2E fiable)
- **Estado:** Abierto

## H-005 · Las rasterizaciones de texto se acumulan sin liberarse

- **Categoría:** Rendimiento · **Severidad:** Media · **Verificación:** Confirmado por lectura (único `bitmaps.delete` en `src/main.ts:478`)
- **Ubicación:** `src/main.ts:507-519` (`refreshText`)
- **Descripción:** cada cambio de un texto (cada tecla) crea un `OffscreenCanvas` de hasta 1024 px bajo una clave nueva `T|<json>` en el mapa `bitmaps`, y nunca se borra (solo cuando una fuente llega tarde).
- **Impacto:** escribir un texto largo o mover sus controles acumula decenas o cientos de MB en memoria durante la sesión.
- **Solución propuesta:** podar las claves `T|…` que no use el documento actual ni el portapapeles de capas, y regenerar bajo demanda la rasterización de una capa de texto cuya clave falte (deshacer / rehacer).
- **Esfuerzo:** M · **Riesgo de regresión:** Medio · **Dependencias:** —
- **Estado:** Abierto

## H-006 · `download()` triplicado

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/main.ts:1259-1265`; `src/main.ts:1313-1318` (en línea, guardar preset); `src/export/save.ts:168-174`
- **Descripción:** tres copias del mismo patrón (`<a download>` + `URL.revokeObjectURL`), con plazos distintos (5 s y 10 s).
- **Impacto:** un arreglo en una copia no llega a las demás.
- **Solución propuesta:** usar `download` de `src/export/save.ts` en los tres sitios.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-007 · `escapeHtml()` triplicado

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/main.ts:1127-1129`; `src/ui/fontpicker.ts:64`; `src/ui/layers.ts:544`
- **Descripción:** tres implementaciones de la misma función de escape.
- **Impacto:** riesgo de que una se quede atrás (es una función de seguridad).
- **Solución propuesta:** un único `escapeHtml` exportado desde `src/ui/html.ts`, con tests.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-008 · Dos recorridos de bloques GIF casi iguales

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/gifsearch/client.ts:166-193` (`checkGif`); `src/media/player.ts:679-703` (`gifFrameCountAtLeast2`)
- **Descripción:** los dos recorren la cabecera, la paleta global y los bloques de extensión / imagen de un GIF con el mismo código. Solo cambian la condición de parada y qué devuelven (el primero hace `break` ante un byte desconocido, el segundo devuelve `false`).
- **Impacto:** un arreglo del parser (p. ej. un GIF truncado) hay que hacerlo dos veces.
- **Solución propuesta:** un generador `gifFrames(bytes)` compartido que devuelva el número de fotogramas encontrados hasta un límite, con tests de caracterización de los dos comportamientos actuales.
- **Esfuerzo:** M · **Riesgo de regresión:** Medio · **Dependencias:** tests de caracterización
- **Estado:** Abierto

## H-009 · Registro de fuentes desde un Blob duplicado

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/main.ts:1085-1102` (`loadProjectFonts`); `src/main.ts:2082-2092` (`restoreSession`); parecido en `src/text.ts:129-136`
- **Descripción:** el mismo bloque `new FontFace(family, await blob.arrayBuffer()) → load → document.fonts.add → fonts.files.push → fontBlobs.set` aparece dos veces en `main.ts`.
- **Impacto:** se desincronizan fácilmente: una copia llama a `session.addFont` y la otra no (a propósito: la sesión ya tiene esas fuentes).
- **Solución propuesta:** un helper `registerFontBlob(family, blob, { persist })` en `main.ts`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-010 · `STAGES.find(...)!` y clonados JSON en vez de los helpers del modelo

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/presets.ts:82`, `:112`, `:119`; `src/motion.ts:29` (ya existe `stageDef`, `src/model.ts:143`); `src/presets.ts:96` y `src/doc.ts:96` (ya existe `cloneState`, `src/model.ts:237`)
- **Descripción:** se repite a mano lo que ya hacen `stageDef()` y `cloneState()`.
- **Impacto:** legibilidad; si cambia la forma de clonar (p. ej. `structuredClone`), hay varios sitios.
- **Solución propuesta:** usar `stageDef(id).params` y `cloneState(x)`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-011 · `rasterText` duplica a `rasterTextAt`

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/text.ts:87-94` y `src/text.ts:97-103`
- **Descripción:** `rasterText(t, w, h, max)` es `rasterTextAt(t, w, h, min(1, max / max(w, h)))` copiado línea a línea.
- **Impacto:** menor; dos sitios que mantener.
- **Solución propuesta:** que `rasterText` llame a `rasterTextAt`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-012 · Búsqueda del fotograma por tiempo duplicada en `GifPlayer`

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/media/player.ts:629-630` (`seek`) y `:645-647` (`indexAt`)
- **Descripción:** el mismo bucle lineal sobre `starts` aparece dos veces.
- **Impacto:** menor.
- **Solución propuesta:** un método privado `frameAtMs(ms)`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-013 · Lista de familias genéricas CSS duplicada

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/text.ts:44` (`GENERIC`); `src/main.ts:416` (`GENERIC_FONTS`)
- **Descripción:** la misma lista de seis familias genéricas, en dos sitios.
- **Impacto:** si se añade una (p. ej. `ui-monospace`), una de las dos se queda atrás.
- **Solución propuesta:** exportar `GENERIC_FONTS` desde `text.ts`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-014 · `main.ts` es un módulo «dios» con inicialización dependiente del orden

- **Categoría:** Arquitectura · **Severidad:** Alta · **Verificación:** Confirmado
- **Ubicación:** `src/main.ts:1-2277` (todo el archivo). Ejemplos: estado global mutable `src/main.ts:55-75`; el manejador de teclado (`:1650`) usa `exportUi`, `gifSearch` y `menuBar`, declarados después (`:1859`, `:1887`, `:1959`); `afterChange(true, true)` se llama en `:1808` antes de declarar `menu` y `exportUi`.
- **Descripción:** un único archivo concentra estado, mutaciones e historial, importación, portapapeles, proyectos, exportación, barra de medios, panel «Movimiento», teclado, menús, restauración de sesión y la API de depuración. Unas 40 variables `let`/`const` de módulo forman el estado. El orden de las declaraciones importa (zona muerta temporal de `const`).
- **Impacto:** es difícil de probar (nada de `main.ts` tiene tests unitarios), cada cambio arriesga efectos lejanos, y reordenar código puede romper el arranque en tiempo de ejecución sin que `tsc` lo detecte.
- **Solución propuesta:** extraer por etapas, empezando por lo que menos estado comparte: (1) API de depuración → `src/debug.ts`; (2) proyectos (galería, guardar / abrir, `.glitch`) → `src/ui/projects.ts`; (3) barra de medios → `src/ui/mediabar.ts`; (4) teclado → `src/ui/keys.ts`; (5) un objeto `App` con el estado explícito. Cada paso con E2E en verde.
- **Esfuerzo:** L · **Riesgo de regresión:** Alto · **Dependencias:** H-032
- **Estado:** Pospuesto (D-006: necesita decisión y una E2E fiable)

## H-015 · La API de depuración `window.__glitch` se publica en producción

- **Categoría:** Seguridad · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/main.ts:2146-2277`
- **Descripción:** el build de producción expone funciones como `clearProjects`, `setDoc`, `session` o `setExportFolder`.
- **Impacto:** bajo: cualquier script que corra en la página ya tiene el mismo acceso a IndexedDB. Pero facilita el abuso (p. ej. tras un XSS como H-001) y engorda la superficie pública.
- **Solución propuesta:** activarla solo con `?debug` o con una variable de build que use la verificación, o separarla en `src/debug.ts` y cargarla bajo demanda. Las herramientas de `tools/` la usan contra `vite preview`.
- **Esfuerzo:** S · **Riesgo de regresión:** Medio (rompe las herramientas si no se adaptan) · **Dependencias:** H-032
- **Estado:** Pospuesto (D-007: decisión de producto)

## H-016 · Promesas sin `catch` en acciones de la interfaz

- **Categoría:** Manejo de errores · **Severidad:** Baja · **Verificación:** Confirmado por lectura
- **Ubicación:** `src/main.ts:1227` (`projects.remove(...).then` sin `catch`); `src/main.ts:1053` y `:1062` (`freezeMedia` y `thumbOf` fuera del `try` de `saveProject`); `src/main.ts:1242-1248` (`exportProjectPng` sin `try`); `src/main.ts:1187` (`projects.rename` sin `try`)
- **Descripción:** si IndexedDB o la GPU fallan en estos pasos, el error sale como `unhandledrejection` y no se avisa a la persona.
- **Impacto:** fallos silenciosos (la acción no hace nada y no hay mensaje).
- **Solución propuesta:** envolver cada acción en `try/catch` con un toast, como ya hacen `exportProjectFile` o `exportImage`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-017 · `parsePresetFile(null)` lanza un `TypeError`

- **Categoría:** Manejo de errores · **Severidad:** Baja · **Verificación:** Confirmado por lectura
- **Ubicación:** `src/model.ts:323-325`
- **Descripción:** con el JSON `null`, `'state' in raw` lanza `TypeError`.
- **Impacto:** ninguno visible: quien llama (`src/main.ts:1326-1332`) lo captura y muestra «Ese archivo no es un preset válido», que es lo correcto.
- **Solución propuesta:** —
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Descartado (el comportamiento externo ya es el correcto)

## H-018 · Serializaciones JSON en caminos calientes

- **Categoría:** Rendimiento · **Severidad:** Baja · **Verificación:** Hipótesis (sin medir)
- **Ubicación:** `src/gl/renderer.ts:411-413` (`cacheKey` serializa `l.fx` en cada render y capa); `src/main.ts:1159-1165` (`syncProjectLabel` serializa el documento en cada `afterChange` con documento tocado, también durante los arrastres)
- **Descripción:** `JSON.stringify` por fotograma o por evento de arrastre.
- **Impacto:** probablemente pequeño: el documento solo guarda metadatos, no píxeles. Habría que medirlo con muchas capas.
- **Solución propuesta:** medir primero; si importa, guardar en caché por versión de documento.
- **Esfuerzo:** M · **Riesgo de regresión:** Medio · **Dependencias:** —
- **Estado:** Pospuesto (medir antes de optimizar)

## H-019 · Listeners que se acumulan durante los exports

- **Categoría:** Rendimiento · **Severidad:** Baja · **Verificación:** Confirmado por lectura
- **Ubicación:** `src/export/exporter.ts:302-305` (un listener `abort` nuevo por cada espera al worker: uno o más por fotograma); `src/export/exporter.ts:145-150` (el listener `seeked` se queda si salta el plazo de 1,5 s)
- **Descripción:** `{ once: true }` solo los quita cuando el evento ocurre, y en un export normal no ocurre.
- **Impacto:** cientos o miles de closures vivas en la `AbortSignal` mientras dura un export largo.
- **Solución propuesta:** quitar el listener al despertar (`removeEventListener`) o usar un único listener por export.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-020 · `VideoPlayer.resolveDuration` espera `seeked` sin plazo

- **Categoría:** Manejo de errores · **Severidad:** Baja · **Verificación:** Hipótesis
- **Ubicación:** `src/media/player.ts:175-176`
- **Descripción:** tras buscar el final del vídeo, se vuelve a `currentTime = 0` y se espera `seeked` sin plazo. Si el elemento entra en error, la promesa no termina nunca.
- **Impacto:** abrir ese vídeo se queda colgado (sin toast de error).
- **Solución propuesta:** usar el helper `once(…)` del mismo archivo, que ya tiene plazo.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-021 · Comentarios descolocados y restos

- **Categoría:** Legibilidad · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/main.ts:177-180` (el comentario de `sourceOf` está encima del de `anim`); `src/main.ts:209` y `:225` (llaves de bloque sin función dentro de `sourceOf`); `src/motion.ts:52-56` (el JSDoc de `paramAt` está encima de `FLICKER_SCALE`)
- **Descripción:** restos de ediciones anteriores que confunden al leer.
- **Impacto:** legibilidad.
- **Solución propuesta:** mover cada comentario a su sitio y quitar el bloque vacío.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-022 · `allPanels()` no se usa

- **Categoría:** Código muerto · **Severidad:** Baja · **Verificación:** Confirmado (búsqueda en `src/`, `tests/`, `tools/`, `index.html` y documentación: solo su definición)
- **Ubicación:** `src/ui/dock/layout.ts:100-102`
- **Descripción:** la función exportada no tiene referencias, ni directas ni dinámicas.
- **Impacto:** menor.
- **Solución propuesta:** borrarla.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-023 · Números mágicos en el pipeline de GPU

- **Categoría:** Legibilidad · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/gl/renderer.ts:313` (`9` = pasada de copia); `src/model.ts:358`, `:362`, `:366`, `:387` (sales `101`–`104` de las semillas de etapa)
- **Descripción:** valores con significado sin nombre (el del shader solo se explica en el comentario de `src/gl/shaders.ts:5`).
- **Impacto:** legibilidad; cambiar una sal cambia los resultados guardados (debe quedar claro que no se pueden tocar).
- **Solución propuesta:** constantes con nombre (`PASS_COPY`, `SALT_BUS`…) con un comentario que diga que los valores son parte del formato.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-024 · `tools/smoke.py` solo funciona en Linux

- **Categoría:** Configuración · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `tools/smoke.py:7` (`/usr/bin/google-chrome` fijo); compárese con la detección de `tools/verify.py:27-31`
- **Descripción:** la ruta del navegador está escrita a mano. Además, en la raíz hay una carpeta vacía `Nueva carpeta/` (git no la sigue).
- **Impacto:** la herramienta falla en Windows y macOS.
- **Solución propuesta:** usar la misma detección que `verify.py` (o `GLITCH_CHROME`). La carpeta vacía puede borrarla su dueño (no se toca: no está en git y no es código).
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-025 · Huecos de tests en las zonas con estado

- **Categoría:** Testing · **Severidad:** Media · **Verificación:** Confirmado (imports de `tests/*.test.*`)
- **Ubicación:** sin tests: `src/main.ts`, `src/engine.ts`, `src/gl/renderer.ts`, `src/session.ts`, `src/legacy.ts`, `src/export/save.ts`, `src/export/exporter.ts` (salvo funciones puras), `src/ui/*`
- **Descripción:** los 143 tests cubren bien la lógica pura (modelo, documento, presets, codificador de bytes, ajustes de export, dithering, fuentes, GIF, movimiento, proyectos). Lo que tiene estado o depende del navegador solo se verifica con las herramientas E2E de `tools/`, hoy rotas (H-032). No hay herramienta de cobertura.
- **Impacto:** las regresiones en la UI y el render no las detecta la CI (`.github/workflows/pages.yml:30-31` solo ejecuta `tsc` y `vitest`).
- **Solución propuesta:** reparar la E2E (H-032), ejecutar una prueba de humo en CI con Chrome sin cabeza y añadir tests unitarios donde la lógica se pueda separar del DOM (p. ej. `Session.write` con un almacén falso).
- **Esfuerzo:** L · **Riesgo de regresión:** Bajo · **Dependencias:** H-032
- **Estado:** Abierto (parcial en esta pasada: tests nuevos para lo que se toca)

## H-026 · Dependencias con versiones nuevas

- **Categoría:** Dependencias · **Severidad:** Baja · **Verificación:** Confirmado (`npm outdated`, `npm audit` = 0 vulnerabilidades)
- **Ubicación:** `package.json:15-40`
- **Descripción:** konva 10.9.1 → 10.10.0, lucide 1.69.0 → 1.78.0, mediabunny 1.66.0 → 1.66.2, vitest 5.1.0 → 5.1.1 y vite 6.4.6 → 8.3.8 (mayor). Todas las dependencias se usan (comprobado import a import).
- **Impacto:** ninguno conocido hoy.
- **Solución propuesta:** actualizar las de parche y menores en un commit aparte, con la E2E en verde; estudiar vite 8 por separado.
- **Esfuerzo:** S (menores) / M (vite) · **Riesgo de regresión:** Medio · **Dependencias:** H-032
- **Estado:** Pospuesto (D-005)

## H-027 · Chunks de JavaScript de más de 500 kB

- **Categoría:** Rendimiento · **Severidad:** Baja · **Verificación:** Confirmado (aviso de `vite build`)
- **Ubicación:** salida de `npm run build`: `assets/index-*.js` 536 kB (174 kB gzip) y `assets/src-*.js` 796 kB (204 kB gzip)
- **Descripción:** la carga inicial incluye Konva, SortableJS, Lucide y el resto de la app. mediabunny y omggif ya se cargan bajo demanda (`import()`).
- **Impacto:** primera carga más lenta en redes móviles.
- **Solución propuesta:** medir qué hay en cada chunk antes de partirlo (p. ej. cargar `exportui` y `gifsearch` bajo demanda).
- **Esfuerzo:** M · **Riesgo de regresión:** Medio · **Dependencias:** —
- **Estado:** Pospuesto (medir antes de optimizar)

## H-028 · Límite de la semilla incoherente

- **Categoría:** Legibilidad · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/main.ts:660` (campo de semilla: 0…999 999); `src/model.ts:255` (`sanitizeState`: 0…4 294 967 295)
- **Descripción:** un preset puede traer una semilla mayor de 999 999, que se muestra en el campo, pero si se edita a mano se recorta.
- **Impacto:** menor; cambiarlo es un cambio de comportamiento.
- **Solución propuesta:** decidir un único rango y documentarlo.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Pospuesto (decisión de producto)

## H-029 · La migración de nombres borra la base antigua aunque no la copie

- **Categoría:** Manejo de errores · **Severidad:** Baja · **Verificación:** Hipótesis (caso límite)
- **Ubicación:** `src/legacy.ts:43-50`
- **Descripción:** `copy` solo copia si la base nueva está vacía, pero borra la antigua siempre. Si existieran las dos con datos (dos versiones abiertas a la vez), se perderían los de la antigua.
- **Impacto:** improbable (la migración es de una versión antigua de la app).
- **Solución propuesta:** borrar la base antigua solo si se copió o si ya estaba vacía.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Pospuesto (riesgo casi nulo; tocar migraciones sin un caso real es más arriesgado que dejarlo)

## H-030 · Mensaje de error repetido en los exports

- **Categoría:** Duplicación · **Severidad:** Baja · **Verificación:** Confirmado
- **Ubicación:** `src/export/exporter.ts:278` y `:467`
- **Descripción:** el mismo texto «No hay nada animado…» escrito dos veces.
- **Impacto:** menor.
- **Solución propuesta:** una constante o un helper `assertAnimated(info)`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto

## H-031 · Lectura del cuerpo de la búsqueda de GIF fuera del `try`

- **Categoría:** Manejo de errores · **Severidad:** Baja · **Verificación:** Confirmado por lectura
- **Ubicación:** `src/gifsearch/client.ts:148`
- **Descripción:** si la conexión se corta mientras se lee la respuesta, `res.text()` lanza un error genérico en vez de un `SearchError('…', 'network')` como en el resto del cliente.
- **Impacto:** el panel muestra un mensaje menos claro.
- **Solución propuesta:** envolver la lectura igual que el `fetch`.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Resuelto (commit «perf(gifsearch)», test «search body read»)

## H-032 · La suite E2E de `tools/` está rota desde el rediseño de la UI

- **Categoría:** Testing · **Severidad:** Alta · **Verificación:** Confirmado (`python tools/verify.py` falla esperando `#tab-fx`)
- **Ubicación:** `tools/verify.py:213`; `tools/verify_anim.py:47`, `:178`; `tools/verify_export.py:164` (y posiblemente otros selectores de la UI anterior)
- **Descripción:** las verificaciones en navegador usan selectores de la interfaz anterior a los commits «UI redesign, phase 1…6». El rediseño no las actualizó.
- **Impacto:** el proyecto no tiene ninguna verificación automática de la UI, el render ni los exports: es la red de seguridad que falta para H-004, H-005, H-014 y H-026.
- **Solución propuesta:** actualizar los selectores a la UI actual (paneles del dock, menú «Archivo ▸ Exportar como») y añadir una prueba de humo pequeña a la CI. Esta pasada añade `tools/smoke_audit.py` como primer paso.
- **Esfuerzo:** L · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Abierto (parcial: prueba de humo nueva)

## H-033 · La lista de fuentes queda fuera de la vista del panel Propiedades

- **Categoría:** Arquitectura (UI) · **Severidad:** Alta · **Verificación:** Confirmado (captura en Chrome: solo asomaba una fila)
- **Ubicación:** `src/ui/fontpicker.ts` (`expand`); `src/styles.css:445` (`.fp-list` con altura fija de 9 filas); `src/styles.css:48` (`.dock-content` con scroll propio)
- **Descripción:** desde el rediseño del dock, el selector vive en un bloque de altura limitada. Al abrirlo, la lista se desplegaba por debajo del borde visible del panel y el bloque «Capas» la tapaba: parecía que no había fuentes (el catálogo y los archivos sí cargaban: 409 familias, respuestas 200).
- **Impacto:** no se podía elegir fuente sin descubrir que había que hacer scroll dentro del panel.
- **Solución aplicada:** al abrir (y al redimensionar), la lista se ajusta al alto disponible del panel (mínimo 4 filas) y el panel se desplaza para mostrar el campo y la lista enteros.
- **Esfuerzo:** S · **Riesgo de regresión:** Bajo · **Dependencias:** —
- **Estado:** Resuelto (commit «fix(fuentes)»)
