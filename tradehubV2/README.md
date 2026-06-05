# TradeHub v2

App de gestión para rope access (single-file React PWA) + auto-búsqueda de logo de empresa.

## Estructura
```
tradehubv2/
├── index.html          # la app (con LogoAutoFetch ya integrado)
├── manifest.json       # PWA
├── service-worker.js   # cachea la app; ignora /api/
├── icons/              # íconos PWA (renombrado desde index/)
└── api/
    └── company-logo.js # función serverless: resuelve logo desde URL/dominio
```

## Subir a GitHub + Vercel
1. Subí TODO el contenido de esta carpeta a la raíz del repo `tradehubv2`.
2. Conectá el repo en Vercel (o redeploy si ya está).
3. Vercel detecta `api/company-logo.js` solo y lo sirve en `/api/company-logo`.

## Auto-logo
- Al crear/editar empresa (admin) o en Settings → Company info, hay un campo
  "Auto-buscar logo": pegás la web/dominio, toca Buscar y rellena el logo.
- El upload manual sigue disponible como fallback.

### Brandfetch (opcional, mejor calidad)
En Vercel → Settings → Environment Variables:
- `BRANDFETCH_CLIENT_ID` = tu client id de brandfetch.com
Sin esta variable funciona igual (scrape de la web + favicon de Google).

## OJO
- La carpeta de íconos ahora se llama `icons/` (en el repo viejo estaba como
  `index/`, por eso los íconos daban 404). Ya quedó alineada con el manifest.
- `/api` SOLO funciona en Vercel, no en GitHub Pages.
