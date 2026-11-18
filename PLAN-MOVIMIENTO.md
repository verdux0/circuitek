# PLAN-MOVIMIENTO — ver la animación en el editor (paso 1) y modo Movimiento (paso 2)

## Lo que ya hay (leído del código)
- El ruido por fotograma se calcula en **un solo sitio**: `GLRenderer.frameFx` (`frameSeed(seed, noise)` si la capa tiene
  «Glitch animado»). La exportación llega ahí por el mismo provider (`SourceRef.noise = i`). En la vista previa de una
  imagen fija nadie pone `noise`, por eso no se mueve.
- **Lógica duplicada:** la exportación tiene su propia oscilación (`pulseEffect`, «pulso del EFFECT»), aparte del ruido.
- La barra de vídeo/GIF (▶, ±1 fotograma, tiempo, velocidad) trabaja sobre la interfaz `MediaPlayer`.
- Sin librerías nuevas: `mixSeed`/`frameSeed` (prng/timing), el renderer y el exportador cubren todo.

## Una sola función
`stateAtFrame(base, frame, loopFrames, animate, out)` en `src/motion.ts` (pura, con tests): devuelve el estado del
fotograma N. La usan el renderer (vista previa y exportación, vía `SourceRef.noise`/`loop`) y los knobs que giran solos.
`frameFx` pasa a llamarla. En el paso 2 desaparece `pulseEffect`.

## Paso 1 — ▶/■ en el editor (commit propio)
- `AnimClock` (`src/media/animclock.ts`) implementa la interfaz de los reproductores y **reutiliza la barra de vídeo**:
  ▶/■ (■ = parar y volver al estado base), ±1 fotograma, tiempo y velocidad. Aparece cuando una capa fija tiene
  «Glitch animado». Por defecto está en ■ y nunca arranca sola.
- Con `prefers-reduced-motion`, ▶ avisa y no arranca. Solo un segundo ▶ en menos de 5 s (consentimiento explícito)
  la reproduce.
- Bucle `requestAnimationFrame` con paso fijo (`1000/fps`): acumula tiempo, avanza los fotogramas debidos y pinta
  **solo el último** (descarta los atrasados). Se pausa con `visibilitychange`. El tick es una función ya ligada que
  no crea objetos. `stateAtFrame` escribe en un estado reutilizado por capa.
- Nada pasa por `edit`/historial: el fotograma solo existe en el render. Al parar, `noise` vuelve a `undefined`, que
  es exactamente el estado base.
- **Codificador (JPEG/sort) a su ritmo:** con la animación en marcha, el GPU dibuja en una textura aparte y el
  codificador lee de ella; en pantalla se mantiene el último resultado codificado hasta que llega el siguiente. La
  animación no se bloquea ni parpadea entre fotogramas con y sin codificador. Se mide el coste por etapa
  (render GPU, codificador) con un gancho de pruebas.
- Prueba: el lienzo del editor en el fotograma N y el fotograma N de la exportación, píxel a píxel (Playwright).

## Paso 2 — modo Movimiento (commit propio)
- `GlitchState.v = 2` con `motion: { mode: 'flicker'|'drift'|'jumps', intensity, speed, targets, seconds, fps }`.
  `sanitizeState` acepta v1 (sin `motion` → valores por defecto); los presets lo guardan solos (guardan el estado).
- **Parpadeo** = el ruido de ahora. **Deriva suave:** `base + A·sin(2π·k·i/N + φ)` con *k* ciclos enteros (1-4 según
  la velocidad) y φ por seed y parámetro → periódico con N. **Saltos:** bloques de H fotogramas (H según la
  velocidad); en cada bloque, con ruido por seed, algunos parámetros saltan a un valor cercano y se mantienen.
- Qué se anima (casillas): EFFECT y FILTER por defecto, más resistencia de los cables y knobs de las etapas.
  Siempre se recorta al rango y al paso de cada knob.
- Los knobs de la interfaz muestran el valor del fotograma (salvo el que el usuario está arrastrando). Mover un
  knob durante ▶ cambia el **base** (edición normal, una entrada de historial) y la animación sigue alrededor.
- Exportar GIF/MP4 de una animación generada: N = segundos × fps del movimiento (por defecto), mismo
  `stateAtFrame` → bucle perfecto. El diálogo ya muestra la estimación de peso y fotogramas, el progreso y Cancelar.
  Se elimina el «pulso» duplicado.
- Tests: determinismo, recorte al rango, periodicidad de la deriva, saltos que se mantienen, migración v1 → v2, y vista
  previa = exportación (Playwright, 390 px táctil).
