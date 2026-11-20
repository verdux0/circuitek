# Despliegue de circuitek

circuitek es una web **estática**: `npm run build` genera la carpeta `dist/` (un `index.html` y la carpeta `assets/`), y cualquier hosting de archivos estáticos la sirve. No hace falta servidor, base de datos ni variables secretas.

Hay tres formas de publicarla. Se pueden usar a la vez: cada una da su propia dirección.

| | Dirección resultante | Se actualiza sola al hacer push | Necesita cuenta |
|---|---|---|---|
| [A. Cloudflare Pages](#a-cloudflare-pages-conectado-a-github) | `https://<proyecto>.pages.dev/` | Sí | Cloudflare (gratis) |
| [B. Netlify Drop](#b-netlify-drop-arrastrar-y-soltar) | `https://<nombre-aleatorio>.netlify.app/` | No: se arrastra a mano cada vez | No para probar; sí para conservarla |
| [C. GitHub Pages](#c-github-pages-ya-configurado) | `https://verdux0.github.io/circuitek/` | Sí | La de GitHub (ya la tienes) |

> Fuentes consultadas el **18-11-2026**. Lo marcado como **(no comprobado)** no he podido verificarlo en la documentación oficial o necesita tu cuenta. No he ejecutado ningún despliegue ni creado cuentas: todos los pasos los haces tú.

---

## Antes de empezar: qué hay en el repositorio para esto

- **`vite.config.ts` → `base: './'`**: todas las rutas del build son relativas, así que la misma carpeta `dist/` funciona en la raíz de un dominio (Cloudflare, Netlify) y en una subruta (GitHub Pages, `/circuitek/`). Comprobado con `tools/verify_paths.py`, que sirve `dist` de las dos formas con un servidor estático: sin errores 404 ni de consola, a 1400 px y a 390 px.
- **`public/_headers`**: Vite lo copia a `dist/_headers`. Lo leen **Cloudflare Pages y Netlify**; **GitHub Pages lo ignora**, porque no admite cabeceras propias. Contiene:
  - `/assets/*` → `Cache-Control: public, max-age=31536000, immutable`. Los archivos de `assets/` llevan un hash en el nombre (`index-bHfpkcEv.js`), así que cada build genera nombres nuevos y se pueden guardar en caché un año sin quedarse viejos.
  - `/` e `/index.html` → `Cache-Control: no-cache`: la página se revalida siempre y un despliegue nuevo se ve al recargar.
  - En todas las rutas: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y `Permissions-Policy` (sin cámara, micrófono ni ubicación).
  - **No** lleva `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`: nada en la app usa `SharedArrayBuffer`, y COEP bloquearía las miniaturas de GifCities. Los workers van incrustados en el JavaScript (`blob:`) y los módulos `.js` reciben su `Content-Type` correcto en ambos servicios por la extensión, así que no hace falta ninguna cabecera para módulos ni workers.
- **`wrangler.toml`** (solo lo usa Cloudflare): nombre del proyecto y carpeta de salida (`./dist`).
- **`.github/workflows/pages.yml`**: el despliegue automático a GitHub Pages.

Requisitos para compilar en tu ordenador (opciones B y C en local): **Node.js 22.12 o superior** (24 LTS recomendado). Comprueba tu versión con `node -v`.

---

## A. Cloudflare Pages conectado a GitHub

Cada push a `main` publica una versión nueva; las otras ramas generan direcciones de prueba.

### Pasos

1. Crea una cuenta gratuita en <https://dash.cloudflare.com/sign-up> si no tienes (no hace falta un dominio propio).
2. En el panel de Cloudflare, abre **Workers & Pages**.
3. Pulsa **Create application** → pestaña **Pages** → **Connect to Git**.
4. Elige **GitHub** y autoriza a Cloudflare. Puedes darle acceso solo al repositorio `circuitek`.
5. Selecciona `verdux0/circuitek` y pulsa **Install & Authorize** y luego **Begin setup**.
6. En **Set up builds and deployments**, rellena:

   | Campo | Valor |
   |---|---|
   | Project name | `circuitek` (da la dirección `circuitek.pages.dev`; si está cogido, elige otro y cambia también `name` en `wrangler.toml`) |
   | Production branch | `main` |
   | Framework preset | `None` (o `Vite`, que rellena lo mismo) |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory (advanced) | vacío (la raíz del repositorio) |
   | Environment variables | ninguna (opcional: `NODE_VERSION` = `24`, ver abajo) |

7. Pulsa **Save and Deploy**. Espera a que el build termine (un par de minutos) y abre la dirección `https://<proyecto>.pages.dev/` que aparece. *(El texto exacto del botón final no está en la página citada: **no comprobado**.)*

### Detalles

- **`wrangler.toml` manda sobre el panel:** con este archivo en el repositorio, Pages toma de él la configuración que define (aquí, la carpeta de salida `./dist`), y esos campos quedan **de solo lectura** en el panel. El comando de build no se puede poner en `wrangler.toml`: va en el panel. Si un día quieres configurarlo todo desde el panel, borra `wrangler.toml`. Requiere el sistema de build V2, el predeterminado en proyectos nuevos.
- **Versión de Node:** la imagen de build actual (v3) trae Node **22.23.4** por defecto, que vale para este proyecto. Si quieres la misma versión que la integración continua de GitHub, añade la variable `NODE_VERSION` = `24` en **Settings → Environment variables** del proyecto. *(Que acepte solo el número mayor, `24`, sin versión completa: **no comprobado**.)*
- **Límites del plan gratuito:** 500 builds al mes (de uno en uno), 20 minutos por build, 20 000 archivos por sitio y 25 MiB por archivo. Este proyecto genera 44 archivos (2,1 MB) y el mayor ocupa unos 0,8 MB.
- **`_headers`:** como máximo 100 reglas y 2000 caracteres por línea; aquí hay 4 reglas.

Fuentes: [Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/) (actualizada el 21-04-2026) · [Configuración con Wrangler para Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/) · [Cabeceras (`_headers`)](https://developers.cloudflare.com/pages/configuration/headers/) · [Límites](https://developers.cloudflare.com/pages/platform/limits/) · [Imagen de build y versión de Node](https://developers.cloudflare.com/pages/configuration/build-image/)

---

## B. Netlify Drop (arrastrar y soltar)

La forma más rápida de tener una dirección pública sin conectar nada: subes la carpeta ya compilada.

### Pasos

1. Compila en tu ordenador, en la carpeta del proyecto:
   ```bash
   npm install
   npm run build
   ```
   Se crea la carpeta `dist/` (con `index.html`, `assets/` y `_headers`).
2. Abre <https://app.netlify.com/drop> en el navegador.
3. **Arrastra la carpeta `dist`** (la carpeta entera, no su contenido ni un .zip) a la zona de la página.
4. En unos segundos te da una dirección `https://<nombre-aleatorio>.netlify.app/`. Ábrela: es la app.

### Detalles

- **Sin cuenta** se publica tal cual, pero hay que **reclamar** el sitio (crear cuenta o iniciar sesión desde el aviso de la propia página) para que siga en línea. *(Cuánto dura sin reclamar: la documentación oficial no lo dice. Fuentes no oficiales hablan de **una hora**, y versiones anteriores daban 24 horas. **No comprobado**: si quieres conservarlo, reclámalo enseguida.)*
- **Actualizar:** Netlify Drop no se conecta a GitHub. Cada vez que cambies el código, ejecuta `npm run build` y arrastra la nueva `dist` a la zona de despliegue que hay al final de la página **Deploys** del sitio (con la sesión iniciada).
- **Arrastra `dist`, no el proyecto:** sin sesión iniciada, Netlify publica los archivos tal cual y no compila nada. Con sesión, Drop puede detectar el framework y compilar, pero subir `dist` ya compilada es lo predecible.
- **`_headers`:** Netlify lo aplica si está en la raíz de la carpeta publicada, y `dist/_headers` lo está. *(Que también se aplique en los despliegues por Drop no lo dice explícitamente la documentación: **no comprobado**. Si no se aplicara, la app funciona igual; solo cambia la caché.)*
- **Límites de tamaño de Drop:** la documentación no los indica (**no comprobado**). Este build ocupa unos 2,1 MB (44 archivos).

Fuentes: [Crear despliegues (Netlify Drop)](https://docs.netlify.com/deploy/create-deploys/) · [Cabeceras personalizadas](https://docs.netlify.com/manage/routing/headers/) · [Changelog de Netlify Drop, 27-07-2026](https://www.netlify.com/changelog/2026-07-27-netlify-drop-refresh/)

---

## C. GitHub Pages (ya configurado)

El repositorio ya tiene el workflow `.github/workflows/pages.yml`. En cada push a `main`:

1. instala dependencias (`npm ci`),
2. comprueba tipos (`npx tsc --noEmit`) y pasa los tests (`npm test`),
3. compila (`npm run build`),
4. publica `dist` con las acciones oficiales `actions/upload-pages-artifact` y `actions/deploy-pages`.

Solo el trabajo de despliegue tiene permiso de escribir en Pages.

### Activarlo (una sola vez)

1. En GitHub, abre el repositorio `verdux0/circuitek`.
2. Pestaña **Settings**. Si no la ves, ábrela desde el menú **…**.
3. En la barra lateral, sección *Code, planning, and automation*, pulsa **Pages**.
4. En **Build and deployment**, pon **Source** en **GitHub Actions**. No elijas ninguna plantilla: el workflow ya existe.
5. Vuelve a lanzar el despliegue: pestaña **Actions** → **Deploy to GitHub Pages** → la última ejecución → **Re-run all jobs** (o haz cualquier push a `main`).
6. Al terminar, la app está en **<https://verdux0.github.io/circuitek/>**.

El primer intento, del 18-11-2026, compiló y pasó los tests, pero falló en el paso `configure-pages` precisamente porque Pages aún no estaba activado.

### Detalles

- La dirección lleva la subruta `/circuitek/`. Funciona gracias a `base: './'`, comprobado con `tools/verify_paths.py`.
- GitHub Pages **no aplica `_headers`**: usa su propia política de caché. La app funciona igual.
- **Límites:** sitio publicado de 1 GB como máximo, 100 GB al mes de ancho de banda (límite flexible) y 10 minutos por despliegue. El límite de 10 builds por hora no se aplica a despliegues con un workflow propio como este.

Fuentes: [Configurar la fuente de publicación](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) · [Límites de GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) · [Qué es GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

---

## ¿Hace falta un proxy para el buscador de GIF?

**No.** El buscador usa la API JSON original de GifCities (`gifcities.archive.org/api/v1/gifsearch`), que envía cabeceras CORS para cualquier origen, y las imágenes de `blob.gifcities.org` llevan `Access-Control-Allow-Origin: *`. Funciona igual desde `*.pages.dev`, `*.netlify.app`, `verdux0.github.io` y la red local (comprobado contra el servicio real el 18-11-2026; ver [PLAN-GIFS.md](../PLAN-GIFS.md)).

Solo haría falta un proxy para usar la **búsqueda nueva** de gifcities.org (paginada en servidor y con filtro de contenido adulto), que devuelve HTML sin CORS. En ese caso, una **Cloudflare Pages Function** mínima (`functions/api/gifs.js`) podría:

- aceptar solo `GET /api/gifs?q=…&offset=…` y llamar únicamente a `https://gifcities.org/search` (lista blanca: ese host y nada más);
- limitar la longitud de `q`, el tamaño de la respuesta (unos 2 MB) y el tiempo de espera;
- extraer del HTML solo checksum, tamaño y página original, y devolver JSON;
- no guardar nada: sin registros propios, sin KV ni base de datos, sin cookies;
- devolver CORS solo para los orígenes de la app.

Costes: solo funcionaría en el despliegue de Cloudflare (Netlify Drop y GitHub Pages no ejecutan funciones), y depende de un HTML que GifCities puede cambiar en cualquier momento. **No está implementada**: es una decisión que tomas tú.
