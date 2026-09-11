// Cloudflare Pages Function — /api/okx
//
// OKX es público y sin key, pero lo pasamos igual por acá (server-to-server)
// para no depender de si el navegador del usuario tiene bloqueado ese host
// por algún adblock/privacidad, y para poder cachear un toque en el edge.
//
// Uso: /api/okx?metric=oi|funding|longshort&period=1H|1D

const INST_ID = "BTC-USDT-SWAP";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const metric = url.searchParams.get("metric");
  const period = url.searchParams.get("period") || "1H"; // OKX usa "5m","1H","1D"

  let target;
  if (metric === "oi") {
    target = `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=${period}`;
  } else if (metric === "funding") {
    target = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${INST_ID}&limit=100`;
  } else if (metric === "longshort") {
    target = `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?ccy=BTC&period=${period}`;
  } else {
    return json({ error: "metric debe ser oi | funding | longshort" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(target, { headers: { "User-Agent": "btc-terminal-proxy/1.0" } });
    const body = await res.text();
    const response = new Response(body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=25",
      },
    });
    if (res.ok) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
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
