// Cloudflare Pages Function — /api/bitfinex
//
// Bitfinex no manda header Access-Control-Allow-Origin en
// /v2/stats1/pos.size:... , así que el navegador bloquea el fetch directo
// (CORS). Server-to-server (acá) no aplica esa restricción — CORS es una
// regla que solo enforcea el navegador. Este endpoint le pide el dato a
// Bitfinex desde el servidor de Cloudflare y se lo devuelve a nuestro
// front ya con el header puesto.
//
// Uso: /api/bitfinex?side=long   ó   /api/bitfinex?side=short

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const side = url.searchParams.get("side");

  if (side !== "long" && side !== "short") {
    return new Response(JSON.stringify({ error: "side debe ser 'long' o 'short'" }), {
      status: 400,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const bitfinexUrl = `https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:tBTCUSD:${side}/hist?limit=200`;

  try {
    const res = await fetch(bitfinexUrl, {
      headers: { "User-Agent": "btc-terminal-proxy/1.0" },
    });
    const body = await res.text();
    const response = new Response(body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=25", // acompaña el auto-refresh de 30s del front
      },
    });
    if (res.ok) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }
}
