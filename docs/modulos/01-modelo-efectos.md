# 01 · Modelo de efectos, presets y movimiento

## 1. Propósito y responsabilidad

Define **qué es un ajuste glitch**, `GlitchState`: los pines del CCD simulado, los 15 pares de pines
(cada uno es un modo del shader), las 4 etapas extra con sus parámetros y el bloque «Movimiento».
También lo valida, lo convierte en un **plan de pasadas de GPU** y genera presets, estados aleatorios
y variantes de forma **determinista** (misma semilla, mismo resultado). Es lógica pura: sin DOM y
sin GPU.

## 2. Archivos y componentes clave

| Archivo | Contenido |
|---|---|
| `src/model.ts` | `PINS`, `PIN_INFO`, `PAIRS` (15 pares → `mode` del shader), `STAGES` (bus, buffer, proc, enc), `GlitchState`, `defaultState`, `sanitizeState`, `sanitizeMotion`, `stageActive` / `stageAlters`, `buildGpuPasses`, `encParams`, `encSeed`, `PresetFile` |
| `src/presets.ts` | `FACTORY_PRESETS` (26 presets), `randomState(seed)`, `variantOf(base, seed)` |
| `src/prng.ts` | `mulberry32`, `randInt`, `pick`, `mixSeed` (deriva subsemillas), `freshSeed` (el único sitio no determinista: el dado de la UI) |
| `src/motion.ts` | `stateAtFrame(base, frame, loopFrames, animate, out?)`: el estado del fotograma N; `paramAt`, `clampParam`, `driftCycles`, `jumpHold` |

## 3. Flujo de funcionamiento

1. La UI edita un `GlitchState` (el `fx` de la capa activa) a través de `main.ts` (`edit`, ver doc 10).
2. Todo lo que entra de fuera (sesión, proyecto, preset, `.glitch`, API de depuración) pasa por
   `sanitizeState` (`src/model.ts:249-289`): descarta claves desconocidas, recorta rangos, quita
   cables repetidos o inválidos (máx. `MAX_CABLES = 3`) y solo deja encendida una etapa si de
   verdad altera la imagen (`stageAlters`).
3. Para renderizar, el renderer pide `stateAtFrame` (con la animación parada devuelve el estado
   base) y lo convierte con `buildGpuPasses` (`src/model.ts:347-369`) en pasadas: una por cable
   (`pass 0`, `mode` = par) y una por etapa activa de bus (1), buffer (2) y procesador (3).
4. La etapa del codificador no es de GPU: `encParams` (`src/model.ts:380-384`) da sus parámetros al
   worker (doc 04).
5. «Movimiento» (`src/motion.ts:247-287`): para el fotograma `i` de un bucle de `n`, cada parámetro
   marcado se calcula con `paramAt` según el modo (Parpadeo = ruido por fotograma; Deriva = senos
   con un número entero de ciclos, así el bucle cierra; Saltos = valores que se mantienen `H`
   fotogramas). La vista previa y los exports usan la misma función.

## 4. Dependencias

- **Salientes:** `model.ts` → `prng.ts`; `motion.ts` → `model.ts`, `prng.ts`, `media/timing.ts`
  (`frameSeed`); `presets.ts` → `model.ts`, `prng.ts`.
- **Entrantes:** `doc.ts` (`sanitizeState` en `sanitizeDoc`), `gl/renderer.ts` (`buildGpuPasses`,
  `encParams`, `stateAtFrame`), `engine.ts`, `main.ts`, `ui/rewire.ts`, `ui/stages.ts`,
  `export/exporter.ts`, `tests/core.test.ts`, `tests/motion.test.ts`.

## 5. Contratos públicos

- `GlitchState` (`src/model.ts:179-190`): `{ v: 2, seed, effect 0..100, filter 0..100, cables: Cable[≤3], stages: Record<StageId, {on, p}>, motion: Motion }`.
- `PresetFile` (`src/model.ts:311-317`): `{ app: 'circuitek', version: 2, name, state }`. `parsePresetFile` también acepta un estado suelto y los ficheros v1.
- `GpuPass` (`src/model.ts:332-340`): `{ pass 0|1|2|3, mode, amt, filter, p: vec4, seed }`, el contrato con los uniforms del shader.
- `stateAtFrame(base, frame, loopFrames, animate, out?)`: con `frame === undefined` o `animate === false` devuelve **la misma referencia** `base`; si no, rellena `out` y lo reutiliza (cero asignaciones por fotograma, `src/motion.ts:241-246`).

## 6. Reglas de negocio e invariantes

- **Determinismo:** todo el azar sale de `mulberry32(seed)` / `mixSeed` (CPU) y de hashes enteros en
  GPU (`src/gl/shaders.ts:1-9`). Las sales `101`–`104` (`src/model.ts:358-387`) y las de
  `motion.ts` (`SALT_*`, `src/motion.ts:25-31`) **forman parte del formato**: cambiarlas cambia el
  aspecto de todos los proyectos guardados (H-023).
- Intensidad de un cable: `effect/100 × amount/100 × 1,5` (`cableAmount`, `src/model.ts:343-345`). Con 0, la salida es igual a la entrada.
- Una etapa solo está «activa» si está encendida **y** sus parámetros alteran la imagen (`stageActive`, `src/model.ts:217-219`).
- Los presets y el aleatorio pasan por `engageStages` + `sanitizeState`, así que siempre son estados válidos.
- `motionFrames(m) = max(2, round(seconds × fps))`; las `fps` permitidas (`MOTION_FPS`) son exactas en centésimas, para que el GIF coincida con la vista previa.

## 7. Configuración

Ninguna variable de entorno. Constantes: `MAX_CABLES = 3`, `MOTION_FPS`, `MOTION_SECONDS`,
`FLICKER_SCALE = 0.4`, `RANDOM_RANGES` (`src/presets.ts:66-71`).

## 8. Pruebas existentes y huecos

- `tests/core.test.ts` (20 tests): PRNG, sanitizado, plan de pasadas, presets, aleatorio, variantes, historial, bytes del codificador.
- `tests/motion.test.ts` (16 tests): bucles que cierran, rangos y pasos, cero asignaciones.
- Huecos: ninguno importante en este módulo.

## 9. Observaciones técnicas

- H-010: `STAGES.find(...)!` y clonados JSON repetidos en `presets.ts` y `motion.ts` en lugar de `stageDef` / `cloneState`.
- H-017 (descartado): `parsePresetFile(null)` lanza, pero quien llama lo gestiona.
- H-021: el JSDoc de `paramAt` está encima de `FLICKER_SCALE` (`src/motion.ts:52-56`).
- H-023: sales y números de pasada sin nombre.
- H-028: el rango de la semilla en la UI (≤ 999 999) no coincide con el del modelo (≤ 2³²−1).
