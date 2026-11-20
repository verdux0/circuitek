# Referencia de interfaz: Photopea → Glitch

Documento de investigación para rediseñar la interfaz de Glitch con el layout de Photopea.
Destinatario: Claude Code (Opus). Todo lo que sigue se midió o se vio el 2026-11-20 en photopea.com (interfaz en español, viewport emulado 1440×900 y 375×812).

**Etiquetas usadas**
- `[VERIFICADO]`: medido en el DOM de Photopea o visible en una captura de esta carpeta.
- `[NO VERIFICADO]`: no se pudo comprobar; se deja como pendiente, no como hecho.
- `[PROPUESTA]`: recomendación para Glitch, no algo que Photopea haga.

**Alcance de este trabajo:** solo el cambio visual y de estructura de la UI. No se cambia la lógica de efectos, capas ni exportación.

**Límite de las capturas:** salen a 800×500 (escritorio) y 375×812 (móvil). Valen para layout y jerarquía, no para copiar píxeles. Los números exactos están en las tablas de medidas.

---

## 1. Layout general `[VERIFICADO]`

Ver `screenshots/01-desktop-layout-general.jpg`.

```
┌──────────────────────────────────────────────────────────────┐
│ Barra de menús (33 px): Archivo Editar Imagen Capa ...        │
├──────────────────────────────────────────────────────────────┤
│ Barra de opciones (32 px): cambia según la herramienta activa │
├────┬─────────────────────────────────────┬───┬───────────────┤
│Herr│ [pestaña del documento ×]  (34 px)  │ I │ Historial     │
│38px│                                     │ c │ Muestras  ≡   │
│    │      CANVAS (fondo #252525)         │ o ├───────────────┤
│    │      documento centrado             │ n │ Capas  Canales│
│    │                                     │ o │ Normal ▾      │
│    │                                     │ s │ Opacidad 100% │
│    │                                     │   │ ▢ Background  │
│    │                                     │39 │ ...           │
│    │                                     │px │ [botones]     │
└────┴─────────────────────────────────────┴───┴───────────────┘
```

Estructura DOM real (nombres de clase de Photopea, solo como referencia para entender el modelo):

| Zona | Posición y tamaño (px, a 1440×900) |
|---|---|
| Barra de menús (`.topbar`) | y 0, alto 33 |
| Barra de opciones (`.confbar` / `.toolconf`) | y 33, alto 32. Los primeros 44 px son el icono de la herramienta; el resto es el cuerpo de opciones |
| Fila principal (`.flexrow`) | y 63 hasta el final (alto 836) |
| Barra de herramientas (`.sbar.toolbar`) | x 0, ancho 38 |
| Área del canvas (`.panelblock.mainblock`) | x 38, ancho 771. Cabecera 34 px (pestañas de documento) y cuerpo `#252525` |
| Columna derecha (`.rightbar`) | x 809, ancho 311 |
| ↳ Columna de iconos (`.vcolumn`, 1ª) | ancho 39. Un icono por panel |
| ↳ Columna de paneles (`.vcolumn`, 2ª) | ancho 272 (268 de contenido). Es redimensionable: el cursor es `ew-resize` |
| Columna de anuncios | x 1120, ancho 320. **No se copia** |

**Jerarquía de la columna de paneles** (importante para la arquitectura futura):

```
rightbar
 └─ vcolumn            ← columna (ancho redimensionable, tiene una tira superior de 11 px con "< >" / "> <"; se infiere que sirve para colapsar, no se probó el clic)
     └─ cont
         └─ panelblock ← bloque apilado verticalmente (alto propio)
             └─ block
                 ├─ panelhead  ← pestañas de panel (Historial | Muestras) + botón ≡ de menú del panel
                 └─ body       ← contenido del panel activo
```

En la captura hay 2 bloques apilados: Historial/Muestras (alto 190) y Capas/Canales/Trazados (alto 631). Es decir: **columna → bloques → pestañas → panel**.

## 2. Estilo visual `[VERIFICADO]`

Valores leídos del CSS calculado. Úsalos como variables (design tokens), no como números sueltos.

| Token | Valor |
|---|---|
| Fuente | `"Open Sans", "Segoe UI", sans-serif`, 13 px |
| Fondo de la app / botones / pestaña activa | `#474747` |
| Fondo de cabeceras de panel, cuerpo de panel y canvas | `#252525` |
| Texto | `#d5d5d5` |
| Herramienta activa | fondo `#5d5d5d`, esquinas derechas redondeadas (0 6 6 0) y barra azul a la izquierda |
| Elemento de lista seleccionado | `rgba(0,0,0,.25)` sobre el fondo del panel |
| Botones (menú, ≡, etc.) | fondo `#474747`, radio 3 px, padding `2px 5px 3px`, sin borde |
| Inputs numéricos | fondo `#252525`, radio 3 px |
| Botón de herramienta | 32×29 px, icono 20×20, separación vertical ≈ 31,5 px |
| Menús desplegables | **claros**: fondo blanco, sombra `0 0 20px rgba(0,0,0,.2)`, ancho ≈ 190 px. Los atajos van a la derecha, en gris |
| Cabecera de panel (derecha) | alto 26 px |
| Fila de lista (Historial) | alto 27 px |
| Ventanas / diálogos | flotantes, oscuras, con barra de título y botón ×. Ver capturas 05, 08, 10 |

Detalle de diseño: tema oscuro neutro, sin colores de acento salvo el rojo del botón de cuenta y la barra azul de herramienta activa. Casi todo es gris; la jerarquía se hace con dos grises (`#252525` hundido, `#474747` elevado).

## 3. Barra de menús `[VERIFICADO]`

Menús: **Archivo, Editar, Imagen, Capa, Seleccionar, Filtro, Ver, Ventana, Más.** Después, a la derecha, enlaces (Acerca de, Informar un fallo, Aprender, Blog, API) e iconos sociales.

Cada menú se abre al hacer clic (otro clic lo cierra) y los submenús se abren al pasar el ratón (hover).

### Archivo (`02-menu-archivo.jpg`, `03-menu-archivo-exportar-como.jpg`)

Nuevo… (Alt+Ctrl+N) · Abrir… (Ctrl+O) · Abrir y colocar… · Abrir Más ▸ · Compartir ▸ · Guardar (Ctrl+S) · Guardar como PSD · Guardar Más ▸ · **Exportar como ▸** · Imprimir… (Ctrl+P) · Exportar capas… · Export Color Lookup… · Información del archivo… · Automatizar ▸ · Script…

**Exportar como ▸** abre un submenú con el formato a la izquierda y la extensión a la derecha en gris: PNG .png, JPG .jpg, WEBP .webp, PDF .pdf, SVG .svg, **GIF .gif**, MP4 .mp4, DDS .dds, Más ▸.

### Imagen (`04-menu-imagen.jpg`)

Modo ▸ · Ajustes ▸ · Tono/Contraste/Color automático · Reducir colores… · Vectorizar mapa de bits… · Wavelet Decompose · **Tamaño de lienzo… (Alt+Ctrl+C)** · Tamaño de la imagen… (Alt+Ctrl+I) · Transformar ▸ · Recortar · Cortar… · Mostrar todo · Duplicar · Aplicar imagen… · Variables…

### Capa (`06-menu-capa.jpg`)

Nuevo ▸ · Duplicar capa · Duplicar en… · **Eliminar** · Text ▸ · Estilo de capa ▸ · Nueva capa de relleno ▸ · Nueva capa de ajuste ▸ · Máscara ráster ▸ · Máscara vectorial ▸ · Máscara de recorte · Objeto inteligente ▸ · Rasterizar · Agrupar capas (Ctrl+G) · Organizar ▸ · Combine Shapes ▸ · **Animación ▸** · Combinar hacia abajo (Ctrl+E) · Acoplar imagen · Eliminar halos

Observaciones:
- Los ítems no aplicables aparecen en gris, no desaparecen.
- Los menús con submenú llevan `▸` a la derecha.
- Separadores finos agrupan por función.

### Ventana (`07-menu-ventana-paneles.jpg`)

Es la lista de paneles con una marca ✓ si están visibles: Acciones, Ajustes, **Pincel ✓, Canales ✓, Carácter ✓**, Character Styles, Color, Glifos, Histograma, **Historial ✓, Información ✓, Capas ✓**, Timeline, Composiciones de capas, Navegador, Notas, **Párrafo ✓, Trazados ✓, Propiedades ✓**, Estilo, **Muestras ✓**, Herramientas preestablecidas, Vector Info. Arriba: Más ▸ y Plugins.

Esto es un patrón útil para Glitch: **un menú Ventana que enciende y apaga paneles** es la forma más barata de tener paneles configurables antes de implementar el arrastre.

### Propiedades del documento: dónde están en Photopea `[VERIFICADO]`

Photopea no tiene una opción «Página». Las propiedades del documento se reparten en tres sitios, y Glitch debe usar los mismos:

1. **Imagen → Tamaño de lienzo… (Alt+Ctrl+C)** (`05-dialogo-tamano-de-lienzo.jpg`): ancho, alto, unidades, candado de proporción (16:9), casilla «Relativo», selector de anclaje 3×3 y botón «Aceptar». Cambia el tamaño del área de trabajo sin escalar el contenido.
2. **Imagen → Tamaño de la imagen… (Alt+Ctrl+I)**: cambia las dimensiones escalando el contenido. `[NO VERIFICADO]` el aspecto de este diálogo, solo se vio la entrada del menú.
3. **Archivo → Nuevo… (Alt+Ctrl+N)** (`10-dialogo-proyecto-nuevo-escritorio.jpg`): nombre, ancho, alto, unidades, DPI, fondo (blanco/transparente/color), modo de color, profundidad y perfil. Solo se usa al crear un documento.

`[PROPUESTA]` En Glitch: un menú **Imagen** con *Tamaño de lienzo…* y *Tamaño de la imagen…* (los dos que apliquen), y *Nuevo…* en Archivo. No se inventa ningún menú ni nombre nuevo.

## 4. Barra de herramientas izquierda `[VERIFICADO]`

Columna de 38 px con botones 32×29 en vertical. Orden y atajos: Mover (V), Selección rectangular (M), Lazo (L), Varita mágica (W), Recortar (C), Gotero (I), Pincel corrector (J), Pincel (B), Clonar (S), Borrador (E), Degradado (G), Desenfocar, Sobreexponer (O), Texto (T), Pluma (P), Selección por trayectoria (A), Rectángulo (U), Mano (H), Zoom (Z). Debajo: muestras de color frente/fondo, máscara rápida y teclado. Los botones con una esquina marcada agrupan más herramientas (se ve en la captura móvil `12`).

**Diferencia clave con Glitch:** esa barra de 38 px solo aloja iconos. Tú quieres en la izquierda **los controles del efecto como sliders**, y un slider no cabe en 38 px.

`[PROPUESTA]` Usa un panel izquierdo **de ancho propio (≈ 240–280 px)** con el mismo estilo que los paneles de la derecha (cabecera de 26 px con título/pestañas + cuerpo `#252525`), y no la tira de iconos. Si más adelante quieres iconos de herramientas, se puede añadir una tira de 38 px a su izquierda sin tocar nada más.

## 5. Barra de opciones `[VERIFICADO]`

Fila de 32 px bajo los menús. **Su contenido cambia con la herramienta activa**: con Mover muestra «Selección automática», un desplegable Capa/Grupo, «Controles de transformación» y «Distancias» más iconos de alinear (captura `01`); con Pincel muestra Modo de fusión, Opacidad, Flujo y Suavizar (captura `09`).

Los campos numéricos se presentan como `Etiqueta: [valor%]` y, en algunos, con una flecha ▼ pegada.

`[PROPUESTA]` En Glitch es el sitio natural para los controles de reproducción de la capa activa (play/pausa, barra de progreso, velocidad) y para opciones contextuales. Eso además separa visualmente la barra de efectos de la del GIF, que era tu bug original.

## 6. Panel de Capas (derecha) `[VERIFICADO]`

Ver `01`, `09` y `13`. De arriba abajo:

1. **Cabecera con pestañas**: Capas | Canales | Trazados, y botón `≡` (menú del panel) a la derecha.
2. **Modo de fusión**: desplegable con valor por defecto «Normal».
3. **Opacidad**: `Opacidad: [100%] ▼`.
4. **Bloquear**: 4 iconos (píxeles transparentes, píxeles, posición, todo) y `Relleno: [100%] ▼`.
5. **Lista de capas**: cada fila lleva ojo de visibilidad, miniatura, nombre y, si procede, un candado. La capa seleccionada se resalta con `rgba(0,0,0,.25)`. Las capas nuevas se añaden arriba.
6. **Fila inferior de acciones** (7 iconos en una tira): enlazar capas, efectos (`eff`), máscara, capa de ajuste, carpeta/grupo, **nueva capa** y **papelera (eliminar)**.

Lista completa de modos de fusión (leída del `<select>`): Normal, Disolver · Oscurecer, Multiplicar, Subexponer color, Subexposición lineal, Color más oscuro · Aclarar, Trama, Sobreexponer color, Sobreexposición lineal, Color más claro · Superponer, Luz suave, Luz fuerte, Luz intensa, Luz lineal, Luz focal, Mezcla definida · Diferencia, Exclusión, Restar, Dividir · Tono, Saturación, Color, Luminosidad. Los grupos van separados por una línea vacía.

Detalle de interacción: las etiquetas «Opacidad:» y «Relleno:» tienen cursor `col-resize`, es decir, **arrastrar la etiqueta horizontalmente cambia el valor** (patrón de Photoshop). `[PROPUESTA]` replicarlo es opcional y barato en los sliders de Glitch.

`[PROPUESTA]` Para Glitch: el botón de **eliminar capa** va como papelera al final de la fila inferior. Es exactamente el botón que quedó pendiente en tu lista.

## 7. Configuración de fusión (diálogo «Estilo de capa») `[VERIFICADO]`

Ver `08-dialogo-estilo-de-capa-opciones-de-fusion.jpg`. Se abre con doble clic sobre una capa. Es una ventana flotante con barra de título y ×.

- **Columna izquierda:** lista de efectos con casilla: Opciones de fusión, Bisel y relieve (con Contorno y Textura), Trazo, Sombra interior, Resplandor interior, Satinado, Superposición de colores / degradado / motivo, Resplandor exterior, Sombra paralela, 3D. Algunos tienen un `+` para duplicar el efecto.
- **Columna derecha, «Opciones de fusión»:** Modo de fusión (desplegable), **Opacidad con slider + número + `%`**, Relleno con slider + número, Canales R G B con casillas, «Fusionar si es» con selector y dos barras de rango.
- **Botones:** Aceptar y «Definir nuevo».

La captura enseña el patrón que mejor encaja con tu idea de sliders: **etiqueta a la izquierda, slider en el centro y número editable con `%` a la derecha**.

`[PROPUESTA]` Cada knob de Glitch pasa a ser una fila `etiqueta · slider · input numérico`. La columna de la derecha de este diálogo es el modelo visual para el panel izquierdo de Glitch.

## 8. Diálogos `[VERIFICADO]`

Todos son **ventanas flotantes dentro de la página** (no ventanas del navegador): barra de título oscura con el texto a la izquierda y × a la derecha, cuerpo gris, botón principal ancho abajo.

- `05` Tamaño de lienzo: campos Ancho/Alto con desplegable de unidades, candado de proporción, casilla «Relativo», rejilla de anclaje 3×3 y botón «Aceptar».
- `10` Proyecto nuevo (escritorio): dos mitades. Izquierda, plantillas por categoría con pestañas (Social, Impresión, Foto, Pantalla, Móvil, Anuncios) y miniaturas con nombre y medidas. Derecha, el formulario y el botón «Crear».
- `11` Proyecto nuevo (móvil): el mismo diálogo ocupa toda la pantalla y el formulario pasa arriba, las plantillas abajo.

## 9. Comportamiento en móvil `[VERIFICADO]` (viewport 375×812, user agent móvil)

Ver `11`, `12`, `13`.

- La barra de menús sigue arriba pero **se desplaza en horizontal** (solo caben Archivo… Filtro) y los botones se agrandan para el tacto.
- La barra de herramientas sigue a la izquierda, con iconos más grandes que en escritorio.
- Los paneles de la derecha **se colapsan en una columna de solo iconos** (de ancho similar a la barra de herramientas): historial, muestras, capas, canales, trazados, información, propiedades, pincel, carácter, párrafo, CSS, galería.
- Al tocar un icono, el panel se abre **como ventana flotante** sobre el canvas, con sus pestañas, su menú `≡` y un **asa de redimensionado en la esquina inferior izquierda**.
- El canvas ocupa el resto de la pantalla.

Esto es relevante para ti por dos motivos: confirma que Photopea trata los paneles como ventanas desacoplables (el mismo componente sirve acoplado y flotante), y da una solución para tu bug del botón de exportar en móvil: **exportar vive en el menú Archivo, no en un botón suelto**, así que nunca queda fuera de pantalla.

## 10. Lo que NO se pudo comprobar `[NO VERIFICADO]`

- **Arrastrar paneles en escritorio** (cambiar una pestaña de columna o sacarla a flotante). No se probó. Lo que sí se vio: columnas redimensionables (`ew-resize`), colapso con la tira superior y paneles flotantes en móvil.
- El **popup del slider** que aparece al pulsar la flecha ▼ junto a Opacidad: la pulsación no lo mostró en las capturas. En el diálogo de Estilo de capa el slider es inline, y ese es el patrón que se documenta.
- Menús **Editar, Seleccionar, Filtro, Ver y Más** (solo se vieron Archivo, Imagen, Capa y Ventana).
- Barra de opciones de otras herramientas distintas de Mover y Pincel.
- Dibujo del canvas (sombra del documento, patrón de transparencia, comportamiento del zoom).

## 11. Mapeo a Glitch `[PROPUESTA]`

| Zona de Photopea | Qué lleva en Glitch |
|---|---|
| Barra de menús | **Archivo** (Nuevo, Abrir/Importar, Guardar, Exportar como ▸ PNG/GIF/…), **Editar**, **Imagen** (Tamaño de lienzo…, Tamaño de la imagen…), **Ver**, **Ventana** (activar/desactivar paneles), **Ayuda** o **Atajos** |
| Barra de opciones | Controles de la capa activa: play/pausa, progreso, velocidad |
| Panel izquierdo (ancho propio) | Controles del efecto como sliders `etiqueta · slider · número` |
| Canvas | Vista de trabajo grande, fondo `#252525`, documento centrado |
| Panel derecho, Capas | Lista de capas, modo de fusión, opacidad y botones inferiores (nueva, **eliminar**) |
| Panel derecho, Propiedades / Fusión | Configuración de fusión de la capa seleccionada (modo, opacidad, relleno) |
| Diálogos flotantes | Tamaño de lienzo, Tamaño de la imagen, Nuevo, Exportar, Atajos |

Los iconos, nombres y textos de Photopea son suyos: **usa iconos propios o de una librería con licencia libre** (por ejemplo Lucide) y no copies sus imágenes. Copiar la distribución y los hábitos de uso es una cosa; copiar sus recursos gráficos es otra. Si Glitch va a ser público, conviene validarlo con un profesional.

## 12. Arquitectura para paneles arrastrables en el futuro `[PROPUESTA]`

Hoy NO se implementa el arrastre. Para que añadirlo después no obligue a rehacer nada, el layout debe **describirse con datos, no estar escrito a mano en el JSX/HTML**. Copia la jerarquía de Photopea (sección 1):

```ts
type PanelId = 'layers' | 'blending' | 'effects' | 'history' | /* ... */ string;

interface Block   { id: string; tabs: PanelId[]; activeTab: PanelId; size: number }   // alto relativo
interface Column  { id: string; side: 'left' | 'right'; width: number; collapsed: boolean; blocks: Block[] }
interface Layout  { columns: Column[]; floating: { panel: PanelId; x: number; y: number; w: number; h: number }[] }
```

Reglas:
1. Un **registro de paneles** (`panelRegistry`): `PanelId → componente React`. El layout solo guarda ids.
2. Un único componente `<Dock>` que recorre `Layout` y pinta columnas → bloques → pestañas.
3. Cada panel es autónomo: recibe sus datos por props o contexto y **no sabe dónde está acoplado**. Así el mismo panel sirve acoplado, flotante o en móvil.
4. El layout por defecto vive en un archivo de configuración, y `Ventana → panel` solo cambia `Layout`.
5. Persistencia futura: guardar `Layout` en `localStorage`. No hace falta ahora, pero el tipo ya es serializable.
6. **No** metas dependencias de arrastre (dnd-kit, etc.) hasta la fase siguiente.

## 13. Orden de trabajo sugerido para Claude Code

1. **Estructura sin estilo:** reorganiza la pantalla en menús + barra de opciones + panel izquierdo + canvas + columna derecha, usando el modelo de datos de la sección 12. Todo lo que funcionaba debe seguir funcionando.
2. **Estilo:** aplica los tokens de la sección 2 como variables CSS en un único archivo.
3. **Menú:** mueve importación, exportación, guardar y atajos a Archivo, y crea el menú Imagen → Tamaño de lienzo… / Tamaño de la imagen… (sección 3).
4. **Panel de capas:** modo de fusión, opacidad, lista y fila inferior con **botón de eliminar**.
5. **Panel izquierdo:** sustituye los knobs por filas `etiqueta · slider · número`.
6. **Móvil:** colapsa los paneles de la derecha en columna de iconos que abren paneles flotantes (sección 9).
7. **Revisión:** captura de escritorio y móvil, y comparar con `screenshots/01` y `screenshots/12`.

**Criterios de aceptación**
- El canvas es la zona más grande y no se mueve al abrir o cerrar paneles.
- Con `Ventana` se puede ocultar y mostrar cada panel.
- El botón de exportar es alcanzable en 375 px de ancho.
- Ningún panel referencia a otro por posición, solo por id.

**Antes de empezar, Claude Code debe preguntar o decidir (y anotar):** con qué framework está hecha la app, dónde está hoy el estado de capas, y si el panel izquierdo va con ancho fijo o redimensionable. Esa información no estaba en lo que se me dio.

## Índice de capturas

| Archivo | Contenido |
|---|---|
| `01-desktop-layout-general.jpg` | Layout completo en escritorio, con una capa de fondo |
| `02-menu-archivo.jpg` | Menú Archivo |
| `03-menu-archivo-exportar-como.jpg` | Submenú Exportar como (PNG, JPG, WEBP, PDF, SVG, GIF, MP4…) |
| `04-menu-imagen.jpg` | Menú Imagen (Tamaño de lienzo, etc.) |
| `05-dialogo-tamano-de-lienzo.jpg` | Diálogo Imagen → Tamaño de lienzo (propiedades del documento) |
| `06-menu-capa.jpg` | Menú Capa |
| `07-menu-ventana-paneles.jpg` | Menú Ventana con paneles activados |
| `08-dialogo-estilo-de-capa-opciones-de-fusion.jpg` | Diálogo de configuración de fusión |
| `09-barra-opciones-pincel-y-panel-capas.jpg` | Barra de opciones con Pincel y panel de capas con 2 capas |
| `10-dialogo-proyecto-nuevo-escritorio.jpg` | Diálogo Proyecto nuevo en escritorio |
| `11-movil-dialogo-proyecto-nuevo.jpg` | Diálogo Proyecto nuevo en móvil |
| `12-movil-editor-columna-iconos.jpg` | Editor en móvil con columna de iconos |
| `13-movil-panel-capas-flotante.jpg` | Panel de capas flotante en móvil |
