/**
 * Vorabpauschale Calculator — Cloudflare Worker Proxy
 *
 * Proxies two external APIs that don't send CORS headers when called from
 * a browser on garfieldpai.github.io:
 *
 *   GET /amfi          → fetches https://www.amfiindia.com/spages/NAVAll.txt
 *                        and returns it with Access-Control-Allow-Origin: *
 *
 *   GET /fx?from=INR&date=2024-12-31
 *                      → fetches https://api.frankfurter.dev/v1/{date}?from={from}&to=EUR
 *                        and returns the JSON with CORS headers
 *
 * Deploy to Cloudflare Workers (free tier: 100,000 requests/day):
 *   1. Go to https://workers.cloudflare.com and create a free account
 *   2. Create a new Worker and paste this code
 *   3. Deploy — you'll get a URL like https://vorabpauschale-proxy.YOUR-SUBDOMAIN.workers.dev
 *   4. Update PROXY_BASE in app.js to that URL
 *
 * The Worker only proxies these two specific endpoints — it won't relay
 * arbitrary URLs, so there's no risk of it being abused as an open proxy.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Route: /amfi → AMFI NAVAll.txt (today's NAVs with ISINs and scheme codes)
    if (url.pathname === '/amfi') {
      const amfiUrl = 'https://www.amfiindia.com/spages/NAVAll.txt';
      const upstream = await fetch(amfiUrl, {
        headers: { 'User-Agent': 'VorabpauschaleCalculator/1.0' },
        cf: { cacheTtl: 3600 } // cache for 1 hour — NAVs update once per day
      });
      if (!upstream.ok) {
        return new Response(`AMFI fetch failed: ${upstream.status}`, {
          status: upstream.status,
          headers: CORS_HEADERS
        });
      }
      const text = await upstream.text();
      return new Response(text, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        }
      });
    }

    // Route: /fx?from=INR&date=2024-12-31 → Frankfurter exchange rate
    if (url.pathname === '/fx') {
      const from = url.searchParams.get('from');
      const date = url.searchParams.get('date');
      if (!from || !date) {
        return new Response('Missing ?from= or ?date= parameter', {
          status: 400, headers: CORS_HEADERS
        });
      }
      const fxUrl = `https://api.frankfurter.dev/v1/${date}?from=${encodeURIComponent(from)}&to=EUR`;
      const upstream = await fetch(fxUrl, {
        cf: { cacheTtl: 86400 } // cache for 24 hours — historical rates don't change
      });
      if (!upstream.ok) {
        return new Response(`Frankfurter fetch failed: ${upstream.status}`, {
          status: upstream.status, headers: CORS_HEADERS
        });
      }
      const json = await upstream.text();
      return new Response(json, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=86400',
        }
      });
    }

    // Route: /nav/{schemeCode} → mfapi.in historical NAV (already CORS-enabled,
    // but proxying here too for reliability and consistent error handling)
    const navMatch = url.pathname.match(/^\/nav\/(\d+)$/);
    if (navMatch) {
      const schemeCode = navMatch[1];
      const navUrl = `https://api.mfapi.in/mf/${schemeCode}`;
      const upstream = await fetch(navUrl, {
        cf: { cacheTtl: 3600 }
      });
      if (!upstream.ok) {
        return new Response(`mfapi.in fetch failed: ${upstream.status}`, {
          status: upstream.status, headers: CORS_HEADERS
        });
      }
      const json = await upstream.text();
      return new Response(json, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        }
      });
    }

    return new Response('Not found. Valid paths: /amfi, /fx, /nav/{schemeCode}', {
      status: 404, headers: CORS_HEADERS
    });
  }
};
