# Prompt: efectos de capa, recorte y paneles redimensionables (circuitek)

Pégalo en Claude Code o pídele que lea este archivo y lo ejecute.

---

Implementa en circuitek (antes glitch-editor) tres mejoras de editor: **efectos de capa** (sombra, resplandor...) con el modelo de Photoshop y Photopea, una **herramienta de recorte** que define la nueva vista arrastrando un rectángulo, y **paneles redimensionables**.

## 0. Antes de empezar
1. Lee el proyecto actual (mi copia local ha evolucionado): cómo se representan las capas, cómo se compone el lienzo, dónde entra el texto, el orden del pipeline (CCD, bus, buffer, procesador, codificador), el estado serializable (`sanitizeState`, versión del esquema, presets), el historial de deshacer, la exportación (PNG/JPG/GIF/MP4) y el diseño actual de los paneles.
2. Reutiliza lo que ya existe. No crees una arquitectura paralela ni reescribas lo que funciona. Antes de añadir una librería, comprueba si lo que ya tenemos cubre la necesidad.
3. Escribe un plan corto en `PLAN-EFECTOS-RECORTE-PANELES.md` y empieza sin esperar aprobación. Haz commits pequeños y claros, una función por vez, en el orden: paneles, recorte, efectos.

## 1. Reglas comunes
- **Todo local:** sin peticiones de red en tiempo de ejecución y sin CDN.
- **Determinista y no destructivo:** el original nunca se modifica. Todo vive en el estado serializable, se guarda en proyectos y presets, y entra en el historial de deshacer. Los estados antiguos se abren sin errores (sube la versión del esquema y migra).
- **Vista previa y exportación coinciden** píxel a píxel (comprueba un fotograma de cada). La exportación a resolución completa debe escalar los efectos en píxeles con la resolución, para que se vean igual que en la vista previa.
- **Móvil primero:** viewport de 390 px y entrada táctil, además de escritorio. Objetivos táctiles grandes, foco visible, `aria-label` en español, teclado.
- **Rendimiento:** vista previa fluida (≥30 fps en la imagen de referencia) y sin crear objetos nuevos por fotograma.

## 2. Efectos de capa (modelo Photoshop / Photopea)
**Referencias** (léelas antes de diseñar; copia su *funcionamiento y su interfaz*, no su código ni sus recursos, y revisa las condiciones de uso de Photopea):
- https://www.photopea.com/learn/layer-styles
- https://helpx.adobe.com/photoshop/desktop/create-manage-layers/apply-layer-effects/layer-style-effects-and-options-overview.html
- Si quieres comparar el comportamiento real, abre Photopea en el navegador y prueba cada efecto con una capa de texto y una de imagen con transparencia.

**Comportamiento a reproducir:**
1. Los efectos son **estilos adjuntos a la capa**: no modifican su contenido, se vuelven a dibujar solos cuando la capa cambia (mover, editar el texto, cambiar la fuente...) y se pueden activar o desactivar en cualquier momento. Sirven para capas de imagen, de texto y grupos, si el proyecto los tiene.
2. **Interfaz:** doble clic en la capa (fuera del nombre y la miniatura) o un icono "fx" en la lista de capas abre un diálogo "Estilo de capa". Una lista de efectos con casilla de activación a la izquierda y los ajustes del efecto seleccionado a la derecha. Bajo cada capa con estilos, la lista de sus efectos, plegable, con el ojo para mostrar u ocultar cada uno. En móvil, el diálogo se convierte en una hoja inferior.
3. **Efectos obligatorios**, con los nombres y ajustes de Photoshop:
   - **Sombra paralela (Drop Shadow):** modo de fusión, color, opacidad, ángulo, *usar luz global*, distancia, expansión (spread), tamaño, contorno, ruido y "la capa recorta la sombra" (knockout).
   - **Resplandor exterior (Outer Glow):** modo de fusión, opacidad, ruido, color o degradado, técnica (suave o precisa), expansión, tamaño, rango.
   - **Sombra interior (Inner Shadow):** como la paralela, pero con *contracción* (choke) en lugar de expansión.
   - **Resplandor interior (Inner Glow):** como el exterior, con origen *centro* o *borde* y contracción.
   - Los nombres y la lista exacta de ajustes de cada efecto, compruébalos en la documentación vigente y marca como "no comprobado" lo que no puedas verificar.
4. **Semántica de los ajustes** (como en Photoshop): la *expansión* ensancha el borde de la máscara antes de difuminarla y la *contracción* lo reduce; el *tamaño* es el radio del desenfoque; el *ruido* se aplica solo al efecto, no a toda la capa, y evita bandas; la **luz global** comparte un único ángulo entre todos los efectos que lo usan, de modo que cambiarlo en uno lo cambia en todos los estilos que la tengan activada.
5. **Orden de dibujado como en Photoshop:** sombra paralela y resplandor exterior debajo del contenido de la capa; sombra interior y resplandor interior sobre el contenido y recortados a su forma.
6. **Funciones de gestión:** copiar y pegar estilos entre capas, mostrar u ocultar todos los efectos, escalar efectos (por ejemplo, 200 %) y borrar el estilo de la capa. Estilos predefinidos: 4-6 de fábrica, como "Neón" o "Sombra suave", pensados para el aspecto glitch.
7. **Opcional (segunda fase, solo si todo lo anterior está verificado):** Trazo, Superposición de color y de degradado.

**Implementación:**
- Calcula la máscara a partir del canal alfa de la capa. Usa desenfoque gaussiano separable en WebGL2 con pasadas ping-pong, y reutiliza la infraestructura de framebuffers del renderer.
- Cachea el resultado por capa y recalcula solo si cambian el contenido de la capa o los ajustes del estilo.
- El ruido sale del PRNG con seed del proyecto, nunca de `Math.random()`.
- **Decide y justifica, en el plan, dónde entran los efectos respecto al pipeline glitch.** Mi propuesta por defecto: los efectos forman parte de la composición de cada capa y se calculan antes del pipeline glitch, así que el glitch también altera sombras y resplandores. Ofrece una casilla "aplicar glitch después" solo si resulta barato.

## 3. Herramienta de recorte (modelo Photoshop)
**Referencia:** https://helpx.adobe.com/photoshop/how-to/cropping-photo-basics.html

**Comportamiento:**
1. Con la herramienta activa, el usuario **arrastra un rectángulo** sobre la imagen. Ese rectángulo será la nueva vista. Aparece con asas en las esquinas y los lados, y el área fuera del rectángulo se oscurece (el "escudo"). Si arrastra dentro del rectángulo, lo mueve. Si arrastra un asa, lo redimensiona.
2. **Proporciones:** libre, original, 1:1, 4:5, 3:2, 16:9, 9:16 y personalizada. Con proporción libre, mantener Mayús al arrastrar una esquina conserva las proporciones. Campos de ancho y alto en píxeles. Superposición de regla de tercios, con opción para ocultarla.
3. **Confirmar y cancelar:** Intro y un botón ✓ aplican; Esc y un botón ✕ cancelan. Hay también un botón "Restablecer recorte".
4. **No destructivo:** el recorte es un rectángulo guardado en el estado (en coordenadas normalizadas, para que sea independiente de la resolución). El original no se toca y se puede reabrir la herramienta para reajustarlo. Si el usuario recorta pensando en descartar, ofrece una casilla "eliminar píxeles recortados" desactivada por defecto.
5. **Pipeline:** por defecto, el recorte es una **ventana de vista sobre la imagen ya procesada**: el patrón de glitch no cambia al recortar. Comprueba que el resultado determinista no varía y documenta la decisión. La vista previa, la miniatura y la exportación (PNG, JPG, GIF, MP4) usan el recorte, a resolución completa.
6. **Compatibilidad:** funciona con imágenes, GIF y vídeo (el mismo recorte para todos los fotogramas), con capas, texto y efectos que queden en parte fuera del recorte, y con el modo Movimiento si existe.
7. **Táctil y teclado:** arrastre y asas con `pointer events`, zona de agarre mínima de 44 px, y flechas para mover el rectángulo (Mayús para pasos mayores). Tamaño mínimo del rectángulo y límites dentro de la imagen.
8. Entra en el historial de deshacer (un paso por recorte aplicado, no uno por movimiento del ratón).

## 4. Paneles redimensionables
1. Todos los paneles principales (biblioteca y capas, ajustes de los knobs, rewire/chip, galería y la barra inferior) se pueden **estirar arrastrando el borde** que los separa del visor. Sin ventanas emergentes.
2. Tamaños mínimo y máximo por panel, doble clic en el separador para restablecer, y un botón de restablecer todo el diseño. Se puede **plegar** un panel arrastrando hasta el mínimo o con un botón.
3. **Persistencia:** guarda el diseño en `localStorage` con `try/catch` (puede venir vacío o lanzar excepciones) y valida los valores guardados para que una pantalla distinta no los deje fuera de rango.
4. **Accesibilidad:** cada separador con `role="separator"`, `aria-orientation`, `aria-valuenow/min/max`, foco visible y ajuste con flechas (Mayús para pasos mayores).
5. **Móvil:** en 390 px los paneles pasan a hojas inferiores con un asa para arrastrar su altura. Entrada táctil con `pointer events` y `touch-action` correcto para que no desplace la página.
6. **El visor y el canvas WebGL** se redimensionan con `ResizeObserver` y `devicePixelRatio`, sin deformar la imagen ni perder la posición del recorte. Throttle con `requestAnimationFrame` para no recalcular en cada píxel de arrastre.
7. Implementa los separadores tú mismo con CSS grid y `pointer events`. Si valoras una librería de divisores, justifica por qué y qué pesa.

## 5. Verificación (no des el trabajo por terminado sin esto)
- `npx tsc --noEmit` y `npm test` sin errores. Tests unitarios: migración de esquemas, serialización de estilos y recorte, matemática de la máscara (expansión y contracción), luz global, determinismo del ruido, límites del rectángulo de recorte y proporciones.
- Playwright con viewport de 390 px (táctil) y de escritorio: crea un estilo con cada efecto y comprueba que cambia píxeles; que la vista previa y la exportación coinciden en un fotograma; que el arrastre del recorte, las asas, Intro y Esc funcionan; que los paneles se estiran, se pliegan, se restablecen y se recuperan tras recargar; sin errores en consola y **sin peticiones de red**.
- Capturas de pantalla de: diálogo de estilos, lista de efectos bajo una capa, recorte en curso, y los paneles en ambos tamaños.
- Mide el coste por fotograma de los efectos con 3 capas con estilos, y dime qué no has podido comprobar.

## 6. Informe final
Archivos creados y modificados, qué efectos y ajustes quedaron (y cuáles no comprobados), las decisiones tomadas (dónde entran los efectos en el pipeline, cómo se aplica el recorte), mediciones de rendimiento, problemas y qué tengo que decidir yo.
