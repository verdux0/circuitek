# Buenas prácticas de diseño: guía, auditoría y cambios

## Fuentes de referencia
- **WCAG 2.2** (W3C, Recomendación del 12-12-2024): https://www.w3.org/TR/WCAG22/ — criterios medibles de nivel AA.
- **10 heurísticas de usabilidad**, Nielsen Norman Group: https://www.nngroup.com/articles/ten-usability-heuristics/ —
  criterios de revisión de la interfaz (estado visible, coherencia, reconocer antes que recordar, diseño minimalista…).

## Cómo se comprueba
`tools/audit_design.py` recorre toda la página (con una imagen, una capa de texto y la lista de fuentes abierta) en
escritorio 1400 px y móvil 390 px, tema claro y oscuro, y mide:

| Criterio | Regla |
|---|---|
| 1.4.3 Contraste (mínimo) | texto ≥ 4,5:1; texto grande (24 px, o 18,66 px en negrita) ≥ 3:1. Se compone el fondo real, incluidos los degradados (cuenta el peor color). |
| 1.4.11 Contraste no textual | borde de los campos ≥ 3:1 frente a lo que los rodea |
| 2.5.8 Tamaño del objetivo (mínimo) | ≥ 24 × 24 px, salvo la excepción de espaciado y los enlaces dentro de un texto |
| 4.1.2 Nombre, función, valor | todo control tiene nombre accesible |
| 1.4.10 Reflujo | sin desplazamiento horizontal a 320 px |
| 2.4.7 Foco visible | al enfocar con teclado cambia el contorno o la sombra |
| Legibilidad (no es WCAG) | ningún texto por debajo de 11 px |

```
npm run build && npx vite preview --port 4173
python tools/audit_design.py http://localhost:4173/     # código 1 si falla algún criterio WCAG
```

## Resultado
Problemas distintos encontrados (cada uno se repetía en varias filas o modos):

| Criterio | Antes | Después |
|---|---|---|
| 1.4.3 contraste de texto | 19 elementos: texto secundario `--ink-soft` en claro (3,3-4,2:1), botón Exportar blanco sobre naranja claro (2,6:1), pestaña inactiva (2,2:1), estrellas de favoritas, fila marcada de la lista en oscuro (1,2:1) | 0 |
| 1.4.11 bordes de campo | todos los campos en oscuro (1,3:1: borde casi negro sobre panel oscuro) | 0 |
| 2.5.8 objetivos | títulos plegables «Texto» y «Transformar y mezclar» (21 px de alto) | 0 |
| 2.4.7 foco visible | pines del chip CCD (`outline: none` sin sustituto) | 0 |
| 4.1.2 nombres | 0 | 0 |
| 1.4.10 reflujo a 320 px | correcto | correcto |
| texto < 11 px | 13 tipos de rótulo (9,5-10 px) | 0 |

## Cambios aplicados (sencillos y sin rediseñar la identidad visual)
- **Lista de fuentes desplegable** (heurística 8, diseño minimalista): cerrada ocupa una fila de 40 px y muestra la
  fuente actual escrita con ella misma. Al abrirla aparecen el buscador, las categorías y la lista. Clic o ↑ ↓ siguen
  aplicando en directo. Con la lista cerrada, ↑ ↓ cambian de fuente como un `select`. Esc la cierra y devuelve el
  foco; un clic fuera también la cierra. `aria-expanded` refleja el estado.
- `--ink-soft` (claro) `#6e6c66` → `#57554f`: ≥ 4,5:1 en todas las superficies claras.
- Botones de acción principal (Exportar…): degradado `#ca400d → #b3330a` (blanco ≥ 5:1). El naranja de acento se
  mantiene en iconos, contornos de foco y estados.
- Pestañas Capas / Efectos: texto inactivo a `--ink` y la activa con **subrayado de acento** además del relieve; antes,
  en oscuro, no se distinguía cuál estaba activa (heurística 1, estado visible). Altura de 32 a 36 px.
- Bordes de campo en oscuro: `#85838a` (≥ 3:1).
- Rótulos de 9,5-10 px a 11 px (propiedades, knobs, cables, «Efectos de»).
- Títulos plegables con `min-height: 28px`; contorno de foco de 3 px también en `summary`, pestañas y pines del chip
  (el pin enfocado además se agranda y se resalta).
- Botones «Fuentes del equipo» y «Cargar fuente…» con texto, no solo icono (heurística 6, reconocer antes que
  recordar).
- Estrellas de favoritas y nombre de la capa objetivo con colores oscurecidos / aclarados según el tema.

## Revisión con las heurísticas (lo que no se ha cambiado)
- **Botones de transformación de capa** (rotar, voltear, ajustar…): solo icono, pero con `aria-label` y `title`; se
  dejan así por espacio (12 acciones). Si se quisiera más claridad, un menú «Transformar ▾» sería el siguiente paso.
- **Panel de efectos**: estética de hardware (knobs, chip) deliberada; cumple contraste y foco, no se ha tocado.
- **Ayuda en contexto** (heurística 10): existen los atajos y las pistas bajo cada bloque; no se ha añadido más.

## Qué no se ha comprobado
- Lectores de pantalla reales (NVDA, VoiceOver): solo nombres y roles por código.
- Zoom del navegador al 200 % (1.4.4) más allá del reflujo a 320 px.
- Safari y Firefox.
