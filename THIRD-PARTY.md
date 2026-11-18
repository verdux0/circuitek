# Código de terceros

glitch-editor no copia ni adapta código de terceros dentro de `src/`: todo lo de abajo se usa **sin modificar**, como dependencia de npm, y se incluye en el build (también en `build:single`) sin CDN. Los algoritmos de dithering (Bayer 4×4 y Floyd–Steinberg, `src/export/dither.ts`) son de dominio público y están escritos desde cero.

## Exportación (GIF / MP4)

| Paquete | Versión | Autor | URL | Licencia | Uso |
|---|---|---|---|---|---|
| mediabunny | 1.66.0 | Vanilagy | https://github.com/Vanilagy/mediabunny | MPL-2.0 | Muxer MP4/WebM sobre WebCodecs, lectura de fotogramas exactos y del audio del vídeo original, parser para las pruebas |
| gifenc | 1.0.3 | Matt DesLauriers | https://github.com/mattdesl/gifenc | MIT | Cuantización de paleta (PnnQuant) y escritor GIF89a con NETSCAPE2.0 |
| omggif | 1.0.10 | Dean McNamee | https://github.com/deanm/omggif | MIT | Decodificar GIF animados donde no hay `ImageDecoder` (Safari en iOS) |

**Sobre la MPL-2.0 de Mediabunny:** es un copyleft *por archivo*. Obliga a ofrecer el código fuente de los archivos de Mediabunny que se distribuyen, y de sus modificaciones si las hubiera. Aquí se distribuyen sin modificar dentro del bundle, y su fuente es la del paquete publicado en npm y en el repositorio de arriba. No afecta a la licencia del resto del código de la app.

## Resto de la app

| Paquete | Versión | Autor | URL | Licencia |
|---|---|---|---|---|
| konva | 10.9.1 | Anton Lavrenov | https://github.com/konvajs/konva | MIT |
| sortablejs | 1.15.7 | SortableJS | https://github.com/SortableJS/Sortable | MIT |
| idb-keyval | 6.3.0 | Jake Archibald | https://github.com/jakearchibald/idb-keyval | Apache-2.0 |
| lucide | 1.69.0 | Lucide Contributors | https://github.com/lucide-icons/lucide | ISC |
| @fontsource/* (Nunito, JetBrains Mono, Anton, Bebas Neue, VT323, Press Start 2P, Space Mono, Permanent Marker, Playfair Display) | 5.3.0 | Fontsource y los autores de cada fuente | https://fontsource.org | OFL-1.1 (fuentes) / MIT (paquetes) |
