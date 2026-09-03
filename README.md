# BTC Terminal · ciclos

Sitio 100% estático. No necesita servidor, Worker ni base de datos —
entra perfecto en **Cloudflare Pages plan gratis**.

Cómo se resuelve cada fuente de datos sin backend pago:

| Dato | Ciclo 4 (actual) | Ciclos 1-3 |
|---|---|---|
| Precio, OI, long/short, depth | Fetch directo del navegador a Binance (CORS abierto, sin key) | JSON estático precalculado (`data/c1.json`, `c2.json`, `c3.json`) |
| Liquidaciones | WS público de Binance (best-effort, solo eventos en vivo) | Coinalyze API, opcional, solo en el script de build |

La key de Coinalyze (si la usás) **nunca viaja al navegador**: se usa una sola vez,
localmente o en GitHub Actions, para generar los JSON. El sitio publicado no
tiene ninguna credencial adentro.

## 1. Generar los datos históricos (una sola vez)

No hace falta Python — la versión de Node.js hace exactamente lo mismo.
(Si preferís Python igual está disponible: `scripts/build_historical_data.py`.)

```bash
cd scripts
npm install

# opcional — sin esto, liqLong/liqShort quedan en null y no rompe nada:
export COINALYZE_API_KEY=tu_key_gratis_de_coinalyze.net   # PowerShell: $env:COINALYZE_API_KEY='...'

node build_historical_data.mjs
```

Requiere Node 18 o más nuevo (usa `fetch` nativo — corré `node --version` para
chequear; si no lo tenés, instalalo desde nodejs.org, tomá la versión LTS).
La única dependencia real es `jszip`, para leer los ZIP de Binance sin
depender de herramientas del sistema operativo.

Esto baja bastante ZIP de `data.binance.vision` (uno por día en el rango de
Ciclo 3, más los mensuales de klines horarios), así que tarda varios minutos
la primera vez. Al terminar vas a tener:

```
data/c1.json   # 2013-2016, solo precio real + fallback ilustrativo para el resto
data/c2.json   # 2016-2020, ídem
data/c3.json   # 2020-2024, precio + OI + long/short reales (1h, 1d, 1w)
data/manifest.json
```

Si algo fallá a mitad de camino, volvé a correrlo — es idempotente, no
necesita limpieza previa.

## 2. Deploy a Cloudflare Pages (free)

**Opción A — dashboard (más simple):**
1. Cloudflare Dashboard → Pages → *Create a project* → *Connect to Git* (o *Upload assets* si no querés usar un repo).
2. Framework preset: `None`. Build command: (vacío). Output directory: `/`.
3. Deploy. Listo — `index.html` y `data/*.json` quedan servidos como estáticos.

**Opción B — CLI:**
```bash
npm install -g wrangler
wrangler pages deploy . --project-name=btc-terminal
```

No hace falta `wrangler.toml` ni Pages Functions: todo el fetch en vivo
(Ciclo 4) lo hace el navegador del usuario directo contra Binance, y los
Ciclos 1-3 son archivos estáticos que Cloudflare sirve gratis y sin límite
de requests relevante para este uso (el free tier de Pages no cobra por
solicitudes de assets estáticos).

## 3. Actualizar los datos más adelante

Los Ciclos 1-3 son historia cerrada — no hace falta refrescarlos seguido.
Si igual querés automatizarlo sin depender de tu máquina: `.github/workflows/refresh-data.yml`
ya está armado con `workflow_dispatch` (disparo manual desde la pestaña
Actions de GitHub, gratis en repos públicos). Si usás Coinalyze, cargá
`COINALYZE_API_KEY` como secret del repo antes de correrlo.

Cloudflare Pages se puede configurar para redeployar automáticamente cada
vez que el workflow commitea un `data/*.json` nuevo (deploy on push, ya
viene así por defecto si conectaste el repo por Git).

## 4. Qué hacer si `data/c*.json` todavía no existe

Nada se rompe: `index.html` detecta el 404, muestra un aviso amarillo
explícito ("mostrando serie ilustrativa de respaldo") y sigue funcionando
con datos sintéticos hasta que corras el script. Podés deployar el sitio
antes de generar los datos sin problema.

## Estructura

```
index.html                        # la app entera (single file)
scripts/build_historical_data.py  # genera data/*.json
scripts/requirements.txt
data/                             # se llena al correr el script
.github/workflows/refresh-data.yml
```
