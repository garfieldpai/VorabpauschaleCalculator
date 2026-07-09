/**
 * Vorabpauschale Calculator — Cloudflare Worker Proxy v2
 * 
 * Proxies AMFI NAV data and Frankfurter FX rates with CORS headers.
 * Deploy to Cloudflare Workers (free tier: 100,000 requests/day).
 * 
 * Routes:
 *   GET /amfi                              → AMFI NAVAll.txt
 *   GET /fx?from=INR&date=2024-12-31       → Frankfurter EUR rate
 *   GET /nav/120503                        → mfapi.in NAV history
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body, status, contentType, cacheSeconds) {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${cacheSeconds}`,
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Normalize path — remove double slashes, trim trailing slash
    const path = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

    // Route: /amfi
    if (path === '/amfi') {
      try {
        const resp = await fetch('https://www.amfiindia.com/spages/NAVAll.txt', {
          headers: { 'User-Agent': 'VorabpauschaleCalculator/1.0' }
        });
        if (!resp.ok) return corsResponse(`AMFI error: ${resp.status}`, resp.status, 'text/plain', 0);
        const text = await resp.text();
        return corsResponse(text, 200, 'text/plain; charset=utf-8', 3600);
      } catch (e) {
        return corsResponse(`AMFI fetch failed: ${e.message}`, 502, 'text/plain', 0);
      }
    }

    // Route: /fx?from=INR&date=2024-12-31
    if (path === '/fx') {
      const from = url.searchParams.get('from');
      const date = url.searchParams.get('date');
      if (!from || !date) {
        return corsResponse('Missing ?from= or ?date=', 400, 'text/plain', 0);
      }
      try {
        const fxUrl = `https://api.frankfurter.dev/v1/${date}?from=${encodeURIComponent(from)}&to=EUR`;
        const resp = await fetch(fxUrl);
        if (!resp.ok) return corsResponse(`Frankfurter error: ${resp.status}`, resp.status, 'application/json', 0);
        const json = await resp.text();
        return corsResponse(json, 200, 'application/json', 86400);
      } catch (e) {
        return corsResponse(`FX fetch failed: ${e.message}`, 502, 'text/plain', 0);
      }
    }

    // Route: /nav/120503
    const navMatch = path.match(/^\/nav\/(\d+)$/);
    if (navMatch) {
      try {
        const resp = await fetch(`https://api.mfapi.in/mf/${navMatch[1]}`);
        if (!resp.ok) return corsResponse(`mfapi error: ${resp.status}`, resp.status, 'application/json', 0);
        const json = await resp.text();
        return corsResponse(json, 200, 'application/json', 3600);
      } catch (e) {
        return corsResponse(`NAV fetch failed: ${e.message}`, 502, 'text/plain', 0);
      }
    }

    // Debug: show what path was received (helpful during setup)
    return corsResponse(
      `Vorabpauschale proxy — path not found: "${path}"\nValid: /amfi  /fx?from=INR&date=YYYY-MM-DD  /nav/{schemeCode}`,
      404, 'text/plain', 0
    );
  }
};
