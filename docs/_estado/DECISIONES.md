# Decisiones de la auditoría

Registro de decisiones tomadas durante la auditoría y la refactorización, con su motivo.
Formato: `D-NNN · fecha · decisión · motivo`.

## D-001 · 2026-11-23 · Trabajo autónomo con la opción más segura

El responsable del proyecto pidió ejecutar todas las fases sin estar conectado y «eligiendo las
respuestas más seguras». En consecuencia:

- El punto de control de la Fase 3 se resuelve sin esperar aprobación, pero **solo se ejecutan las
  tareas marcadas como «seguras de automatizar»** en `docs/02-hoja-de-ruta.md`. Las que piden una
  decisión de arquitectura o de producto quedan **pospuestas** y documentadas para revisión.
- Nada sale del equipo: no hay `git push`, ni PR, ni cambios en servicios externos. Los commits son
  locales, en la rama `refactor/auditoria-circuitec`.
- Cada cambio se verifica con `tsc --noEmit`, `vitest`, `vite build` y la prueba de humo en navegador
  antes de hacer commit. Si algo falla, se corrige o se revierte.

## D-002 · 2026-11-23 · Nombre del proyecto

El encargo habla de «Circuitec». El repositorio se llama `glitch-editor` y la app `circuitek`
(`package.json:2`). Se entiende que son el mismo proyecto. La rama usa el nombre pedido
(`refactor/auditoria-circuitec`) y los documentos usan el nombre real, `circuitek`.

## D-003 · 2026-11-23 · Línea base E2E sustituida por una prueba de humo

`tools/verify.py` (la verificación E2E del repositorio) falla en la línea base: espera el elemento
`#tab-fx`, que desapareció con el rediseño de la UI (commits `08cb14e`…`02dc64d`). Arreglar esa suite
es una tarea grande (hallazgo H-032, pospuesto). Como red de seguridad en navegador se usa una prueba
de humo nueva, `tools/smoke_audit.py` (Chrome sin cabeza + Playwright, sobre la UI actual y la API
de depuración `window.__glitch`). En la línea base da 12/14: los 2 fallos son los hallazgos de
seguridad H-001 y H-002.

## D-004 · 2026-11-23 · Sin herramienta de cobertura

No hay `@vitest/coverage-*` en las dependencias. Instalarla cambiaría `package.json` y el lockfile
solo para medir, así que no se instala. La cobertura se estima por módulo (qué archivos importan
los tests), y se indica así en los informes.

## D-005 · 2026-11-23 · Dependencias sin actualizar

`npm audit` no encuentra vulnerabilidades. Las actualizaciones disponibles son menores (konva, lucide,
mediabunny, vitest) o un salto mayor (vite 6 → 8). Ninguna arregla un problema detectado, así que no
se actualiza nada (hallazgo H-026, pospuesto): cambiar dependencias es un cambio de comportamiento
que no pide ningún hallazgo.

## D-006 · 2026-11-23 · `main.ts` no se divide en esta pasada

`src/main.ts` (2277 líneas) concentra demasiadas responsabilidades (H-014). Dividirlo es la mejora
estructural de más valor, pero también la de más riesgo: el orden de inicialización del módulo es
significativo y la suite E2E que lo cubriría está rota (H-032). Se documenta un plan por etapas en
la hoja de ruta y se pospone hasta tener una E2E fiable.

## D-007 · 2026-11-23 · La API de depuración `window.__glitch` se mantiene

La API expone funciones destructivas (`clearProjects`, `setDoc`…) también en producción (H-015). Las
herramientas de verificación la usan contra el build de producción (`vite preview`), así que
quitarla o ocultarla tras `import.meta.env.DEV` rompería esas herramientas. Es una decisión de
producto: se pospone y se propone una alternativa en la hoja de ruta.
