# PLAN-FUENTES — biblioteca de tipografías (inspirada en Photopea)

Instrucciones: `instrucciones-fuentes-photopea.md`. Estado: **fase 1 terminada, esperando la puerta de decisión 1.**
No se ha empaquetado ninguna fuente.

## Punto de partida (leído del código)
- El texto vive en las capas del documento (`Layer.text: TextProps` en `doc.ts`): `content, font, size, color, bold,
  italic, align, lineHeight`. `font` es un **nombre de familia** (cadena), no un identificador. Se valida en
  `sanitizeDoc`, no en `sanitizeState` (que es el estado de efectos).
- Se rasteriza con Canvas2D (`text.ts`: `measureText`, `drawText`, `rasterTextAt`) antes del pipeline WebGL. La caché del
  provider usa la clave `${src}@${escala}`. `ensureFont()` espera a `document.fonts.load()`.
- Selector actual: un `<select>` en el panel de capas con 7 fuentes incluidas (Fontsource, importadas en `fonts.ts`),
  10 de sistema, las del equipo (Local Font Access) y las importadas por el usuario (IndexedDB de sesión y proyectos).
- **No existe texto deformable** (ondas, esfera) ni una lista de fuentes artísticas de una actualización anterior: no hay
  nada que migrar en ese sentido.

## Fase 1 — investigación e inventario (18/19-11-2026)

### Photopea
- Condiciones (`photopea.com/privacy.html`, «Terms Of Use»): el editor se puede usar gratis para cualquier fin. No dicen
  nada sobre reutilizar su catálogo. `robots.txt` solo trae la explicación de las señales de contenido, sin reglas.
- Las URL del prompt original: `api/fonts` existe y es la **documentación** del formato. `code/DBS.js` y
  `_dist_/font_getter.zip` dan **404**. El catálogo está ahora en `code/dbs/DBS<número>.js` (lo enlaza la portada).
- El formato **coincide** con la documentación: `FNTS.list` = `"FF,FSF,PSN,FLG,CAT,URL"` con la «compresión» por herencia
  del registro anterior, 18 categorías (`cats`) y 17 subconjuntos Unicode (`subsetNames`). La carpeta de `URL` indica
  el origen: `gf/` = Google Fonts, `fs/` = terceros, `ex/` = otros.
- Se leyó **una vez**, solo para nombres, variantes y categorías (`tools/fonts/extract-photopea-names.mjs`). La salida va
  a `tools/fonts/.cache/` (ignorada por git). No se descargó ningún archivo de fuente de Photopea; el script de
  inspección bloqueaba esas peticiones.
- **2663 familias, 10 459 archivos.** Por origen: `gf/` 1650, `fs/` 1112, `ex/` 50. Con latin: 2315.

### Orígenes con licencia redistribuible
- **Fontsource** (API pública, 2103 familias, todas abiertas: OFL-1.1 2059, Apache-2.0 36, UFL-1.0 5, CC0, MIT y Unlicense
  1 cada una). Publica WOFF2 ya subconjuntados (`latin`, `latin-ext`…) y el texto de la licencia en cada paquete.
- Google Fonts (metadatos oficiales, 1961 familias) para la popularidad y la clasificación. Todas sus familias de
  Photopea están ya en Fontsource.
- dafont, Fontesk y Fontshare: **no se usan** (instrucciones, regla 4).

### Resultado del cruce (por nombre normalizado)
| | Familias | % de Photopea |
|---|---|---|
| Con origen redistribuible (Fontsource) | **1888** | **70,9 %** |
| … y con subconjunto latin | 1879 | 70,6 % |
| Excluidas | 784 | 29,4 % |

Motivos de exclusión (lista completa en `tools/fonts/.cache/excluded.json`):
- 716 · origen no verificable: carpeta `fs/` de Photopea, fuentes gratuitas de terceros con licencia personal o
  desconocida (p. ej. *Action Man*, *Capture it*, *Boston Traffic*, *Chomsky*).
- 48 · fuentes de sistema o de escrituras no latinas sin origen abierto verificable (`ex/`: *Droid Sans Fallback*,
  familias tibetanas, coreanas…).
- 11 · nombre distinto en Google Fonts (`Shadows Into` → *Shadows Into Light*, `Libre Barcode` → *Libre Barcode 39*…):
  **recuperables** con un mapeo manual.
- 9 · sin subconjunto latin en el origen abierto.

Cobertura por categoría de Photopea (redistribuibles / total): Sans Serif 715/891 · Display 442/621 · Serif 326/419 ·
Handdrawn 322/364 · Monospaced 54/70 · Script 33/60 · Slab Serif 25/41 · Comic 5/40 · Novelty 4/37 · Retro 1/34 ·
Blackletter 3/33 · Programming 2/30 · Dingbat 0/26 · Calligraphic 1/16 · Stencil 1/15 · Typewriter 2/12 · Pixel 2/3 ·
Grunge 0/1. **Las categorías más «glitch» (Retro, Comic, Novelty, Blackletter, Stencil) son justo las peor cubiertas**,
porque Photopea las saca de orígenes sin licencia clara.

### Tamaños reales (muestra de 95 familias de Fontsource + 16 variables, listado de jsDelivr)
- WOFF2 estático: `latin` media 29,1 KB (mediana 15,6 KB, máx. 351 KB) + `latin-ext` media 11,8 KB por variante.
- Variable (eje `wght`): ~33 KB `latin` + ~36 KB `latin-ext` (máx. 265 KB los dos).
- Por familia: mediana de 1 peso normal (media 2,6); 14 de cada 95 tienen cursiva.
- 7 de 95 tienen alguna variante > 300 KB: se quedan fuera o se justifican una a una.

### Presupuesto (modelo: familia variable = un archivo por subconjunto; estática = hasta Regular + Bold + Italic; + ~4,5 KB de licencia)
| Opción | Familias (estilizadas / básicas / mono) | Peso | Archivos | % de Photopea |
|---|---|---|---|---|
| A | 150 (110 / 30 / 10) | ≈ 10,7 MB | ≈ 540 | 5,6 % |
| **B (propuesta)** | **300 (220 / 60 / 20)** | **≈ 20,8 MB** | **≈ 1080** | **11,3 %** |
| C | 400 (300 / 75 / 25) | ≈ 26,9 MB | ≈ 1420 | 15,0 % |

Todas caben de sobra en el límite de 60 MB y en GitHub Pages (1 GB) y Cloudflare Pages (20 000 archivos, 25 MiB por
archivo). Orden: estilizadas primero (Display, Handdrawn, Script, Blackletter, Retro, Stencil, Pixel…), ordenadas por
popularidad real en Google Fonts. Las primeras: Oswald, Black Ops One, Zeyada, Dancing Script, Caveat, Alfa Slab One,
Fjalla One, Pacifico, Orbitron, Lobster…

## Decisiones propuestas (para la fase 2, pendientes de aprobación)
1. **Presupuesto B:** 300 familias, `latin` + `latin-ext`, WOFF2, ≤ 300 KB por variante.
2. **Variantes:** variable si existe (rango declarado en `FontFace`); si no, Regular, Bold, Italic y Bold Italic cuando existan.
3. **No volver a subconjuntar:** Fontsource ya publica los subconjuntos WOFF2 sin perder tablas OpenType.
   `subset-fonts.mjs` solo para casos que no los traigan.
4. **Descarga en la generación, no como dependencias:** `build-catalog.mjs` baja los archivos y el texto de la licencia
   de los paquetes de npm (registro oficial) una vez, a `public/fonts/`. No se añaden 300 devDependencies.
5. **Completar las categorías flojas con fuentes abiertas que no están en Photopea** (pixel, stencil, blackletter, retro;
   p. ej. Silkscreen, Pixelify Sans, Big Shoulders Stencil, UnifrakturMaguntia, Rubik Glitch). Van marcadas con
   `photopea.matched = false`.
6. **`build:single`** se queda con las 7 fuentes base actuales; la biblioteca solo va en `dist` (se sirve aparte).
7. Las `fs/` de Photopea **quedan fuera** salvo que quieras que verifique a mano una lista corta concreta.

## Decisión 1 (respuesta del usuario)
Opción **C** (400 familias); sí a completar categorías con fuentes abiertas fuera de Photopea; sí a variable o hasta
4 estilos; sí a `build:single` con solo las 7 base. Punto 5 («la licencia está bien, añádelas»): **pendiente de un
origen**. Las 716 `fs/` solo existen como archivos de Photopea (prohibido descargarlas de ahí) y no hay texto de
licencia por familia; se añadirán las que lleguen con su página de origen o en `tools/fonts/manual/<familia>/`.

## Fase 2 — biblioteca (hecha)
- `tools/fonts/build-catalog.mjs`: selección (7 base + complemento + estilizadas por popularidad, básicas y mono),
  plan de variantes dentro de 300 KB por archivo y descarga de los WOFF2 `latin`/`latin-ext`, el `LICENSE` y el
  `metadata.json` (autor, URL) de cada paquete de Fontsource en npm (espejo de jsDelivr). Sin 300 devDependencies.
- `tools/fonts/categories.mjs`: 18 categorías propias (Photopea + Fontsource + palabras clave).
- `tools/fonts/validate-fonts.mjs`: esquema, ids únicos, archivos con tamaño y firma WOFF2, ≤ 300 KB, total ≤ 60 MB,
  licencia permitida con texto y fila en `THIRD-PARTY.md`.
- `subset-fonts.mjs` **no hace falta**: Fontsource ya publica los subconjuntos WOFF2 sin perder tablas OpenType.
- Resultado: **399 familias** (1 excluida: *Libertinus Math*, ninguna variante cabe en 300 KB), **1034 WOFF2,
  27,7 MB** (34 MB con licencias y catálogo), `fonts.json` 384 KB. `dist` 37 MB; `dist-single` 2,3 MB (sin biblioteca).
- Categorías: Display 187, Manuscrita 110, Sans 90, Script 34, Mono 25, Retro 24, Serif 24, Experimental 23,
  Pixel 12, Gótica 10, Cómic 9, Stencil 7, Graffiti 7, Máquina de escribir 3, Slab 3, Decorativa 1.
