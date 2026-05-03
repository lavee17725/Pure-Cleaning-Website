# Pure Cleaning API — Cloudflare Worker

KV-backed REST API replacing JSONbin for Pure Cleaning Pressure Cleaning.

**Live URL:** `https://purecleaning-api.tylerfumero.workers.dev`

## Endpoints

| Endpoint | Description | Replaces JSONbin bin |
|---|---|---|
| `GET /health` | Status check | — |
| `GET/PUT/POST/DELETE /customers` | Customer DB | `69f2d8b6856a6821898c3bfb` |
| `GET/PUT/POST/DELETE /incoming` | Incoming Requests | `69f39ce0856a682189900bdc` |
| `GET/PUT/POST/DELETE /events` | Quote Events | `69f41bfdaaba8821975a74fa` |
| `GET/PUT/POST/DELETE /links` | Short Links | `69f427af856a682189929e8c` |

## Methods

- **GET** — Read all data
- **PUT** — Overwrite all data (body: full JSON object)
- **POST** — Append a new entry (body: single entry object; auto-assigns `id` and `createdAt`)
- **DELETE** — Remove entry by ID (`?id=<entry-id>`)

## Deploy

```bash
cd cloudflare-worker
wrangler deploy
```

## Test

```bash
# Health check
curl https://purecleaning-api.tylerfumero.workers.dev/health

# Read customers
curl https://purecleaning-api.tylerfumero.workers.dev/customers

# Write test customer
curl -X PUT https://purecleaning-api.tylerfumero.workers.dev/customers \
  -H "Content-Type: application/json" \
  -d '{"customers":[{"id":"test1","firstName":"Test","lastName":"User"}]}'

# Append to events
curl -X POST https://purecleaning-api.tylerfumero.workers.dev/events \
  -H "Content-Type: application/json" \
  -d '{"type":"quote_requested","service":"pressure_washing"}'

# Delete a link by ID
curl -X DELETE "https://purecleaning-api.tylerfumero.workers.dev/links?id=<entry-id>"
```

## KV Namespace

- **Name:** `purecleaning_data`
- **ID:** `76a0da4d65264885b06ed1f1aa25e27d`
- **Binding:** `DATA`

| KV Key | Purpose |
|---|---|
| `customer_db` | Customer records |
| `incoming_requests` | Incoming service requests |
| `quote_events` | Quote event log |
| `short_links` | Short link mappings |

## CORS

Requests from these origins are allowed:
- `https://purecleaningpressurecleaning.com`
- `https://www.purecleaningpressurecleaning.com`
- `https://lavee17725.github.io`
- `http://localhost:3000`
- `http://localhost:8000`
