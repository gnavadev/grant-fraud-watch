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
| `SAM_API_KEY` | Recommended | SAM Account Details key → `api_key=` |
| `PORT` | No | Default `3001` |
| `NODE_ENV` | No | `production` on deploy |

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
