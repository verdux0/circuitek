# 05 · Persistencia (sesión, proyectos, migración)

## 1. Propósito y responsabilidad

Guardar el trabajo **en este navegador** (IndexedDB) para que recargar no pierda nada: la sesión
autoguardada, los proyectos con nombre (con miniatura) y su transporte como archivo `.glitch`.
También migra los datos guardados con el nombre antiguo de la app (`glitch-editor`).

## 2. Archivos y componentes clave

| Archivo | Contenido |
|---|---|
| `src/session.ts` | `Session`: guardado con retardo (`schedule`, 600 ms) y `flush` (sin solapes: si hay uno en curso, se repite al acabar); escribe primero las imágenes nuevas, luego las fuentes, luego el documento, y borra las imágenes que ya no se usan; `load`, `clear` |
| `src/projects.ts` | `ProjectStore`: `list`, `get`, `save` (imágenes → fuentes → registro, y relee el registro para confirmar), `load`, `rename`, `remove` (con recolección de imágenes y fuentes huérfanas), `exportFile`; `sanitizeRecord`, `parseProjectFile`, `dataUrlToBlob`, `docImageKeys` |
| `src/legacy.ts` | Al importarse, mueve las claves de `localStorage` `glitch-editor:*` a `circuitek:*`; `migrateIdb` copia una base de datos antigua a la nueva (una vez por página y nunca lanza) |

Bases de datos (IndexedDB, con `idb-keyval`):

| Base / almacén | Claves | Dueño |
|---|---|---|
| `circuitek` / `session` | `session` (`SessionData`), `blob:<clave>`, `font:<familia>` | `Session` |
| `circuitek-projects` / `projects` | `p:<id>` (`ProjectRecord`), `blob:<clave>`, `font:<familia>` | `ProjectStore` |
| `circuitek-export` / `handles` | `folder` (`FileSystemDirectoryHandle`) | `export/save.ts` |

## 3. Flujo de funcionamiento

**Sesión.** `main.ts` crea `Session(snapshot, blobFor)`. Cada `afterChange` con el documento tocado
llama a `schedule()`. `write()` reúne las claves de imagen del documento y de las capturas antiguas,
guarda las que faltan (el archivo original, o un PNG generado bajo demanda), guarda las fuentes
pendientes y el registro, y borra las imágenes ya no referenciadas. Al arrancar, `restoreSession`
(`src/main.ts:2078-2123`) llama a `load()`, registra las fuentes, migra las capturas antiguas a
proyectos y rehidrata el documento con `sanitizeDoc` + `hydrate`. Hasta que termina,
`ready = false` impide guardar (para no pisar la sesión que se está leyendo).

**Proyectos.** `saveProject` (`src/main.ts:1047-1082`) congela las capas de vídeo / GIF en su
fotograma actual, genera una miniatura JPEG y llama a `ProjectStore.save`. `openProject` carga
fuentes e imágenes y sustituye el documento (se puede deshacer). Un `.glitch` es
`{ format: 'circuitek-project', v, project, images: {clave: dataURL}, fonts: {familia: dataURL} }`.

## 4. Dependencias

- **Salientes:** `idb-keyval`; `projects.ts` → `doc.ts` (`cloneDoc`, `sanitizeDoc`), `legacy.ts`; `session.ts` → `legacy.ts`.
- **Entrantes:** `main.ts` (las dos clases), `export/save.ts` (`migrateIdb`), `tests/projects.test.ts`.

## 5. Contratos públicos

- `SessionData { v: 1|2, doc, shots, fonts, project? }` (`src/session.ts:19-27`).
- `ProjectRecord { v: 1|2, id, name, created, updated, thumb, layers, doc, fonts }` (`src/projects.ts:28-33`).
- `sanitizeRecord(x) → ProjectRecord | null`: la puerta de entrada de todo registro leído o importado.
- `parseProjectFile(text)`: lanza `Error` con mensajes legibles en español.

## 6. Reglas de negocio e invariantes

- Un proyecto **nunca queda a medias**: si falta una imagen, `save` lanza antes de escribir el registro, y el registro se relee para confirmar (`src/projects.ts:120-146`).
- Las imágenes se guardan una vez y se comparten entre proyectos; borrar un proyecto solo borra lo que ningún otro usa.
- Importar un `.glitch` con un id que ya existe le asigna un id nuevo (`src/main.ts:1279`).
- Nada se sube a ningún servidor.

## 7. Configuración

Ninguna. Retardo del autoguardado: 600 ms. `navigator.storage.persist()` se pide al arrancar (`src/main.ts:2121`).

## 8. Pruebas existentes y huecos

- `tests/projects.test.ts` (12 tests): `sanitizeRecord`, `parseProjectFile`, `dataUrlToBlob`, `docImageKeys` y documentos antiguos.
- Huecos: `Session` y `ProjectStore` (necesitan IndexedDB; se podrían probar con un almacén falso), `legacy.ts`.

## 9. Observaciones técnicas

- H-001: `sanitizeRecord` solo comprueba el prefijo `data:image/` de `thumb` (`src/projects.ts:63`), y eso permite un XSS en la galería.
- H-016: varias llamadas a `ProjectStore` desde `main.ts` no capturan errores.
- H-029: `legacy.ts` borra la base antigua aunque no la haya copiado.
