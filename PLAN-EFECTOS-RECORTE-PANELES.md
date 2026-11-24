# PLAN — paneles redimensionables, recorte y efectos de capa

Encargo: `prompt-efectos-recorte-paneles.md`. Rama `feature/efectos-recorte-paneles`, que sale de
`refactor/auditoria-circuitek` y por tanto incluye los arreglos de fuentes y de la búsqueda de GIF.
Orden: paneles → recorte → efectos, con un commit por función.

## Lo que ya existe y se reutiliza
- **Dock** (`src/ui/dock/layout.ts`, `dock.ts`): el diseño de paneles ya se describe como datos
  (columnas → bloques → pestañas, con `width`, `size` y `collapsed`), y en móvil los paneles son
  flotantes. Faltaban los separadores, el plegado, la persistencia y las hojas inferiores.
- **Visor** (`src/ui/viewport.ts`, Konva): ya tiene un `ResizeObserver`, y Konva aplica
  `devicePixelRatio`. Solo falta limitar el recálculo a uno por fotograma.
- **Documento** (`DocState`): es serializable, entra entero en el historial de deshacer, se guarda
  en la sesión y en los proyectos y pasa por `sanitizeDoc`. El recorte y los estilos de capa viven ahí.
- **Renderer** (`src/gl/renderer.ts`): ya tiene objetivos de render por tamaño, una caché por capa
  con clave de contenido, pasadas ping-pong y fusión por shader (`COMP_FRAG`). Los efectos usan esa
  misma infraestructura.
- **Ventanas** (`src/ui/window.ts`) y filas de slider (`src/ui/slider.ts`): sirven para el diálogo
  «Estilo de capa».
- No se añade ninguna librería.

## 1. Paneles
- Un separador vertical entre cada columna y el visor (arrastrar, flechas, doble clic = ancho por
  defecto) y separadores horizontales entre los bloques de una columna.
- Mínimos y máximos: columna de 200 a 520 px, siempre dejando al visor al menos 320 px. Al
  arrastrar más allá del mínimo, la columna se pliega a una tira con un botón para desplegarla. Los
  bloques se pliegan (solo la cabecera) con un botón ▾ o arrastrando hasta el mínimo.
- «Ventana ▸ Restablecer diseño de paneles».
- `localStorage['circuitek:layout']` con `try/catch`. Al cargar se valida contra el diseño por
  defecto: solo se aceptan ids conocidos y valores dentro de rango para la pantalla actual.
- Accesibilidad: `role="separator"`, `aria-orientation`, `aria-valuenow/min/max`, foco visible y
  flechas (Mayús = 40 px).
- Móvil (≤ 768 px): los paneles flotantes pasan a **hojas inferiores** a todo el ancho, con un asa
  superior para arrastrar su altura (`touch-action: none`).
- La «barra inferior» del encargo no existe en circuitek: el transporte de medios está arriba, en la
  barra de opciones. No se añade.

## 2. Recorte — decisión: ventana de vista sobre la imagen ya procesada
- `DocState.crop?: { x, y, w, h }` en coordenadas normalizadas (0..1) del lienzo.
- El documento se renderiza **entero, como siempre**, y el recorte solo elige qué rectángulo se ve
  y se exporta. Así el patrón del glitch no cambia: las líneas virtuales del shader se cuentan sobre
  el lienzo completo. Recortar cambiando el tamaño del lienzo, como hace hoy «Imagen ▸ Recortar»,
  sí cambiaría el patrón.
- Exportación: se renderiza el documento completo a la escala que da el tamaño de salida pedido
  para el recorte, y se extrae el rectángulo. Lo usan PNG, JPG, GIF, MP4 y las miniaturas.
- La herramienta es una capa DOM sobre el visor (no Konva): el rectángulo, 8 asas de 44 px, el
  «escudo» y los tercios hechos con CSS, y la barra de opciones del recorte. Arrastres con pointer
  events y flechas para mover.
- La casilla «eliminar píxeles recortados» (desactivada por defecto) aplica `resizeDoc` al
  rectángulo. Eso sí cambia el lienzo, y el patrón del glitch con él (se avisa en la propia casilla).
- Un único paso de historial al aplicar.

## 3. Efectos de capa — decisión: dentro de cada capa, antes del pipeline glitch
- `Layer.style?: LayerStyle` con `enabled` y cuatro efectos (sombra paralela, resplandor exterior,
  sombra interior y resplandor interior). La luz global va en `DocState.light = { angle }`.
- Se calculan en la GPU a partir del **alfa de la capa ya colocada** (espacio de documento):
  máscara → desplazamiento → expansión o contracción (filtro de máximo separable) → desenfoque
  gaussiano separable (ping-pong) → contorno / rango → color o degradado → ruido.
- Las medidas en píxeles (distancia, tamaño) se multiplican por la escala del render (salida /
  documento), así que la vista previa y la exportación a resolución completa se ven igual.
- **Dónde entran:** forman parte de la capa y van **antes** de las pasadas glitch de esa capa, como
  se proponía, así que el glitch altera también sombras y resplandores.
  - Los **efectos interiores** se funden con el contenido usando su modo de fusión (`COMP_FRAG`),
    recortados a la forma de la capa.
  - Los **efectos exteriores** (sombra paralela y resplandor exterior) se guardan en su propia textura
    de caché. Pasan por las mismas pasadas glitch de la capa y después **se funden sobre lo que hay
    debajo** con su modo de fusión (p. ej. Multiplicar), antes del contenido, como en Photoshop.
  - Limitación: la etapa JPEG / pixel sort (CPU) solo se aplica al contenido, no a los efectos
    exteriores.
  - No se ofrece «aplicar glitch después»: haría falta otra cadena completa por capa, así que no es
    barato.
- Caché: la clave de la caché por capa incluye el estilo y el ángulo de luz global; si no cambian,
  no se recalcula.
- El ruido sale de un hash entero de (píxel, semilla de la capa, efecto): es determinista y no usa
  `Math.random()`.
- Interfaz: «Estilo de capa» como ventana (lista de efectos con casilla a la izquierda y ajustes a la
  derecha), que en móvil es una hoja inferior. En la lista de capas, un icono fx y, debajo de cada
  capa con estilo, sus efectos plegables con un ojo para cada uno. Se abre con doble clic en la fila
  o con el icono.
- Gestión: copiar y pegar estilo (se amplía el «estilo» que ya se copiaba), ocultar o mostrar todos
  los efectos, escalar efectos (%), borrar el estilo y 6 estilos predefinidos.
- Esquema: `SESSION_VERSION` y `PROJECT_VERSION` pasan a 3. Los documentos antiguos no traen
  `style`, `crop` ni `light` y se abren tal cual (`sanitizeDoc` lo valida). Los ficheros de preset
  pasan a v3 con un `style` opcional.

## Verificación
`tsc`, `vitest` (máscaras, sanitizado y migración, luz global, ruido, límites y proporciones del
recorte, diseño de paneles), Playwright a 390 px táctil y en escritorio, capturas, y medida del coste
por fotograma con 3 capas con estilo.

---

## Estado final (2026-11-24)

Commits en `feature/efectos-recorte-paneles`: `c2b5976` (paneles), `f98c519` (recorte), `b42cc64` (motor de
efectos), `8da0293` (interfaz de efectos), y este (verificación, capturas y documentación).

### Verificación
- `npx tsc --noEmit` sin errores; `npm test`: **183 tests** (eran 148). Los tests nuevos están en
  `tests/layout.test.ts`, `tests/crop.test.ts` y `tests/layerstyle.test.ts`; `tests/motion.test.ts` cubre
  el preset v3.
- Navegador (Chrome sin cabeza + Playwright, escritorio a 1400 px y móvil táctil a 390 px), sin errores en
  consola y **sin peticiones de red**:
  - `tools/verify_panels.py`: **22/22**. Arrastre, teclado, máximo, doble clic, plegado de columnas y
    bloques, recuperación tras recargar, basura en `localStorage`, Restablecer, y la hoja inferior táctil
    sin desplazar la página.
  - `tools/verify_crop.py`: **28/28**. Asas, dibujo, movimiento, proporciones, flechas, Intro, Esc, un paso
    de historial, Restablecer, eliminar píxeles con deshacer, el plan de GIF sigue al recorte, y móvil
    táctil. **El PNG recortado es idéntico píxel a píxel a la misma zona del PNG completo**, así que el
    patrón del glitch no cambia.
  - `tools/verify_styles.py`: **26/26**. Cada efecto cambia píxeles, ruido determinista, Aceptar = un paso,
    Cancelar restaura, ojos, luz global compartida entre capas, copiar y pegar estilo, recuperación tras
    recargar, y móvil. **Vista previa = exportación (mismo tamaño): diferencia máxima 0**. El export a
    resolución completa, reducido, difiere de la vista previa en 1,37/255 de media: los efectos escalan con
    la resolución.
  - `tools/smoke_audit.py`: 12/14, igual que en la línea base de la auditoría (los 2 fallos son H-001 y
    H-002, sin arreglar aquí).
- Capturas: `docs/screenshots/70`–`79` (paneles en escritorio, plegados y en móvil; recorte en curso,
  aplicado y en móvil; diálogo de estilos y lista de efectos bajo una capa, en escritorio y en móvil).

### Rendimiento (`tools/measure_styles.py`)
Medido en **SwiftShader** (WebGL por CPU: aquí no hay GPU), con 3 capas, vista previa de 1280×960 y
esperando a que la GPU termine cada fotograma (con una lectura de píxeles):
- Sin estilos: **461 ms/fotograma**. Con 3 efectos por capa: **1119 ms/fotograma**. Primera construcción
  de los efectos: 4,7 s.
- Animar no recalcula los efectos: se construyen una vez por capa y se reutilizan
  (`__glitch.anim.state().fx.builds`). En cada fotograma solo se repiten las pasadas glitch, también sobre
  los efectos exteriores.
- **No comprobado:** el requisito de ≥ 30 fps. En este entorno ni la app sin efectos pasa de 7 fps; hay
  que medirlo con una GPU real (`python tools/measure_styles.py http://localhost:4173/`).

### Efectos y ajustes que quedaron
- **Sombra paralela:** modo de fusión, color, opacidad, ángulo, usar luz global, distancia, expansión,
  tamaño, contorno, ruido y «la capa recorta la sombra».
- **Sombra interior:** igual, con contracción y sin recorte.
- **Resplandor exterior:** modo de fusión, opacidad, ruido, color o degradado (dos colores), técnica
  suave o precisa, expansión, tamaño, contorno y rango.
- **Resplandor interior:** igual que el exterior, con origen centro o borde y contracción.
- Gestión: ojo por efecto y ojo general, copiar y pegar estilo, ocultar o mostrar todos, escalar (%),
  borrar estilo y 6 estilos predefinidos (Sombra suave, Sombra dura retro, Neón, Brillo CRT, Aberración y
  Grabado).
- No hechos: los opcionales (Trazo y Superposición de color y de degradado), «Suavizar» en los
  contornos, la fluctuación (jitter) de los degradados, el editor de curvas de contorno (solo hay 4
  curvas fijas) y los grupos de capas (circuitek no tiene grupos).

### No comprobado contra la documentación
Las páginas de ayuda de Adobe respondieron **HTTP 403** y la de Photopea (*layer-styles*) no detalla los
ajustes. Los nombres y la lista de ajustes salen de Photoshop tal como lo conozco, pero **no están
contrastados con la documentación vigente**. En concreto:
- La fórmula de **expansión / contracción**: tamaño × % de crecimiento duro + el resto de desenfoque.
- El efecto exacto del **rango**: aquí, una potencia `t^(50/rango)` antes del contorno.
- La forma de las curvas de **contorno** (Lineal, Gaussiana, Anillo, Cono).
- El **ruido** (que reduzca la opacidad del efecto píxel a píxel).
- El **origen centro** del resplandor interior.
- Los valores por defecto: opacidad del 75 %, luz a 120°, y el color #ffffbe de los resplandores.

### Decisiones
- **Efectos dentro de la capa y antes del glitch**: el glitch altera también sombras y resplandores. Los
  exteriores tienen su propia textura y se funden **sobre el fondo** con su modo (p. ej. Multiplicar),
  como en Photoshop. Precio: cada efecto exterior pasa por las pasadas glitch de su capa.
  - Limitación: la etapa JPEG / pixel sort solo se aplica al contenido de la capa, no a los efectos
    exteriores.
  - No se ofrece «aplicar glitch después».
- **Recorte = ventana de vista** sobre la imagen ya procesada: el documento se renderiza entero y se
  extrae el rectángulo. «Eliminar píxeles recortados» sí cambia el lienzo, y el patrón del glitch se
  recalcula (se avisa en la casilla).
- El ruido de los efectos usa la semilla base de la capa (`fx.seed`), no la de cada fotograma: los
  efectos no parpadean con «Movimiento» y se pueden guardar en caché.
- Con el recorte aplicado, fuera del rectángulo se ve el «fantasma» de las capas, igual que ya se veía
  lo que sobresale del lienzo.

### Qué tienes que decidir tú
1. Medir con una GPU real y, si no llega a 30 fps en móvil, elegir entre: calcular los efectos a media
   resolución (más rápido, algo más blando), limitar el cálculo al recuadro de la capa (scissor), o
   renunciar al glitch sobre los efectos exteriores (una sola pasada glitch por capa, pero entonces su
   modo de fusión solo actúa dentro de la capa).
2. Si quieres los efectos opcionales (Trazo y Superposiciones) y grupos de capas.
3. Si fuera del recorte aplicado deben verse los fantasmas de las capas o nada.
4. Si se fusiona esta rama con la de la auditoría y con `main` (no he hecho push).
