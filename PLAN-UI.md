# PLAN-UI — recableado directo en el panel

## Estado actual (leído del código)
- `src/ui/rewire.ts` → `RewirePanel`: placa PCB en SVG (6 pines, cables, arrastre / toque-toque, teclado),
  lista de cables con knob de resistencia y leyenda. Vive dentro de un `.sheet-backdrop` (pop-up).
- `src/main.ts`: `new RewirePanel(host)` montado en `<body>`; se abre con `openRewire()` desde
  `#btn-rewire` (chip de la barra de controles), `#btn-pair` (resumen de cables) y `#btn-fx-rewire`
  (pestaña Efectos), y con la tecla **W**. `afterChange()` solo resincroniza si el pop-up está abierto.
- Estado: `host.state()` (= efectos de la capa activa) y `host.edit(fn, 'live'|'end'|'once')`, que ya
  gestiona deshacer/rehacer y el render.

## Cambios
1. **Un componente, dos modos.** `RewirePanel` pasa a `new RewirePanel(host, 'full' | 'compact')`.
   Misma geometría de pines, mismo arrastre/toque, mismo `connect()` (máx. 3, sin duplicados), mismo
   teclado y `aria-label`. Solo cambia el envoltorio y la lista de cables:
   - `full`: el pop-up de siempre (intro, placa grande con pistas, descripciones, knobs, leyenda).
   - `compact`: tarjeta en línea; placa recortada (sin pistas ni serigrafía), radio de pin algo mayor
     para el dedo, y por cable una fila `par · slider de resistencia · quitar`. Botón **ampliar** →
     abre el `full`.
2. **Un solo estado.** Ambos leen `host.state()` y escriben con `host.edit()`. `afterChange()` llama a
   `sync()` en los dos (el pop-up solo si está abierto) y, durante un arrastre en vivo, a un
   `syncValues()` ligero que mueve sliders/knobs sin reconstruir el DOM (así el otro modo sigue al
   instante sin romper el gesto en curso).
3. **Barra de controles reorganizada.** El mini chip sustituye a `#btn-rewire` + `#btn-pair` en
   `nav.controls` (su botón ampliar conserva `id="btn-rewire"`). La barra pasa justo debajo del visor
   (antes que Proyectos) para que en móvil el chip quede pegado a la imagen. El visor limita su alto
   para que visor + controles quepan en una pantalla de escritorio.
   `#btn-fx-rewire` (pestaña Efectos) sigue abriendo la vista ampliada.
4. **Sin capa:** el mini chip se atenúa igual que los knobs (`.no-fx-target`).

## Verificación
- `npx tsc --noEmit`, `npm test`.
- `tools/verify.py`: rutas de Chrome/fuente configurables (Windows/Linux) y nuevas comprobaciones:
  arrastre en el mini chip crea cable y cambia la imagen; el pop-up muestra el mismo cable; el
  slider compacto cambia `amount` y se refleja en el knob del pop-up; quitar cable desde el mini; layout
  sin desbordes horizontales a 390 px y controles visibles en escritorio. Capturas nuevas en
  `docs/screenshots`.
