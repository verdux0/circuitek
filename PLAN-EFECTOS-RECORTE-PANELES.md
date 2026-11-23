# PLAN — paneles redimensionables, recorte y efectos de capa

Encargo: `prompt-efectos-recorte-paneles.md`. Rama `feature/efectos-recorte-paneles`, que sale de
`refactor/auditoria-circuitec` y por tanto incluye los arreglos de fuentes y de la búsqueda de GIF.
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
