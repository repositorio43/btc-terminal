#!/usr/bin/env python3
"""
build_historical_data.py
=========================
Genera los JSON estáticos que consume index.html para los Ciclos 1-3
(el Ciclo 4 se pide en vivo directo desde el navegador a Binance, no necesita esto).

Fuentes usadas (todas gratuitas):
  - Precio diario, TODO el histórico (2013->hoy): CoinGecko API pública, sin key.
  - Open Interest + ratio long/short, 5-min de resolución: data.binance.vision
    (archivos CSV dentro de ZIPs, sin key, sin cuenta). Solo existen desde que
    Binance Futures USDⓈ-M arrancó (sept. 2019), por eso Ciclo 1 y 2 quedan
    SIN OI/long-short real: no es una limitación del script, es que el dato
    no existió nunca en esas fechas.
  - Precio horario para Ciclo 3 (más preciso que CoinGecko diario): klines
    mensuales 1h de data.binance.vision.
  - Liquidaciones (opcional): Coinalyze API, gratis con registro
    (https://coinalyze.net/account/api-key). Si no seteás COINALYZE_API_KEY
    como variable de entorno, el script simplemente deja liqLong/liqShort en null
    y el front no dibuja esa línea para ese ciclo (no rompe nada).

Uso:
    pip install -r requirements.txt
    export COINALYZE_API_KEY=xxxx   # opcional
    python scripts/build_historical_data.py

Salida:
    data/c1.json  (Ciclo 1, 2013-01-01 -> 2016-01-01)  -> solo "1d" y "1w"
    data/c2.json  (Ciclo 2, 2016-01-01 -> 2020-01-01)  -> solo "1d" y "1w"
    data/c3.json  (Ciclo 3, 2020-01-01 -> 2024-01-01)  -> "1h", "1d" y "1w"
    data/manifest.json (metadata: cuándo se generó, qué fuentes se usaron)

El script es best-effort: si un día puntual de data.binance.vision no está
disponible (feriado del feed, símbolo recién listado, etc.) lo saltea y sigue.
Podés cortarlo y volver a correrlo, es idempotente (regenera todo de nuevo).
"""

import io
import json
import os
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone

import requests

try:
    import pandas as pd
except ImportError:
    sys.exit("Falta pandas. Corré: pip install -r requirements.txt")

SYMBOL = "BTCUSDT"
COINGECKO_ID = "bitcoin"
COINALYZE_API_KEY = os.environ.get("COINALYZE_API_KEY", "").strip()

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT_DIR, exist_ok=True)

CYCLES = [
    {"id": "c1", "start": "2013-01-01", "end": "2016-01-01", "want_oi": False, "want_hourly": False},
    {"id": "c2", "start": "2016-01-01", "end": "2020-01-01", "want_oi": False, "want_hourly": False},
    {"id": "c3", "start": "2020-01-01", "end": "2024-01-01", "want_oi": True, "want_hourly": True},
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "btc-terminal-data-builder/1.0"})


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 1. Precio — CoinGecko (histórico completo, diario, gratis, sin key)
# ---------------------------------------------------------------------------

def fetch_coingecko_price_daily():
    log("Descargando histórico de precio diario completo desde CoinGecko…")
    url = (
        f"https://api.coingecko.com/api/v3/coins/{COINGECKO_ID}/market_chart"
        f"?vs_currency=usd&days=max&interval=daily"
    )
    r = SESSION.get(url, timeout=30)
    r.raise_for_status()
    prices = r.json()["prices"]  # [[ms, price], ...]
    df = pd.DataFrame(prices, columns=["t", "price"])
    df["t"] = pd.to_datetime(df["t"], unit="ms", utc=True)
    df = df.set_index("t").sort_index()
    log(f"  -> {len(df)} puntos diarios de precio ({df.index.min().date()} a {df.index.max().date()})")
    return df


# ---------------------------------------------------------------------------
# 2. OI + long/short — data.binance.vision (5-min, gratis, sin key)
#    Formato: data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-YYYY-MM-DD.zip
# ---------------------------------------------------------------------------

def fetch_binance_metrics_day(symbol, date_str):
    url = (
        f"https://data.binance.vision/data/futures/um/daily/metrics/"
        f"{symbol}/{symbol}-metrics-{date_str}.zip"
    )
    r = SESSION.get(url, timeout=20)
    if r.status_code != 200:
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(r.content))
        name = z.namelist()[0]
        with z.open(name) as f:
            df = pd.read_csv(f)
        return df
    except Exception:
        return None


def fetch_binance_oi_longshort_range(symbol, start_date, end_date):
    log(f"Descargando métricas OI/long-short diarias {start_date} -> {end_date} (5-min granularity)…")
    cur = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    frames = []
    misses = 0
    while cur < end:
        date_str = cur.strftime("%Y-%m-%d")
        df = fetch_binance_metrics_day(symbol, date_str)
        if df is not None and len(df):
            frames.append(df)
        else:
            misses += 1
        cur += timedelta(days=1)
        time.sleep(0.05)  # cortesía con el CDN, no hay rate limit oficial documentado
    if not frames:
        log(f"  -> sin datos en este rango (normal si es previo a sept-2019, futuros no existían)")
        return None
    full = pd.concat(frames, ignore_index=True)
    full["create_time"] = pd.to_datetime(full["create_time"], utc=True)
    full = full.set_index("create_time").sort_index()
    # CountLongShortRatio = accounts_long / accounts_short (global accounts)
    ratio = full["CountLongShortRatio"].clip(lower=0.01)
    full["longRatio"] = (ratio / (1 + ratio)) * 100
    full["shortRatio"] = 100 - full["longRatio"]
    full["oi"] = full["sumOpenInterestValue"]
    log(f"  -> {len(full)} filas de 5-min, {misses} días sin archivo (saltados)")
    return full[["oi", "longRatio", "shortRatio"]]


# ---------------------------------------------------------------------------
# 3. Precio horario preciso para Ciclo 3+ — klines mensuales de data.binance.vision
# ---------------------------------------------------------------------------

def fetch_binance_klines_month(symbol, market, interval, year_month):
    # market: "spot" o "futures/um"
    base = "data/spot/monthly/klines" if market == "spot" else "data/futures/um/monthly/klines"
    url = (
        f"https://data.binance.vision/{base}/{symbol}/{interval}/"
        f"{symbol}-{interval}-{year_month}.zip"
    )
    r = SESSION.get(url, timeout=30)
    if r.status_code != 200:
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(r.content))
        name = z.namelist()[0]
        with z.open(name) as f:
            df = pd.read_csv(f, header=None)
        cols = ["open_time","open","high","low","close","volume","close_time",
                "quote_vol","trades","taker_buy_base","taker_buy_quote","ignore"]
        df.columns = cols[:len(df.columns)]
        return df
    except Exception:
        return None


def fetch_hourly_price_range(symbol, start_date, end_date):
    log(f"Descargando klines horarios (futuros) {start_date} -> {end_date}…")
    cur = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    frames = []
    seen_months = set()
    while cur < end:
        ym = cur.strftime("%Y-%m")
        if ym not in seen_months:
            seen_months.add(ym)
            df = fetch_binance_klines_month(symbol, "futures", "1h", ym)
            if df is not None and len(df):
                frames.append(df)
        cur += timedelta(days=28)
    if not frames:
        return None
    full = pd.concat(frames, ignore_index=True)
    full["t"] = pd.to_datetime(full["open_time"], unit="ms", utc=True)
    full["price"] = full["close"].astype(float)
    full = full.set_index("t").sort_index()
    log(f"  -> {len(full)} velas horarias de precio")
    return full[["price"]]


# ---------------------------------------------------------------------------
# 4. Liquidaciones (opcional) — Coinalyze, gratis con key propia
# ---------------------------------------------------------------------------

def fetch_coinalyze_liquidations(symbol_coinalyze, start_ms, end_ms, interval="1day"):
    if not COINALYZE_API_KEY:
        log("  (COINALYZE_API_KEY no seteada -> se omiten liquidaciones históricas)")
        return None
    log("Descargando histórico de liquidaciones desde Coinalyze…")
    url = "https://api.coinalyze.net/v1/liquidation-history"
    params = {
        "symbols": symbol_coinalyze,
        "interval": interval,
        "from": start_ms // 1000,
        "to": end_ms // 1000,
    }
    headers = {"api_key": COINALYZE_API_KEY}
    try:
        r = SESSION.get(url, params=params, headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()
        rows = data[0]["history"] if data else []
        df = pd.DataFrame(rows)
        if df.empty:
            return None
        df["t"] = pd.to_datetime(df["t"], unit="s", utc=True)
        df = df.set_index("t").sort_index()
        df = df.rename(columns={"l": "liqLong", "s": "liqShort"})
        return df[[c for c in ["liqLong", "liqShort"] if c in df.columns]]
    except Exception as e:
        log(f"  (Coinalyze falló: {e} -> se omiten liquidaciones)")
        return None


# ---------------------------------------------------------------------------
# 5. Resample + merge + export
# ---------------------------------------------------------------------------

def to_points(df):
    out = []
    for ts, row in df.iterrows():
        point = {"t": int(ts.timestamp() * 1000)}
        for col in ["price", "oi", "longRatio", "shortRatio", "liqLong", "liqShort"]:
            val = row.get(col)
            point[col] = None if pd.isna(val) else round(float(val), 4)
        out.append(point)
    return out


def build_cycle(cycle, price_daily_df):
    cid, start, end = cycle["id"], cycle["start"], cycle["end"]
    log(f"=== Construyendo {cid} ({start} -> {end}) ===")

    result = {"1d": None, "1w": None, "1h": None}

    # --- base: precio diario (siempre disponible, CoinGecko) ---
    price_slice = price_daily_df.loc[start:end].copy()

    oi_ls = None
    if cycle["want_oi"]:
        oi_ls = fetch_binance_oi_longshort_range(SYMBOL, start, end)

    liq = fetch_coinalyze_liquidations(
        "BTCUSDT_PERP.A",
        int(datetime.strptime(start, "%Y-%m-%d").timestamp() * 1000),
        int(datetime.strptime(end, "%Y-%m-%d").timestamp() * 1000),
        interval="1day",
    )

    # ---- 1D ----
    daily = price_slice.copy()
    if oi_ls is not None:
        oi_daily = oi_ls.resample("1D").mean()
        daily = daily.join(oi_daily, how="left")
    if liq is not None:
        daily = daily.join(liq.resample("1D").sum(), how="left")
    result["1d"] = to_points(daily)

    # ---- 1W ----
    weekly = price_slice.resample("1W").last()
    if oi_ls is not None:
        weekly = weekly.join(oi_ls.resample("1W").mean(), how="left")
    if liq is not None:
        weekly = weekly.join(liq.resample("1W").sum(), how="left")
    result["1w"] = to_points(weekly)

    # ---- 1H (solo si hay OI y se pidió) ----
    if cycle["want_hourly"] and oi_ls is not None:
        hourly_price = fetch_hourly_price_range(SYMBOL, start, end)
        oi_hourly = oi_ls.resample("1H").mean()
        if hourly_price is not None:
            hourly = hourly_price.join(oi_hourly, how="inner")
        else:
            hourly = price_slice.resample("1H").ffill().join(oi_hourly, how="right")
        if liq is not None:
            hourly = hourly.join(liq.resample("1H").sum(), how="left")
        result["1h"] = to_points(hourly)

    for tf, pts in result.items():
        log(f"  {cid} [{tf}]: {len(pts) if pts else 0} puntos")

    return result


def main():
    price_daily = fetch_coingecko_price_daily()

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "price": "CoinGecko API (market_chart, daily, days=max)",
            "open_interest_long_short": "data.binance.vision futures/um/daily/metrics (5-min, resampled)",
            "hourly_price_cycle3": "data.binance.vision futures/um/monthly/klines 1h",
            "liquidations": "Coinalyze API (liquidation-history)" if COINALYZE_API_KEY else "no disponible (COINALYZE_API_KEY no seteada)",
        },
        "note": "Ciclo 1 y 2 no tienen open interest / long-short / liquidaciones reales: "
                "los futuros perpetuos con esos datos no existían en 2013-2020 a esta escala. "
                "Solo llevan precio real (CoinGecko).",
    }

    for cycle in CYCLES:
        data = build_cycle(cycle, price_daily)
        out_path = os.path.join(OUT_DIR, f"{cycle['id']}.json")
        with open(out_path, "w") as f:
            json.dump(data, f)
        log(f"Escrito {out_path}")

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    log("Listo. Manifest escrito en data/manifest.json")


if __name__ == "__main__":
    main()
