// Cloudflare Pages Function — /api/coinalyze
//
// Reintentamos Coinalyze (antes fallaba con HTTP 400 corriendo desde el
// script de build, no sabemos con certeza si era la key, el símbolo, o el
// endpoint). Ahora al menos la key queda 100% oculta: se lee de una
// variable de entorno de Cloudflare Pages (Settings del proyecto →
// Environment variables → COINALYZE_API_KEY), nunca viaja al navegador.
// Si esto también falla, el aviso en pantalla lo va a decir con el error
// real de Coinalyze, no un "Failed to fetch" genérico.
//
// Uso: /api/coinalyze?metric=liquidation|openinterest|longshort|funding

export async function onRequestGet(context) {
  const { env } = context;
  const apiKey = env.COINALYZE_API_KEY;
  if (!apiKey) {
    return json({ error: "Falta la variable de entorno COINALYZE_API_KEY en Cloudflare Pages (Settings → Environment variables)." }, 500);
  }

  const url = new URL(context.request.url);
  const metric = url.searchParams.get("metric");

  const endpoints = {
    liquidation: "liquidation-history",
    openinterest: "open-interest-history",
    longshort: "long-short-ratio-history",
    funding: "funding-rate-history",
  };
  const path = endpoints[metric];
  if (!path) return json({ error: "metric debe ser liquidation | openinterest | longshort | funding" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const from = now - 30 * 86400; // últimos 30 días
  const target = `https://api.coinalyze.net/v1/${path}?symbols=BTCUSDT_PERP.A&interval=1hour&from=${from}&to=${now}`;

  try {
    const res = await fetch(target, { headers: { api_key: apiKey } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=60",
      },
    });
  } catch (err) {
    return json({ error: String(err) }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
