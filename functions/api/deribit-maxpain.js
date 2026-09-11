// Cloudflare Pages Function — /api/deribit-maxpain
//
// Deribit publica gratis, sin key, el open interest de opciones por
// instrumento (strike + vencimiento + tipo). Acá lo agrupamos y calculamos
// Max Pain con la fórmula pública estándar: el precio de liquidación donde
// el total que cobrarían los tenedores de opciones (put+call) es MÍNIMO —
// osea, donde los emisores de opciones pierden menos.
//
// OJO: esto es Max Pain de OPCIONES. No es el mismo cálculo que hace
// Coinglass para futuros perpetuos (ese es propietario de ellos, no público).
// Es una métrica real y con fórmula conocida, pero mide otra cosa.
//
// Uso: /api/deribit-maxpain?currency=BTC

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const currency = (url.searchParams.get("currency") || "BTC").toUpperCase();

  try {
    const res = await fetch(
      `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`,
      { headers: { "User-Agent": "btc-terminal-proxy/1.0" } }
    );
    if (!res.ok) return json({ error: `Deribit HTTP ${res.status}` }, 502);
    const data = await res.json();
    const rows = (data && data.result) || [];
    if (!rows.length) return json({ error: "Deribit no devolvió instrumentos de opciones" }, 502);

    // instrument_name típico: "BTC-27DEC24-100000-C"
    const byExpiry = new Map();
    let spot = null;

    for (const r of rows) {
      const parts = (r.instrument_name || "").split("-");
      if (parts.length !== 4) continue;
      const [, expiryStr, strikeStr, typeChar] = parts;
      const strike = parseFloat(strikeStr);
      const oi = parseFloat(r.open_interest) || 0;
      if (!isFinite(strike)) continue;
      if (r.underlying_price) spot = parseFloat(r.underlying_price);

      if (!byExpiry.has(expiryStr)) byExpiry.set(expiryStr, new Map());
      const strikes = byExpiry.get(expiryStr);
      if (!strikes.has(strike)) strikes.set(strike, { callOI: 0, putOI: 0 });
      const entry = strikes.get(strike);
      if (typeChar === "C") entry.callOI += oi;
      else if (typeChar === "P") entry.putOI += oi;
    }

    // Elegimos el vencimiento más próximo en el tiempo (orden alfabético de
    // fecha Deribit no sirve para ordenar cronológicamente entre años, así
    // que parseamos cada expiry a fecha real).
    function parseExpiry(str) {
      // formato "27DEC24" -> día, mes (3 letras), año de 2 dígitos
      const m = str.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
      if (!m) return null;
      const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
      const day = parseInt(m[1], 10);
      const month = months[m[2]];
      const year = 2000 + parseInt(m[3], 10);
      if (month === undefined) return null;
      return new Date(Date.UTC(year, month, day, 8, 0, 0)); // Deribit liquida ~08:00 UTC
    }

    const now = Date.now();
    let nearestExpiry = null, nearestDate = null;
    for (const expiryStr of byExpiry.keys()) {
      const d = parseExpiry(expiryStr);
      if (!d || d.getTime() < now) continue;
      if (!nearestDate || d < nearestDate) { nearestDate = d; nearestExpiry = expiryStr; }
    }
    if (!nearestExpiry) return json({ error: "no se encontró un vencimiento futuro" }, 502);

    const strikesMap = byExpiry.get(nearestExpiry);
    const distribution = [...strikesMap.entries()]
      .map(([strike, v]) => ({ strike, callOI: v.callOI, putOI: v.putOI }))
      .sort((a, b) => a.strike - b.strike);

    const strikeList = distribution.map(d => d.strike);
    let maxPainStrike = null, minPayout = Infinity;
    for (const S of strikeList) {
      let payout = 0;
      for (const d of distribution) {
        payout += d.callOI * Math.max(0, S - d.strike);
        payout += d.putOI * Math.max(0, d.strike - S);
      }
      if (payout < minPayout) { minPayout = payout; maxPainStrike = S; }
    }

    const totalCallOI = distribution.reduce((s, d) => s + d.callOI, 0);
    const totalPutOI = distribution.reduce((s, d) => s + d.putOI, 0);

    return json({
      currency,
      expiry: nearestExpiry,
      expiryDate: nearestDate.toISOString(),
      spot,
      maxPainStrike,
      totalCallOI,
      totalPutOI,
      putCallRatio: totalCallOI > 0 ? totalPutOI / totalCallOI : null,
      distribution,
      updatedAt: new Date().toISOString(),
    }, 200, 30);
  } catch (err) {
    return json({ error: String(err) }, 502);
  }
}

function json(obj, status, maxAge) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...(maxAge ? { "cache-control": `public, max-age=${maxAge}` } : {}),
    },
  });
}
