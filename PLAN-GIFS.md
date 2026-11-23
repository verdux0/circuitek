# PLAN-GIFS — buscador GifCities + repo listo para GitHub Pages y el móvil

## Punto de partida
- Los GIF animados **ya se aceptan** como entrada (capa de vídeo/GIF, `src/media/player.ts`: `ImageDecoder`, con `omggif`
  donde no existe). No hay nada que resolver antes.
- La importación (`importFiles`) acepta `File`/`Blob`: un GIF descargado entra por el mismo camino que uno arrastrado.

## Investigación real (18-11-2026, Chrome + curl desde fuera de gifcities.org)
| Endpoint | Qué devuelve | CORS | Notas |
|---|---|---|---|
| `https://gifcities.org/search?q=…&offset=N&page_size=M` | **HTML** renderizado en servidor (Starlette + Elasticsearch): `<a href="web.archive.org/…"><img width height src="https://blob.gifcities.org/gifcities/<CHECKSUM>.gif">`, «page X of Y» | **No** | Es la búsqueda nueva: paginada, con filtro NSFW (`nsfw=maximum` por defecto) y búsqueda semántica. El navegador no deja leerla desde otro origen. |
| `https://gifcities.org/api/v1/gifs` | 404 | — | No existe (la fuente de terceros acertaba en esto). |
| `https://gifcities.archive.org/api/v1/gifsearch?q=…&limit=N` | **JSON**: `[{url_text, weight, gif, checksum, width, height, page}]` | **Sí** (refleja el `Origin`; probado con Pages, localhost, IP de la LAN y `null`) | La API original de 2016. Sin paginación en servidor (ignora `page`/`offset`/`page_size`; solo `limit`). Devuelve todos los resultados (2566 para «computer», 785 KB; con `limit=200`, 65 KB). Algunos traen `checksum: "-"` (sin imagen). **No filtra contenido adulto.** Sin documentar. |
| `https://blob.gifcities.org/gifcities/<CHECKSUM>.gif` | El GIF (`image/gif`) | **Sí** (`Access-Control-Allow-Origin: *`; GET simple, sin preflight) | `fetch` funciona desde cualquier origen → se pueden leer los píxeles (textura WebGL). |

Código: `internetarchive/gifcities` (AGPL-3.0) es la app de servidor (Python + plantillas Jinja + Packery). No hay un
cliente JavaScript que reutilizar, y meter código AGPL obligaría a toda la app a ser AGPL. **Cliente propio mínimo.** Se
anota en THIRD-PARTY.md como servicio usado, no como código reutilizado.

## Decisiones (confirmadas por el usuario)
- **Fuente:** la API JSON con CORS, sin desenfoque de miniaturas, con aviso de que no filtra contenido adulto y de los
  derechos. Botón de **flujo manual** (abrir gifcities.org y arrastrar/pegar el GIF) como respaldo si la API cae.
  Sin proxy ni infraestructura.
- **Paginación (revisada el 24-11-2026):** la API tarda ≈ 7 s en responder sea cual sea el `limit` (TTFB medido: 6,5–7,3 s
  con 60 y con 300; el cuerpo baja en ≈ 0,15 s), así que pedir menos no acelera nada y cada petición extra cuesta otros 7 s.
  Se pide `limit=300`, se muestran **24** cada vez (cada miniatura es un GIF entero: menos a la vez = más ligero), con scroll
  infinito y botón «Cargar más». Cuando quedan menos de 3 páginas se piden **1200 en segundo plano**. Las últimas 20
  búsquedas quedan en memoria (repetir una = 0 peticiones). Al escribir se abre la conexión (`preconnect`, sin enviar
  nada) y las primeras 8 miniaturas van con prioridad alta, el resto baja; `content-visibility` evita pintar las ocultas.
- **Privacidad:** ninguna petición al cargar ni al abrir el panel; la primera sale al buscar. `fetch` con
  `credentials: 'omit'` y `referrerPolicy: 'no-referrer'`, miniaturas con `referrerpolicy="no-referrer"`. Solo se envía
  el texto buscado. Sin cookies ni analytics.
- **Seguridad:** solo `https:` y dominios esperados (`gifcities.archive.org`, `blob.gifcities.org`,
  `web.archive.org`). Checksum en base32 de 32 caracteres. Descarga con tope de 10 MB (cortada en streaming), timeout,
  firma `GIF8`, ≤ 600 fotogramas y ≤ 2048 px de lado. Nunca `innerHTML` con datos remotos: DOM con `textContent` y atributos.
- **Licencia:** MIT (`LICENSE`, `package.json`).

## Parte 2
- `git fetch`: `origin/main` = `e0b1249`, que ya es antepasado de `main` (11 commits por delante, 0 por detrás) → push normal,
  sin force-push.
- `.gitignore` (+ certificados), `LICENSE`, `THIRD-PARTY.md` al día.
- `.github/workflows/pages.yml`: `npm ci`, `tsc`, `npm test`, `npm run build`, `upload-pages-artifact` + `deploy-pages`,
  permisos mínimos. Vite ya usa `base: './'` (rutas relativas): se comprueba sirviendo `dist` bajo `/circuitek/`.
- `dev:phone`: `vite --host` + HTTPS con `@vitejs/plugin-basic-ssl` (se comprueba la compatibilidad con Vite 6.4).
- `README-MOVIL.md` no existe en el proyecto: la sección «Usarlo en el teléfono» se escribe desde cero contra el proyecto
  real, y se marca «no comprobado» lo que necesite un dispositivo físico.
- Activar Pages (Settings → Pages → Source: GitHub Actions) lo hace el usuario: `gh` no está instalado aquí.
