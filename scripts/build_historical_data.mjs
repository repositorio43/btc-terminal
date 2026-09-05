/**
 * build_historical_data.mjs
 * ==========================
 * Versión en Node.js del generador de datos históricos — no necesita Python.
 * Requiere Node 18 o más nuevo (usa fetch nativo) + una sola dependencia: jszip.
 *
 * Mismas fuentes gratuitas que la versión Python:
 *   - Precio diario completo (2012 -> ~ene-2025): CSV público en GitHub
 *     (repo ff137/bitstamp-btcusd-minute-data, datos de Bitstamp minuto a
 *     minuto), colapsado a cierre diario. Cubre los 4 ciclos enteros.
 *   - Open Interest + ratio long/short (5-min): data.binance.vision, sin key.
 *     Solo existe desde sept-2019 (cuando arrancó Binance Futures) — por eso
 *     Ciclo 1 y 2 quedan sin esto, no es un límite del script.
 *   - Precio horario preciso para Ciclo 3: klines mensuales de data.binance.vision.
 *   - Liquidaciones (opcional): Coinalyze API, key gratis con registro.
 *
 * Uso:
 *   cd scripts
 *   npm install
 *   export COINALYZE_API_KEY=xxxx     # opcional (PowerShell: $env:COINALYZE_API_KEY='xxxx')
 *   node build_historical_data.mjs
 *
 * Salida: ../data/c1.json, c2.json, c3.json, manifest.json
 */

import JSZip from "jszip";
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data");
mkdirSync(OUT_DIR, { recursive: true });

const SYMBOL = "BTCUSDT";
const COINALYZE_API_KEY = (process.env.COINALYZE_API_KEY || "").trim();

const CYCLES = [
  { id: "c1", start: "2013-01-01", end: "2016-01-01", wantOi: false, wantHourly: false },
  { id: "c2", start: "2016-01-01", end: "2020-01-01", wantOi: false, wantHourly: false },
  { id: "c3", start: "2020-01-01", end: "2024-01-01", wantOi: true, wantHourly: true },
];

const DAY = 86400000, HOUR = 3600000, WEEK = 7 * DAY;

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

function dateRange(start, end, stepDays = 1) {
  const out = [];
  let cur = new Date(start + "T00:00:00Z");
  const endD = new Date(end + "T00:00:00Z");
  while (cur < endD) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + stepDays * DAY);
  }
  return out;
}

function monthsRange(start, end) {
  const out = [];
  let cur = new Date(start + "T00:00:00Z");
  const endD = new Date(end + "T00:00:00Z");
  while (cur < endD) {
    out.push(cur.toISOString().slice(0, 7));
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. Precio — CSV público en GitHub (histórico completo, sin key)     */
/* ------------------------------------------------------------------ */
// Recorrido real de intentos con este proyecto: CoinGecko limitó su tier
// gratis a 365 días; CryptoCompare/CoinDesk Data cerró su tier gratis en
// mayo-2026; Kraken solo devuelve los últimos ~720 días sin importar el
// "since" pedido, no sirve para backfill histórico; Yahoo Finance es un
// endpoint no documentado que puede cambiar sin aviso.
// En vez de depender de OTRA API con política que puede cambiar, usamos un
// archivo CSV estático versionado en un repo público de GitHub
// (ff137/bitstamp-btcusd-minute-data), con precio de BTC/USD minuto a
// minuto desde 2012, mantenido activamente. No es una API con reglas de
// negocio que puedan cambiar — es un archivo de datos con historial de git,
// lo que lo hace bastante más estable que cualquiera de los intentos
// anteriores. Acá solo necesitamos el cierre diario, así que se colapsa
// cada día a su último precio (~4700 días → unos pocos miles de puntos).

async function fetchPriceDailyFull() {
  log("Descargando histórico de precio (CSV público de GitHub, Bitstamp 1-min desde 2012)…");
  const url =
    "https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz";
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "(sin cuerpo)");
    throw new Error(`GitHub raw HTTP ${res.status} — respuesta: ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log(`  -> descargados ${(buf.length / 1e6).toFixed(1)} MB comprimidos, descomprimiendo…`);
  const text = zlib.gunzipSync(buf).toString("utf8");
  const lines = text.split("\n");
  // header esperado: timestamp,open,high,low,close,volume
  const byDay = new Map(); // día (unix, truncado a medianoche UTC) -> último close visto ese día
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const firstComma = line.indexOf(",");
    if (firstComma === -1) continue;
    const tsSec = parseInt(line.slice(0, firstComma), 10);
    if (!isFinite(tsSec)) continue;
    const rest = line.slice(firstComma + 1).split(",");
    const close = parseFloat(rest[3]); // open,high,low,close -> close es el índice 3
    if (!isFinite(close) || close <= 0) continue;
    const dayKey = Math.floor(tsSec / 86400) * 86400;
    byDay.set(dayKey, close); // las filas vienen en orden ascendente -> queda el cierre del día
  }
  const points = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tSec, price]) => ({ t: tSec * 1000, price }));
  log(`  -> ${points.length} puntos diarios de precio (cobertura ~2012-01-01 a ~2025-01-07)`);
  return points;
}

/* ------------------------------------------------------------------ */
/* 2. OI + long/short — data.binance.vision (métricas 5-min)           */
/* ------------------------------------------------------------------ */

async function fetchZipText(url) {
  const res = await fetch(url);
  if (res.status !== 200) return null;
  const buf = await res.arrayBuffer();
  try {
    const zip = await JSZip.loadAsync(buf);
    const name = Object.keys(zip.files)[0];
    return await zip.files[name].async("string");
  } catch {
    return null;
  }
}

function parseCsvWithHeader(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = vals[i]));
    return row;
  });
}

async function fetchBinanceOiLongShortRange(symbol, start, end) {
  log(`Descargando métricas OI/long-short diarias ${start} -> ${end} (5-min)…`);
  const days = dateRange(start, end);
  const rows = [];
  let misses = 0;
  for (const day of days) {
    const url = `https://data.binance.vision/data/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`;
    const text = await fetchZipText(url);
    if (!text) { misses++; continue; }
    for (const r of parseCsvWithHeader(text)) {
      const t = Date.parse(r.create_time.replace(" ", "T") + "Z");
      const oi = parseFloat(r.sumOpenInterestValue);
      const lsRatio = Math.max(0.01, parseFloat(r.CountLongShortRatio));
      if (!isFinite(t) || isNaN(oi) || isNaN(lsRatio)) continue;
      const longRatio = (lsRatio / (1 + lsRatio)) * 100;
      rows.push({ t, oi, longRatio, shortRatio: 100 - longRatio });
    }
    await new Promise((r) => setTimeout(r, 40)); // cortesía con el CDN
  }
  log(`  -> ${rows.length} filas de 5-min, ${misses} días sin archivo (saltados)`);
  return rows;
}

/* ------------------------------------------------------------------ */
/* 3. Precio horario preciso (Ciclo 3) — klines mensuales               */
/* ------------------------------------------------------------------ */

async function fetchHourlyPriceRange(symbol, start, end) {
  log(`Descargando klines horarios (futuros) ${start} -> ${end}…`);
  const months = monthsRange(start, end);
  const rows = [];
  for (const ym of months) {
    const url = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1h/${symbol}-1h-${ym}.zip`;
    const text = await fetchZipText(url);
    if (!text) continue;
    for (const line of text.trim().split("\n")) {
      const cols = line.split(",");
      const t = parseInt(cols[0], 10);
      const price = parseFloat(cols[4]);
      if (isFinite(t) && !isNaN(price)) rows.push({ t, price });
    }
  }
  log(`  -> ${rows.length} velas horarias de precio`);
  return rows;
}

/* ------------------------------------------------------------------ */
/* 4. Liquidaciones (opcional) — Coinalyze                              */
/* ------------------------------------------------------------------ */

async function fetchCoinalyzeLiquidations(symbol, startMs, endMs) {
  if (!COINALYZE_API_KEY) {
    log("  (COINALYZE_API_KEY no seteada -> se omiten liquidaciones históricas)");
    return [];
  }
  log("Descargando histórico de liquidaciones desde Coinalyze…");
  const url = new URL("https://api.coinalyze.net/v1/liquidation-history");
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("interval", "1day");
  url.searchParams.set("from", Math.floor(startMs / 1000));
  url.searchParams.set("to", Math.floor(endMs / 1000));
  try {
    const res = await fetch(url, { headers: { api_key: COINALYZE_API_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const history = data[0]?.history || [];
    return history.map((h) => ({ t: h.t * 1000, liqLong: h.l, liqShort: h.s }));
  } catch (e) {
    log(`  (Coinalyze falló: ${e.message} -> se omiten liquidaciones)`);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 5. Resample + merge                                                  */
/* ------------------------------------------------------------------ */

function bucketKey(t, bucketMs) {
  return Math.floor(t / bucketMs) * bucketMs;
}

function aggregate(rows, fields, bucketMs, mode = "mean") {
  const buckets = new Map();
  for (const r of rows) {
    const k = bucketKey(r.t, bucketMs);
    if (!buckets.has(k)) buckets.set(k, {});
    const b = buckets.get(k);
    for (const f of fields) {
      const v = r[f];
      if (v == null || isNaN(v)) continue;
      if (!b[f]) b[f] = { sum: 0, count: 0 };
      b[f].sum += v;
      b[f].count++;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, b]) => {
      const point = { t };
      for (const f of fields) {
        point[f] = b[f] ? (mode === "sum" ? b[f].sum : b[f].sum / b[f].count) : null;
      }
      return point;
    });
}

function mergeByT(...arrays) {
  const map = new Map();
  for (const arr of arrays) {
    for (const p of arr) {
      const existing = map.get(p.t) || { t: p.t };
      Object.assign(existing, p);
      map.set(p.t, existing);
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function finalizePoints(points) {
  const fields = ["price", "oi", "longRatio", "shortRatio", "liqLong", "liqShort"];
  return points.map((p) => {
    const out = { t: p.t };
    for (const f of fields) out[f] = p[f] != null ? Math.round(p[f] * 10000) / 10000 : null;
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* 6. Armado por ciclo                                                  */
/* ------------------------------------------------------------------ */

async function buildCycle(cycle, priceDaily) {
  const { id, start, end, wantOi, wantHourly } = cycle;
  log(`=== Construyendo ${id} (${start} -> ${end}) ===`);

  const startMs = Date.parse(start + "T00:00:00Z");
  const endMs = Date.parse(end + "T00:00:00Z");
  const priceSlice = priceDaily.filter((p) => p.t >= startMs && p.t < endMs);

  let oiLs = [];
  if (wantOi) oiLs = await fetchBinanceOiLongShortRange(SYMBOL, start, end);

  const liq = await fetchCoinalyzeLiquidations("BTCUSDT_PERP.A", startMs, endMs);

  const result = { "1h": null, "1d": null, "1w": null };

  // ---- 1D ----
  const priceD = aggregate(priceSlice, ["price"], DAY, "mean");
  const oiD = oiLs.length ? aggregate(oiLs, ["oi", "longRatio", "shortRatio"], DAY, "mean") : [];
  const liqD = liq.length ? aggregate(liq, ["liqLong", "liqShort"], DAY, "sum") : [];
  result["1d"] = finalizePoints(mergeByT(priceD, oiD, liqD));

  // ---- 1W ----
  const priceW = aggregate(priceSlice, ["price"], WEEK, "mean");
  const oiW = oiLs.length ? aggregate(oiLs, ["oi", "longRatio", "shortRatio"], WEEK, "mean") : [];
  const liqW = liq.length ? aggregate(liq, ["liqLong", "liqShort"], WEEK, "sum") : [];
  result["1w"] = finalizePoints(mergeByT(priceW, oiW, liqW));

  // ---- 1H (solo si corresponde) ----
  if (wantHourly && oiLs.length) {
    const hourlyPrice = await fetchHourlyPriceRange(SYMBOL, start, end);
    const priceH = hourlyPrice.length
      ? aggregate(hourlyPrice, ["price"], HOUR, "mean")
      : aggregate(priceSlice, ["price"], HOUR, "mean");
    const oiH = aggregate(oiLs, ["oi", "longRatio", "shortRatio"], HOUR, "mean");
    const liqH = liq.length ? aggregate(liq, ["liqLong", "liqShort"], HOUR, "sum") : [];
    result["1h"] = finalizePoints(mergeByT(priceH, oiH, liqH));
  }

  for (const tf of Object.keys(result)) {
    log(`  ${id} [${tf}]: ${result[tf] ? result[tf].length : 0} puntos`);
  }
  return result;
}

async function main() {
  log("=== VERSION-MARCA: v7-csv-github (si ves esta línea, el archivo correcto está corriendo) ===");
  const priceDaily = await fetchPriceDailyFull();

  const manifest = {
    generated_at: new Date().toISOString(),
    generator: "build_historical_data.mjs (Node.js, sin Python)",
    sources: {
      price: "CSV público en GitHub (ff137/bitstamp-btcusd-minute-data, Bitstamp 1-min desde 2012, colapsado a cierre diario)",
      open_interest_long_short: "data.binance.vision futures/um/daily/metrics (5-min, resampleado)",
      hourly_price_cycle3: "data.binance.vision futures/um/monthly/klines 1h",
      liquidations: COINALYZE_API_KEY
        ? "Coinalyze API (liquidation-history)"
        : "no disponible (COINALYZE_API_KEY no seteada)",
    },
    note:
      "Ciclo 1 y 2 no tienen open interest / long-short / liquidaciones reales: " +
      "los futuros perpetuos con esos datos no existían en 2013-2020 a esta escala. " +
      "Solo llevan precio real (CSV de Bitstamp/GitHub, cobertura desde 2012).",
  };

  for (const cycle of CYCLES) {
    const data = await buildCycle(cycle, priceDaily);
    const outPath = path.join(OUT_DIR, `${cycle.id}.json`);
    writeFileSync(outPath, JSON.stringify(data));
    log(`Escrito ${outPath}`);
  }

  writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  log("Listo. Manifest escrito en data/manifest.json");
}

main().catch((e) => {
  console.error("Error fatal:", e);
  process.exit(1);
});
