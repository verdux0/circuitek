# Instrucciones: biblioteca de tipografías para circuitek (inspirada en Photopea)

Versión revisada del prompt original. Pégalo en Claude Code o pídele que lea este archivo y lo ejecute.

---

Implementa en circuitek una biblioteca de tipografías que se pueda explorar, previsualizar y aplicar al texto del editor con una experiencia parecida a la de Photopea. Usa el catálogo de Photopea **solo como referencia de nombres, categorías y estructura**, y obtén los archivos de fuentes de orígenes con licencia que permita redistribuirlos.

## 0. Antes de empezar
1. Lee el proyecto actual (mi copia local ha evolucionado): cómo se representa y se guarda el texto, qué selector de fuentes existe, si ya hay una lista de fuentes artísticas o texto deformable (ondulado, esférico) de una actualización anterior, cómo se serializa el estado (`sanitizeState`, versión del esquema, presets) y cómo se rasteriza el texto antes de pasar por el pipeline WebGL.
2. Amplía lo que ya existe. No crees una arquitectura paralela ni reescribas lo que funciona. Si existe una lista de fuentes anterior, migra a este catálogo sin perderla.
3. Escribe un plan corto en `PLAN-FUENTES.md` y empieza sin esperar aprobación, salvo en las puertas de decisión marcadas abajo.

## 1. Principios y restricciones (heredados del proyecto)
- **La app es local y no hace peticiones de red en tiempo de ejecución.** Por tanto, las fuentes que se ofrezcan por defecto se **empaquetan y se sirven desde nuestro propio origen** (nada de CDN de Google Fonts ni de Fontsource en tiempo de ejecución). Si algún origen externo fuese imprescindible, debe ser opcional, avisar al usuario y estar desactivado por defecto, igual que el buscador de GIFs.
- **Determinista:** el texto exportado (PNG, JPG, GIF, MP4) debe usar exactamente la misma fuente que la vista previa. La exportación espera a que las fuentes estén cargadas y nunca usa una fuente de reserva sin avisar.
- **No destructivo:** cambiar de fuente no modifica tamaño, color, alineación, rotación, posición, espaciado, deformación ni ninguna otra propiedad del texto.
- **Rendimiento:** no se descargan todas las fuentes al iniciar. Búsqueda y lista fluidas en móvil (viewport de 390 px).

## 2. Qué copiar de Photopea y qué no (puerta legal)
Las URL que figuran en el prompt original no las he podido verificar: compruébalas tú.
- `https://www.photopea.com/api/fonts`, `https://www.photopea.com/code/DBS.js` y `https://www.photopea.com/_dist_/font_getter.zip`.
- Si el formato del catálogo (variable `FNTS`, campos `FF`, `FSF`, `PSN`, `FLG`, `CAT`, `URL`, compresión por herencia del registro anterior) ha cambiado o no coincide con esta descripción, documenta lo que encuentres y adapta el análisis.

Reglas:
1. **Lee el catálogo de Photopea una sola vez, solo para obtener nombres de familia, variantes y categorías.** No descargues archivos de fuentes de photopea.com ni de su infraestructura, no hagas hotlinking y no copies su catálogo literalmente. Lee sus condiciones de uso antes y anota lo que digan. Los nombres de familia son datos, pero su archivo y su código no son nuestros.
2. **No copies código de `font_getter`.** Estúdialo como referencia y escribe tu propio script de generación de catálogo y miniaturas.
3. **Para cada familia del catálogo de Photopea, busca el archivo en un origen que permita redistribuirlo.** Prioridad: paquetes `@fontsource/*` (npm), Google Fonts (OFL, Apache 2.0, UFL) y repositorios oficiales de las fundiciones con licencia abierta. Si no hay equivalente con licencia compatible, la fuente queda **excluida** y se anota en el informe. No la sustituyas por otra sin dejarlo registrado (campo `substituteFor`).
4. **dafont, fontesk y Fontshare no se empaquetan por defecto.** Muchas fuentes de dafont son solo para uso personal; Fontesk mezcla licencias; Fontshare usa su propia licencia (no es de código abierto). Solo se incluye una fuente de esos sitios si compruebas su licencia concreta, permite redistribución dentro de una app y guardas la copia de la licencia. Si no, aparece como "solo con enlace" o queda fuera.
5. **Licencias:** guarda por familia el nombre de la licencia, la URL, el autor o fundición, el origen de descarga y el texto de la licencia (la OFL exige distribuirla junto con la fuente). Genera `THIRD-PARTY.md` automáticamente desde el catálogo. Ninguna fuente comercial o de licencia ambigua entra en el repositorio.
6. Si un origen te bloquea o necesita descargarse manualmente, dime exactamente qué descargar y dónde ponerlo. No eludas los bloqueos con proxys ni espejos.

**Puerta de decisión 1:** al terminar la fase 1, entrégame el informe (ver abajo) y **espera mi respuesta** antes de empaquetar nada. Proponme el presupuesto y la selección final.

## 3. Alcance realista
No es una app de diseño gráfico general, es un editor glitch. Por eso:
- **Prioriza fuentes estilizadas** (display, script, graffiti, gótica, retro, stencil, pixel/bitmap, mono técnicas, experimentales), no solo las de lectura. Incluye una selección básica (sans, serif, mono) para uso común.
- **Presupuesto (propuesta inicial, ajústala tras la fase 1):** 150-400 familias, subconjuntos `latin` y `latin-ext`, WOFF2, máximo ~60 MB en total en el repositorio y ninguna variante por encima de 300 KB sin justificarlo. No hace falta igualar todo el catálogo de Photopea: mide cuántas familias se pueden empaquetar legalmente y qué porcentaje del catálogo representan.
- Mide también el efecto en el build y en el despliegue (GitHub Pages / Cloudflare), y que `build:single` (archivo único) **no** incluya las fuentes, o incluya solo un pequeño conjunto base. Documenta la decisión.

## 4. Estructura
```
public/fonts/
  catalog/fonts.json        # catálogo ligero (solo metadatos)
  catalog/categories.json
  files/<id>/<estilo>-<peso>[-<subconjunto>].woff2
  licenses/<id>/LICENSE.txt
tools/fonts/
  extract-photopea-names.mjs   # una sola vez; guarda solo nombres y categorías, no archivos
  build-catalog.mjs            # combina nombres + orígenes con licencia
  subset-fonts.mjs             # subconjuntos y WOFF2 (por ejemplo con fonttools/pyftsubset)
  validate-fonts.mjs           # valida el catálogo y los archivos
```
Registro de ejemplo (los valores son orientativos y no todas las fuentes son OFL):
```json
{
  "id": "bebas-neue",
  "family": "Bebas Neue",
  "categories": ["display", "sans-serif"],
  "source": "fontsource",
  "license": { "id": "OFL-1.1", "url": "...", "author": "..." },
  "redistributable": true,
  "variable": false,
  "subsets": ["latin", "latin-ext"],
  "variants": [{ "style": "normal", "weight": 400, "format": "woff2", "file": "files/bebas-neue/normal-400-latin.woff2", "bytes": 0 }],
  "photopea": { "matched": true, "name": "Bebas Neue" },
  "substituteFor": null
}
```
- Identificador estable por familia. Soporta familias con varias variantes, fuentes variables (rango de pesos y ejes), cursiva y oblicua, subconjuntos, varios formatos y varias categorías.
- Registra el formato original y los disponibles. No conviertas archivos si pierdes variantes, tablas OpenType o características tipográficas.

## 5. Selector de fuentes (amplía el existente)
- Buscador insensible a mayúsculas, con debounce y sin bloquear la interfaz con miles de registros.
- Filtro por categorías (las de Photopea más las propias: script, graffiti, gótica, retro, decorativa, stencil, handwritten, pixel, experimental...), con varias categorías por familia.
- Lista virtualizada. Previsualización con el texto que el usuario está editando (y un texto de ejemplo si no hay), cargada de forma diferida solo para las filas visibles (`IntersectionObserver`), con límite de cargas simultáneas.
- Favoritos y recientes (guardados en `localStorage` con `try/catch`, ya que puede venir vacío o lanzar excepciones), indicador de carga y selector de variante.
- Accesible: navegación con teclado, `aria-label` en español y objetivos táctiles de buen tamaño.

## 6. Carga dinámica
- Usa `FontFace` con un registro de fuentes cargadas, sin duplicar cargas ni peticiones, con estados (pendiente, cargando, lista, error) y reintento.
- **Fuentes variables:** declara el rango en los descriptores (por ejemplo `weight: "100 900"`), no un único peso. El ejemplo del prompt original usaba un peso fijo.
- Antes de medir o dibujar texto en Canvas o de rasterizarlo para el pipeline WebGL, espera a `document.fonts.load()` para esa variante y comprueba que los glifos necesarios existen. Si faltan, avisa y ofrece otra variante.
- Nunca cargues una familia completa si solo se necesita una variante.
- Fallback visible y registrado si la carga falla. Nunca falla en silencio.

## 7. Integración con el editor
Al elegir una fuente: identifica el texto seleccionado, carga la variante, espera, aplícala, vuelve a medir y a rasterizar, y conserva todas las demás propiedades. Respeta la arquitectura de capas existente y la caché de rasterizado (la clave de caché debe incluir la fuente y la variante). La deformación del texto (ondas, esfera) debe seguir funcionando con cualquier fuente.

## 8. Persistencia
- Guarda por elemento de texto: `fontId`, variante, peso, estilo y los ajustes tipográficos. **No** guardes archivos de fuente dentro del proyecto o preset.
- Sube la versión del esquema y haz que `sanitizeState` acepte proyectos y presets antiguos (migración sin pérdida).
- Al reabrir: comprueba que la fuente existe, cárgala y restaura la variante. Si no existe, avisa, usa una alternativa temporal y **conserva el `fontId` original** para que no se pierda la configuración.
- **Fuentes importadas por el usuario** (TTF/OTF/WOFF/WOFF2): se guardan en IndexedDB en su equipo, se marcan como "propias", no se suben ni se empaquetan, tienen un límite de tamaño, y se cargan solo mediante `FontFace` (el navegador las sanea). Avisa de que el usuario es responsable de su licencia.

## 9. Fases
1. **Investigación e inventario.** Analiza el catálogo de Photopea (nombres, familias, variantes, categorías, estructura). Para cada familia, busca un origen con licencia permitida. Informe: número de familias en Photopea, cuántas tienen origen redistribuible, cuántas quedan excluidas y por qué, tamaño estimado y presupuesto propuesto. **Para y espera mi respuesta.**
2. **Biblioteca.** Scripts, subconjuntos WOFF2, `fonts.json` y `categories.json`, licencias, `THIRD-PARTY.md` y validación.
3. **Selector.** Buscador, categorías, previsualización diferida, favoritos, recientes.
4. **Integración con el editor.** Aplicar, cambiar de variante, medir y rasterizar, deformación y exportación.
5. **Persistencia, importación del usuario y pruebas.** Migración, fuentes ausentes, fuentes dañadas y medición.

## 10. Criterios de aceptación (medibles)
- [ ] Informe de fase 1 entregado, con porcentajes reales y la lista de familias excluidas con su motivo.
- [ ] Todas las fuentes empaquetadas tienen licencia verificada, copia del texto de licencia y entrada en `THIRD-PARTY.md`. `validate-fonts` falla si falta alguna.
- [ ] `fonts.json` válido contra un esquema, con identificadores únicos y todos los archivos existentes.
- [ ] Al iniciar la app no se descarga ninguna fuente salvo la base (anótalo con la medición de red) y no hay peticiones a dominios externos.
- [ ] Buscar, filtrar, previsualizar, aplicar y cambiar de variante funciona, incluida una fuente variable.
- [ ] El texto exportado a PNG y a GIF coincide con la vista previa (compara un fotograma) para al menos 5 fuentes de tipos distintos.
- [ ] Guardar y reabrir un proyecto conserva la fuente; un proyecto antiguo se abre sin errores; una fuente ausente conserva su `fontId`.
- [ ] Una fuente de usuario se importa, se usa y no entra en el repositorio ni en los presets.
- [ ] `npx tsc --noEmit` y `npm test` sin errores; el build y `build:single` funcionan, y el tamaño total está dentro del presupuesto acordado.
- [ ] Nada de lo existente se ha roto (tests anteriores en verde).

## 11. Verificación
- Pruebas unitarias con fixtures: descompresión y normalización del catálogo, validación de licencias, búsqueda y filtrado, migración de esquemas. Los tests no llaman a la red.
- Playwright con viewport móvil de 390 px: abre el selector, busca, filtra, aplica una fuente, comprueba que se ha cargado (`document.fonts.check`), que no hay errores en consola y que **no hay peticiones de red a terceros**. Captura de pantalla del selector.
- Mide: tiempo de apertura del selector con el catálogo completo, memoria y peso transferido al cargar 10 fuentes.
- Dime claramente qué no has podido comprobar.

## 12. Informe al terminar cada fase
Archivos creados y modificados, funcionalidades, número de familias y variantes, fuentes pendientes o excluidas (con motivo), problemas, pruebas realizadas y qué tengo que decidir yo. Commits pequeños y claros.
