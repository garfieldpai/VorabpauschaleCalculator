/**
 * Vorabpauschale Calculator — Cloudflare Worker Proxy v4
 *
 * Routes:
 *   GET /isin/{ISIN}                   → scheme code from built-in ISIN_MAP
 *   GET /nav/{schemeCode}              → NAV history from mfapi.in
 *   GET /fx?from=INR&date=YYYY-MM-DD  → EUR rate from Frankfurter
 *
 * To add a fund: find its scheme code at https://www.mfapi.in, add to ISIN_MAP, redeploy.
 * All scheme codes verified from mfapi.in full scheme list (July 2026).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function ok(body, ct, ttl) {
  return new Response(body, {
    headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': `public, max-age=${ttl}` }
  });
}
function fail(msg, status) {
  return new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });
}

// Verified from mfapi.in full scheme list, July 2026
// Find additional codes at: https://www.mfapi.in (search by fund name)
const ISIN_MAP = {
  // Ajith's funds — all verified by ISIN exact match from MF_List.txt
  'INF179K01CR2': { code: 105758,  name: 'HDFC Mid Cap Fund - Growth Plan' },
  'INF179KA1RZ8': { code: 130502,  name: 'HDFC Small Cap Fund - Growth Option' },
  'INF179K01830': { code: 100119,  name: 'HDFC Balanced Advantage Fund - Growth Plan' },
  'INF209K01BR9': { code: 103174,  name: 'Aditya Birla Sun Life Large Cap Fund - Growth' },
  'INF277K019K2': { code: 144548,  name: 'Tata Flexi Cap Fund - Regular Plan - Growth' },
  'INF174K01336': { code: 112090,  name: 'Kotak Flexicap Fund - Growth' },
  'INF204K01AE0': { code: 101262,  name: 'Nippon India Power & Infra Fund - Growth' },
  'INF903JA1EX7': { code: 144838,  name: 'Sundaram Services Fund Regular Plan - Growth' },
  // Other common funds
  'INF879O01019': { code: 122640,  name: 'Parag Parikh Flexi Cap Fund - Regular Growth' },
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

    // /fx?from=INR&date=2024-12-31
    if (path === '/fx') {
      const from = url.searchParams.get('from');
      const date = url.searchParams.get('date');
      if (!from || !date) return fail('Missing ?from= or ?date=', 400);
      try {
        const r = await fetch(`https://api.frankfurter.dev/v1/${date}?from=${from}&to=EUR`);
        if (!r.ok) return fail(`Frankfurter: ${r.status}`, r.status);
        return ok(await r.text(), 'application/json', 86400);
      } catch (e) {
        return fail(`FX error: ${e.message}`, 502);
      }
    }

    // /nav/105758
    const navM = path.match(/^\/nav\/(\d+)$/);
    if (navM) {
      try {
        const r = await fetch(`https://api.mfapi.in/mf/${navM[1]}`);
        if (!r.ok) return fail(`mfapi: ${r.status}`, r.status);
        return ok(await r.text(), 'application/json', 3600);
      } catch (e) {
        return fail(`NAV error: ${e.message}`, 502);
      }
    }

    // /isin/INF179K01CR2
    const isinM = path.match(/^\/isin\/([A-Z0-9]{12})$/i);
    if (isinM) {
      const isin = isinM[1].toUpperCase();

      // 1. Built-in map (instant)
      if (ISIN_MAP[isin]) {
        return ok(JSON.stringify(ISIN_MAP[isin]), 'application/json', 86400);
      }

      // 2. Captnemo fallback with strict ISIN verification
      try {
        const r = await fetch(`https://mf.captnemo.in/nav/${isin}`);
        if (r.ok) {
          const data = await r.json();
          if (data?.ISIN?.toUpperCase() === isin && data?.historical_nav?.length) {
            return ok(JSON.stringify({
              code: null,
              name: data.name,
              captnemoData: data.historical_nav
            }), 'application/json', 86400);
          }
          if (data?.ISIN?.toUpperCase() !== isin) {
            return fail(
              `ISIN ${isin} not in built-in map. captnemo returned wrong fund (${data?.ISIN}).\n` +
              `Add this ISIN to ISIN_MAP in worker.js — find scheme code at https://www.mfapi.in`,
              404
            );
          }
        }
      } catch (e) { /* ignore */ }

      return fail(
        `ISIN ${isin} not found.\n` +
        `Add to ISIN_MAP in worker.js:\n` +
        `1. Find scheme code: https://www.mfapi.in\n` +
        `2. Add: '${isin}': { code: SCHEME_CODE, name: 'Fund Name' }`,
        404
      );
    }

    return fail(
      `Vorabpauschale proxy — path not found: "${path}"\n` +
      `Valid: /fx?from=INR&date=YYYY-MM-DD  /isin/{ISIN}  /nav/{schemeCode}`,
      404
    );
  }
};
