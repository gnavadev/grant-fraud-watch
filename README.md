# Grant Fraud Watch
Live Link: https://grant-fraud-watch.onrender.com

Explore **federal grant recipients** from [USAspending.gov](https://www.usaspending.gov) with an **audit-worthiness** score (FAC Single Audits, SAM.gov, structure signals, and sample-weighted Benford digits).

Designed for non-technical users: filter bar + table + deep dive.

> **Not proof of fraud.** Use only to decide where a human auditor might look next.

## Features

- Filters: state, city, county, facility type, free-text search
- Table with multi-column sort and audit-worthiness badges
- Deep dive: charts, official links (USAspending, SAM, FAC when available)
- Scoring: FAC + SAM + subawards + temporal structure + Benford (weight grows with sample size)
- Disk cache under `.cache/` (ephemeral on free hosts after sleep)
- Free-host friendly: cold-start banner, rate limits, compiled Node production image

## Local development

```bash
cd grant-fraud-watch
npm install
cd client && npm install && cd ..

cp .env.example .env
# FAC_API_KEY  = Data.gov key (https://api.data.gov/signup/)
# SAM_API_KEY  = SAM Account Details key (expires ~90 days)

npm run dev
```

<<<<<<< HEAD
- **App (Vite):** http://localhost:5173  
- **API:** http://localhost:3001/api/health  

Production-style locally:

=======
>>>>>>> 077d527883a1f813e6f19fbe55ebbce9697236c6
```bash
npm run build   # client + compile server → dist/
npm start       # node dist/index.js
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | API + Vite client |
| `npm run build` | Client + TypeScript server compile |
| `npm start` | Production server (`node dist/index.js`) |
| `npm test` | Scoring, location, links, logger tests |
| `npm run docker:build` | Build Docker image |

## Deploy free (Render recommended)

1. Push repo to GitHub (never commit `.env`).
2. [render.com](https://render.com) → **Blueprint** or **Web Service → Docker**.
3. Plan: **Free**.
4. Set env: `FAC_API_KEY`, `SAM_API_KEY`.
5. Open `https://….onrender.com`.

**Free tier:** spins down after ~15 min idle; first request can take ~1 minute (banner explains this). Cache is wiped on sleep, normal.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FAC_API_KEY` | Recommended | Data.gov key → FAC `X-Api-Key` |
| `SAM_API_KEY` | Recommended | SAM Account Details key (extracts + optional live API) |
| `UPSTASH_REDIS_REST_URL` | Recommended on Render | Shared cache (survives sleep; shared by all users) |
| `UPSTASH_REDIS_REST_TOKEN` | Recommended on Render | Upstash REST token |
| `SAM_LIVE_FALLBACK` | No | Set `1` only to use live Entity API for registration age (burns daily quota) |
| `PORT` | No | Default `3001` |
| `NODE_ENV` | No | `production` on deploy |

### Shared cache (Upstash Redis)

Without Redis, cache is **local disk only** and free Render wipes it on sleep.

1. Create a free database: [console.upstash.com](https://console.upstash.com) → Redis → Create  
2. Copy **REST URL** and **REST TOKEN**  
3. On Render → Environment, add:

```env
UPSTASH_REDIS_REST_URL=https://….upstash.io
UPSTASH_REDIS_REST_TOKEN=…
```

4. Redeploy. `/api/health` should show `redisOk: true` (and `cacheBackend: "redis"`).
   The URL must be the full REST host ending in **`.upstash.io`**.

First search for a filter is still slow; the **second** visitor (or retry) for the same filter should be much faster.

### Bulk offline data (next-gen scoring)

Replace rate-limited API crawl with Award Data Archive + FAC CSV downloads:

- Docs: [`docs/bulk-data.md`](docs/bulk-data.md)
- Config: [`bulk/config.json`](bulk/config.json) (FY 2021–2025, grant codes 02–05)

```bash
npm run bulk:list-usa
npm run bulk:download-usa -- --fy 2024 --agency All   # large ~1GB+
npm run bulk:download-fac
# unzip USA CSVs into data/bulk/raw/usa_extracted/
npm i duckdb
npm run bulk:load
npm run bulk:verify
# Score offline (no HTTP) and publish ranks to Upstash Redis:
npm run bulk:score-publish                 # all states in DuckDB
npm run bulk:score-publish -- --state CA   # one state (faster)
```

Render env: `SCORING_MODE=auto` (default) uses bulk ranks when present, else live APIs.
`SCORING_MODE=bulk` serves only offline ranks.

### Redis precalc (all orgs in each state × type)

For every **state × facility type**, precalc:

1. Deep USAspending award pull (default up to 40 pages ≈ 4000 awards)
2. Scores **every recipient** in that pull
3. Ranks by fraud chance
4. Writes Redis: score map + awards + ranked page blobs

```text
gfw:sc:v1:<facilityId>   →  fraud chance + signals
gfw:awards_v4_…_mp40     →  deep award list
gfw:facilities_v5_…      →  ranked pages
```

Universe size: **52 areas × 6 types ≈ 312 jobs**. Full run can take **many hours**.

**Local (writes straight to Upstash using `.env`):**

```bash
# Smoke test (one filter)
npm run scores:precalc -- --state CA --type healthcare

# First 5 jobs only
npm run scores:precalc -- --limit 5

# Full universe (leave running overnight)
npm run scores:precalc

# Force recompute
npm run scores:precalc -- --force
```

Requires in `.env`: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `FAC_API_KEY`.

Optional: `PRECALC_AWARD_PAGES=40` (max award pages per filter).

**GitHub Action: Precalc scores** — same job; secrets = same Upstash + FAC as Render.

### SAM without burning quota (prod path)

Free personal SAM keys are often **10 requests/day**. **Do not** call the live
Entity API per facility in production.

**Architecture:**

```
GitHub Action (daily/monthly)
  → SAM extracts API (1–2 GETs)
  → data/sam/exclusions_ueis.txt  (committed)
  → Release sam-data-latest / entities.sqlite
Render / Docker
  → load exclusions from data/sam (baked in image)
  → download entities.sqlite from Release once (SAM_ENTITY_DB_URL)
  → zero SAM API traffic on the web dyno (SAM_DOWNLOAD_EXTRACTS=0)
```

#### One-time GitHub setup

1. Repo → **Settings → Secrets and variables → Actions**  
   Add secret **`SAM_API_KEY`** (SAM Account Details key).
2. **Actions → SAM data sync → Run workflow** → mode **all**.
3. After it succeeds, set on Render:

```env
SAM_DOWNLOAD_EXTRACTS=0
SAM_ENTITY_DB_URL=https://github.com/<you>/<repo>/releases/download/sam-data-latest/entities.sqlite
```

(Docker already sets `SAM_DOWNLOAD_EXTRACTS=0` and copies `data/`.)

#### Local / manual

```bash
npm run sam:sync-exclusions   # → .cache
npm run sam:sync-entities     # → .cache/sam/entities.sqlite (large)
npm run sam:publish-data      # → data/sam/exclusions_ueis.txt (+ copy sqlite if present)
```

Live Entity API is **off** unless `SAM_LIVE_FALLBACK=1`. FOUO/SENSITIVE not used.

## How scoring works (short)

1. Load grants / transactions from USAspending (cached when disk available).
2. Enrich by UEI: **FAC** + **SAM**.
3. Structure signals: subaward concentration, temporal patterns, volume/program scale.
4. **Benford** digits: always charted when amounts exist; blend weight is a logistic of sample size (weak under ~100, stronger near 300+) and magnitude span.

No peer ranking. No XGBoost.

## Project layout

```
grant-fraud-watch/
  server/           Express API, scoring, FAC/SAM
  client/           Vite + React + TypeScript + Tailwind
  dist/             Compiled server (production)
  Dockerfile        Production image
  render.yaml       Free Render Blueprint
```

## Notes

- Choose a **state**, **facility type**, or **search term** before searching.
- SAM keys expire about every **90 days**.
- Search is rate-limited (~20/min per IP) to protect free hosts and upstream APIs.
