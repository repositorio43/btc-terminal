// Cloudflare Pages Function — /api/bybit
//
// Igual criterio que okx.js: público y sin key, pasa server-to-server para
// no depender de bloqueos del lado del navegador y para poder cachear.
//
// Uso: /api/bybit?metric=oi|funding|longshort&period=1h|1d

const SYMBOL = "BTCUSDT";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const metric = url.searchParams.get("metric");
  const period = url.searchParams.get("period") || "1h"; // Bybit usa "5min","15min","1h","4h","1d"

  let target;
  if (metric === "oi") {
    target = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${SYMBOL}&intervalTime=${period}&limit=200`;
  } else if (metric === "funding") {
    target = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${SYMBOL}&limit=200`;
  } else if (metric === "longshort") {
    target = `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${SYMBOL}&period=${period}&limit=200`;
  } else {
    return json({ error: "metric debe ser oi | funding | longshort" }, 400);
  }

  try {
    const res = await fetch(target, { headers: { "User-Agent": "btc-terminal-proxy/1.0" } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=30",
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
