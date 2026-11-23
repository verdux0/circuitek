# 02 · Documento e historial

## 1. Propósito y responsabilidad

`DocState` es el **estado editable completo**: un lienzo de W×H «píxeles de documento» con una pila
de capas (imagen, texto, vídeo / GIF), cada una con su transformación, opacidad, modo de fusión y
efectos propios. Es puro y serializable (los mapas de bits se guardan por clave), por eso cabe
entero en el historial de deshacer. `History` guarda instantáneas en JSON.

## 2. Archivos y componentes clave

| Archivo | Contenido |
|---|---|
| `src/doc.ts` | `BLENDS` (16 modos), `Layer`, `LayerMedia`, `DocState`, `emptyDoc`, `cloneDoc` / `cloneLayer`, `newId`, `getLayer`, `fxTargetId`, `pasteLayer`, matrices (`layerMatrix`, `layerCorners`, `layerBounds`, `fromLinear`), operaciones de capa (`fitLayer`, `resetLayer`, `rotateLayer`, `flipLayer`, `moveLayer`) y de documento (`rotateDoc`, `flipDoc`, `cropDocTo`, `resizeDoc`, `scaleDoc`, `clampSize`), `sanitizeDoc` |
| `src/history.ts` | `History<T>`: pilas `past` / `future` de cadenas JSON, límite de 200 |

## 3. Flujo de funcionamiento

1. `main.ts` muta `doc` dentro de `mutate()`. Antes y después serializa el documento; si cambió, guarda el «antes» en `History.push` (doc 10).
2. `History.push` ignora una instantánea igual a la última y vacía `future` (`src/history.ts:7-13`).
3. `undo(current)` / `redo(current)` intercambian instantáneas y devuelven un `DocState` nuevo (parseado), que `main.ts` adopta.
4. Las capas se colocan con `layerMatrix` (`src/doc.ts:145-157`): `translate(x, y) · rotate · scale(±) · translate(−w/2, −h/2)`. La misma matriz la usan el renderer (doc 03) y el visor Konva (doc 11).
5. Lo que llega de almacenamiento o de un archivo pasa por `sanitizeDoc` (`src/doc.ts:357-417`): tamaños limitados (≤ 16 384 px), cadenas recortadas, color hexadecimal estricto, `blend` de una lista cerrada, `fx` por `sanitizeState` y texto validado.

## 4. Dependencias

- **Salientes:** `doc.ts` → `model.ts` (`sanitizeState`, tipos), `text.ts` (`DEFAULT_TEXT`, `TextProps`).
- **Entrantes:** casi todo: `main.ts`, `engine.ts`, `gl/renderer.ts`, `projects.ts`, `session.ts`, `export/exporter.ts`, `ui/layers.ts`, `ui/viewport.ts`, `ui/textedit.ts`, `ui/docdialogs.ts`; tests `doc`, `projects`, `fontlib`.

## 5. Contratos públicos

- `Layer` (`src/doc.ts:30-61`): `x, y` = **centro** en píxeles de documento; `scaleX/Y > 0` (el espejo va en `flipX/Y`); `rotation` en grados normalizados a (−180, 180]; `src` = clave del mapa de bits; `text?`, `fx?`, `media?`, `autoName?`.
- `DocState` (`src/doc.ts:72-81`): `layers` de abajo arriba; `active` = id o `null`.
- `fxTargetId(d)`: la capa cuyos efectos edita la UI (la seleccionada o, sin selección, la primera imagen).
- `History<T>`: `push(prev)`, `undo(cur)`, `redo(cur)`, `size`, `canUndo`, `canRedo`.

## 6. Reglas de negocio e invariantes

- `rotation` siempre normalizada con `normDeg`; `scaleX/Y` siempre positivas.
- `flipLayer` invierte el giro (`F·R(θ)·S = R(−θ)·F·S`, `src/doc.ts:244-250`) para que el espejo se vea en pantalla sobre el eje de la capa.
- Al pegar o duplicar, la copia se desplaza `PASTE_OFFSET × n` píxeles para que no tape a la original.
- `clampSize` mantiene la proporción por debajo del lado máximo de la GPU y de `MAX_MEGAPIXELS = 48` (`src/engine.ts:18`).
- El historial guarda **solo el documento** (con los `fx` de cada capa), no los mapas de bits: deshacer una importación deja la clave, y `main.ts` conserva el mapa de bits.

## 7. Configuración

Ninguna. Constantes: lienzo por defecto 1600×1200 negro (`emptyDoc`), límite del historial 200.

## 8. Pruebas existentes y huecos

- `tests/doc.test.ts` (16 tests): matrices, giros, espejos, recortes, tamaños, pegado.
- `tests/projects.test.ts` (12 tests): `sanitizeDoc` / `sanitizeRecord` con entradas maliciosas o antiguas.
- `tests/core.test.ts`: `History`.
- Huecos: ninguno relevante.

## 9. Observaciones técnicas

- H-010: `cloneLayer` clona `fx` con JSON a mano en vez de con `cloneState` (`src/doc.ts:96`).
- `fromLinear` recibe `flipY` sin usarlo (`void flipY`, `src/doc.ts:184`): está documentado y es inocuo.
