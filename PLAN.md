# PLAN — glitch-editor

## Arquitectura

```
index.html ── src/main.ts (controlador UI, estado, historial, atajos)
                │
                ├── src/model.ts      pines, 15 pares, etapas, estado serializable, plan de render
                ├── src/presets.ts    presets de fábrica, aleatorio, variantes (deterministas)
                ├── src/history.ts    deshacer / rehacer
                ├── src/engine.ts     orquesta preview / miniaturas / export
                │     ├── src/gl/renderer.ts   WebGL2, ping-pong de framebuffers
                │     │     └── src/gl/shaders.ts   shader "uber": CCD, bus, buffer, DSP
                │     └── src/encoder/client.ts → worker.ts (Web Worker)
                │           └── src/encoder/bytes.ts  corrupción JPEG + pixel sort (puro)
                └── src/ui/  knob.ts · rewire.ts (PCB) · stages.ts (módulos)
```

Cadena de señal (orden fijo):
`imagen → cable 1 → cable 2 → cable 3 → bus/ADC → buffer → procesador → codificador JPEG → pantalla`

- Las etapas GPU son pasadas de un mismo shader; cada una lee la textura de la anterior.
- El codificador trabaja con bytes reales en un Worker (fuera del hilo principal).
- Todo el azar sale de `hash(seed, índice de línea/bloque)` en GPU y de `mulberry32(seed)` en CPU,
  así que el resultado es determinista.
- Las líneas se cuentan en un raster virtual de 1080 líneas, no en píxeles reales: la vista previa
  (≤1280 px), las miniaturas (≤320 px) y el export a resolución completa se ven igual.

## Los 15 modos (par → algoritmo → explicación eléctrica)

| Par | Nombre | Algoritmo | Equivalente eléctrico | FILTER |
|---|---|---|---|---|
| SUB+RG | Overflow de ganancia | ganancia ×(1+6a); el tono se cuantiza en bandas; los valores >1 vuelven a 0 (`fract`) | el bias dispara la ganancia y el ADC desborda | nº de bandas |
| SUB+OD | Split por exposición | R y B se desplazan en direcciones opuestas, proporcional al brillo local | la carga del sustrato se filtra al drenaje | dirección |
| SUB+TG | Fase solar | tono = f(luminancia) → solarizado arcoíris | la ganancia modula la fase de transferencia | desfase de tono |
| SUB+AB | Quemado mono | luminancia ×ganancia, plegada (onda triangular) + líneas invertidas | sin anti-bloom, el sustrato satura | punto de pliegue |
| SUB+HCLK | Arrastre de línea | máximo decreciente de 18 muestras a la izquierda + ganancia por línea | la ganancia entra en el reloj horizontal | longitud de la estela |
| RG+OD | Poster partido | posterizado por canal con niveles distintos + offset vertical de R/B | el reset vacía el drenaje antes de tiempo | niveles |
| RG+TG | Franjas de tono | bandas horizontales con el tono rotado y saturado; alguna invertida | reset y transferencia se pisan | nº de franjas |
| RG+AB | Duotono fantasma | luminancia + fantasma lateral, cuantizada a 2-5 niveles, mapeada a dos tintas | el reset descarga en el anti-bloom | tinta |
| RG+HCLK | Desgarro de bloques | bloques de líneas desplazados, posterizados y con canales cruzados | pulsos de reset fuera de reloj | altura de bloque |
| OD+TG | Error de fase NTSC | YIQ: los ejes IQ giran en una onda senoidal y se adelantan a Y | ruido en la fase de transferencia | frecuencia |
| OD+AB | Caída de canal | por bandas: falta un canal, se duplica R o se rotan; color atenuado | drenajes puenteados | altura de banda |
| OD+HCLK | Jitter RGB | desplazamiento horizontal independiente por canal y línea, con picos | el reloj tiembla distinto en cada canal | densidad de líneas |
| TG+AB | Croma de bordes | Sobel: solo los bordes tienen color, con el tono según su orientación | sin color y con la fase suelta | grosor |
| TG+HCLK | Ondulación de sync | desplazamiento senoidal por línea; R/G/B con amplitudes distintas; tono sigue a la onda | la transferencia modula el reloj de línea | frecuencia |
| AB+HCLK | Sync perdido | cizalla + enrollado vertical, mono verdoso, barra y pulso de sync visibles | el monitor pierde el HSYNC | deriva vertical |

`a = EFFECT/100 × RESIST./100 × 1,5` y `f = FILTER/100`. Con a = 0 la salida es idéntica a la entrada.

## Etapas extra

| Etapa | Parámetros | Implementación |
|---|---|---|
| Bus/ADC | BITS, RUIDO, ROTAR, CANAL | máscara de bits, XOR por bandas, rotación de bits, permutación RGB (enteros en GLSL) |
| Buffer | STRIDE, OVERFLOW, ECO | re-indexado lineal con ancho erróneo, líneas atascadas, eco en modo pantalla |
| Procesador | BAYER, SANGRADO, POSTER, SATUR. | desalineado de demosaico + zipper, desenfoque de croma YIQ, posterizado, saturación desbordada |
| Codificador | CORRUP., CALIDAD, GENER., SORT, TRAMO, DIREC. | JPEG real por franjas (10 "restart intervals") con bytes corruptos; pixel sort por intervalos |

## Orden de construcción
1. Esqueleto: Vite+TS, renderer WebGL2, importar, exportar ✔
2. Los 15 modos + multicable ✔
3. Etapas GPU + codificador en worker ✔
4. UI: knobs, PCB Rewire, módulos, galería, presets, variantes, A/B, deshacer ✔
5. Tests unitarios + verificación E2E en Chrome headless con hojas de contacto ✔
