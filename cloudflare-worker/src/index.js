// Cloudflare Worker for Pure Cleaning Pressure Cleaning
// Replaces JSONbin with KV-backed REST API

const ALLOWED_ORIGINS = [
  'https://purecleaningpressurecleaning.com',
  'https://www.purecleaningpressurecleaning.com',
  'https://lavee17725.github.io',  // GitHub Pages backup
  'http://localhost:3000',  // local dev
  'http://localhost:8000',  // local dev
];

const KV_KEYS = {
  customers: 'customer_db',
  incoming: 'incoming_requests',
  events: 'quote_events',
  links: 'short_links',
  blockedWeeks: 'blocked_weeks',
};

const DEFAULT_SERVICE_FREQUENCY = {
  primary: [
    { id: 'rinse_walls',   name: 'Rinse Walls',         count: 1117, pct: 60.3 },
    { id: 'entranceway',   name: 'Entranceway',         count: 1042, pct: 56.3 },
    { id: 'driveway',      name: 'Driveway',            count: 965,  pct: 52.1 },
    { id: 'roof_cleaning', name: 'Roof Cleaning',       count: 944,  pct: 51.0 },
    { id: 'patio',         name: 'Patio',               count: 943,  pct: 50.9 },
    { id: 'walkway',       name: 'Walkway / Sidewalk',  count: 802,  pct: 43.3 },
  ],
  secondary: [
    { id: 'fence',         name: 'Fence',               count: 89,   pct: 4.8 },
    { id: 'rust_removal',  name: 'Rust Removal',        count: 39,   pct: 2.1 },
    { id: 'sealing',       name: 'Sealing',             count: 35,   pct: 1.9 },
    { id: 'gutters',       name: 'Gutters',             count: 31,   pct: 1.7 },
    { id: 'pool_deck',     name: 'Pool Deck',           count: 27,   pct: 1.5 },
    { id: 'windows',       name: 'Windows',             count: 25,   pct: 1.4 },
    { id: 'paver_sand',    name: 'Pavers / Joint Sand', count: 25,   pct: 1.3 },
    { id: 'garage',        name: 'Garage',              count: 16,   pct: 0.9 },
    { id: 'balcony',       name: 'Balcony',             count: 13,   pct: 0.7 },
  ],
  totalJobsAnalyzed: 1851,
  lastAnalyzed: '2026-05-02T00:00:00.000Z',
};

const DEFAULT_ADDONS_CONFIG = {
  addons: [
    { id: 'driveway',   name: 'Driveway Cleaning',            bundle: 150, standalone: 200, icon: '🛣️', description: '' },
    { id: 'patio',      name: 'Patio Cleaning',               bundle: 100, standalone: 150, icon: '🪨', description: '' },
    { id: 'walkways',   name: 'Walkways / Sidewalks',         bundle: 75,  standalone: 125, icon: '🚶', description: '' },
    { id: 'paver_sand', name: 'Paver Joint Sand Replacement', bundle: 200, standalone: 275, icon: '🧱', description: 'Stops weeds. Restores the clean look between pavers. We do this right after cleaning while they\'re prepped.' },
    { id: 'rust',       name: 'Rust Removal',                 bundle: 50,  standalone: 75,  icon: '🔧', description: '' },
    { id: 'awnings',    name: 'Awning Cleaning',              bundle: 100, standalone: 150, icon: '🏠', description: '' },
  ],
  sealing: {
    description: 'After we clean your driveway or patio, sealing locks in the clean look and protects against oil and grease stains, mildew regrowth, and color fading. Lasts 2–3 years. Pricing depends on surface size and condition — we\'ll quote it in person on the day of cleaning.',
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors(origin);
    }

    // CORS headers for actual requests
    const corsHeaders = getCorsHeaders(origin);

    try {
      // Route handling
      const path = url.pathname.replace(/^\/+|\/+$/g, '');

      if (path === 'health') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() }, corsHeaders);
      }

      if (path === 'customers') {
        return await handleResource(request, env, KV_KEYS.customers, corsHeaders);
      }

      if (path === 'incoming') {
        return await handleResource(request, env, KV_KEYS.incoming, corsHeaders);
      }

      if (path === 'events') {
        if (request.method === 'GET') {
          const data = await env.DATA.get(KV_KEYS.events, 'json') || { events: [] };
          const since = url.searchParams.get('since');
          if (since) {
            const sinceMs = new Date(since).getTime();
            if (!isNaN(sinceMs)) {
              data.events = (data.events || []).filter(e => {
                const ts = new Date(e.createdAt || e.loggedAt || 0).getTime();
                return ts >= sinceMs;
              });
            }
          }
          const phone = url.searchParams.get('phone');
          if (phone) {
            data.events = (data.events || []).filter(e => e.customer?.ph === phone);
          }
          return jsonResponse(data, corsHeaders);
        }
        return await handleResource(request, env, KV_KEYS.events, corsHeaders);
      }

      if (path === 'links') {
        return await handleResource(request, env, KV_KEYS.links, corsHeaders);
      }

      if (path === 'blocked-weeks') {
        return await handleResource(request, env, KV_KEYS.blockedWeeks, corsHeaders);
      }

      if (path === 'reviews') {
        if (request.method === 'GET') {
          const data = await env.DATA.get('reviews_data', 'json') || { count: 101, lastUpdated: null };
          return jsonResponse(data, corsHeaders);
        }
        if (request.method === 'PUT') {
          const body = await request.json();
          const data = { count: parseInt(body.count) || 101, lastUpdated: new Date().toISOString() };
          await env.DATA.put('reviews_data', JSON.stringify(data));
          return jsonResponse({ success: true, ...data }, corsHeaders);
        }
        return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
      }

      if (path === 'service-frequency') {
        if (request.method === 'GET') {
          const data = await env.DATA.get('service_frequency', 'json') || DEFAULT_SERVICE_FREQUENCY;
          return jsonResponse(data, corsHeaders);
        }
        if (request.method === 'PUT') {
          const body = await request.json();
          await env.DATA.put('service_frequency', JSON.stringify(body));
          return jsonResponse({ success: true }, corsHeaders);
        }
        return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
      }

      if (path === 'addons-config') {
        if (request.method === 'GET') {
          const config = await env.DATA.get('addons_config', 'json') || DEFAULT_ADDONS_CONFIG;
          return jsonResponse(config, corsHeaders);
        }
        if (request.method === 'PUT') {
          const body = await request.json();
          await env.DATA.put('addons_config', JSON.stringify(body));
          return jsonResponse({ success: true }, corsHeaders);
        }
        return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
      }

      if (path.startsWith('quote/')) {
        const quoteCode = path.slice('quote/'.length);
        if (!quoteCode) return jsonResponse({ error: 'Quote code required' }, corsHeaders, 400);
        return await handleQuote(request, env, quoteCode, corsHeaders);
      }

      // ════════════════════════════════════════════════════════════════════════
      // PHASE 2: BOUNCIE GPS INTEGRATION (NOT YET ACTIVE — awaiting hardware)
      // ════════════════════════════════════════════════════════════════════════
      // When Bouncie devices arrive and are registered at bouncie.dev:
      //   1. Add Worker secrets: BOUNCIE_CLIENT_ID, BOUNCIE_CLIENT_SECRET, BOUNCIE_REFRESH_TOKEN
      //   2. Activate these endpoints by removing the comment block:
      //
      // if (path === 'trucks') {
      //   // GET  /trucks → current location of all 3 rigs from KV
      //   if (request.method === 'GET') {
      //     const data = await env.DATA.get('truck_locations', 'json') || { trucks: [] };
      //     return jsonResponse(data, corsHeaders);
      //   }
      //   // POST /trucks/sync → fetch Bouncie API, update KV, detect arrivals
      //   if (request.method === 'POST') {
      //     return await handleBouncieSync(request, env, corsHeaders);
      //   }
      // }
      //
      // Phase 3: Auto-detect job arrivals/departures (within 100ft Haversine)
      // Phase 4: Cost-per-sqft analytics (after 30+ GPS-tracked jobs with sq footage)
      // Phase 5: Pricing suggestion engine in quote builder
      // Phase 6: Demand forecasting + crew optimization
      // ════════════════════════════════════════════════════════════════════════

      return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
    } catch (err) {
      console.error('Worker error', err);
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    }
  },
};

async function handleResource(request, env, kvKey, corsHeaders) {
  if (request.method === 'GET') {
    const data = await env.DATA.get(kvKey, 'json');
    return jsonResponse(data || {}, corsHeaders);
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    await env.DATA.put(kvKey, JSON.stringify(body));
    return jsonResponse({ success: true }, corsHeaders);
  }

  if (request.method === 'POST') {
    // Append a new entry to a list-style resource
    const newEntry = await request.json();
    const existing = await env.DATA.get(kvKey, 'json') || {};

    // Determine the array field name based on resource
    const arrayField = getArrayField(kvKey);
    if (!existing[arrayField]) existing[arrayField] = [];

    // Add ID and timestamp if not present
    if (!newEntry.id) newEntry.id = generateId();
    if (!newEntry.createdAt) newEntry.createdAt = new Date().toISOString();

    existing[arrayField].push(newEntry);
    await env.DATA.put(kvKey, JSON.stringify(existing));

    return jsonResponse({ success: true, entry: newEntry }, corsHeaders);
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return jsonResponse({ error: 'ID required' }, corsHeaders, 400);

    const existing = await env.DATA.get(kvKey, 'json') || {};
    const arrayField = getArrayField(kvKey);
    if (existing[arrayField]) {
      existing[arrayField] = existing[arrayField].filter(e => e.id !== id);
      await env.DATA.put(kvKey, JSON.stringify(existing));
    }

    return jsonResponse({ success: true }, corsHeaders);
  }

  return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
}

async function handleQuote(request, env, quoteCode, corsHeaders) {
  const kvKey = `quote_${quoteCode}`;

  if (request.method === 'GET') {
    const data = await env.DATA.get(kvKey, 'json');
    if (!data) return jsonResponse({ error: 'Quote not found' }, corsHeaders, 404);
    return jsonResponse(data, corsHeaders);
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    if (!body.createdAt) body.createdAt = new Date().toISOString();
    body.lastUpdated = new Date().toISOString();
    await env.DATA.put(kvKey, JSON.stringify(body));
    return jsonResponse({ success: true, code: quoteCode }, corsHeaders);
  }

  if (request.method === 'PATCH') {
    const existing = await env.DATA.get(kvKey, 'json');
    if (!existing) return jsonResponse({ error: 'Quote not found' }, corsHeaders, 404);
    const updates = await request.json();
    const merged = { ...existing, ...updates, lastUpdated: new Date().toISOString() };
    await env.DATA.put(kvKey, JSON.stringify(merged));
    return jsonResponse({ success: true, quote: merged }, corsHeaders);
  }

  if (request.method === 'DELETE') {
    await env.DATA.delete(kvKey);
    return jsonResponse({ success: true }, corsHeaders);
  }

  return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
}

function getArrayField(kvKey) {
  if (kvKey === KV_KEYS.customers) return 'customers';
  if (kvKey === KV_KEYS.incoming) return 'requests';
  if (kvKey === KV_KEYS.events) return 'events';
  if (kvKey === KV_KEYS.links) return 'links';
  if (kvKey === KV_KEYS.blockedWeeks) return 'blockedWeeks';
  return 'items';
}

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function handleCors(origin) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}
