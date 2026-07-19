# Grant Fraud Watch

Explore **federal grant recipients** from [USAspending.gov](https://www.usaspending.gov) with an **audit-worthiness** score (FAC Single Audits, SAM.gov, structure signals, and sample-weighted Benford digits).

Designed for non-technical users: filter bar + table + deep dive.

> **Not proof of fraud.** Use only to decide where a human auditor might look next.

## Features

- Filters: state, city, county, facility type, free-text search
- Table with multi-column sort and fraud / audit-worthiness badges
- Deep dive: charts, official links (USAspending, SAM, FAC when available)
- Scoring: FAC + SAM + subawards + temporal structure + Benford (weight grows with sample size)
- Disk cache under `.cache/`

## Local development

```bash
cd grant-fraud-watch
npm install
cd client && npm install && cd ..

# Copy env template and add keys
cp .env.example .env
# FAC_API_KEY  = Data.gov key (https://api.data.gov/signup/)
# SAM_API_KEY  = SAM Account Details key (expires ~90 days)

npm run dev
```

- **App (Vite):** http://localhost:5173  
- **API:** http://localhost:3001/api/health  

Production-style (single process, built client):

```bash
npm run build
npm start
# http://localhost:3001
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | API + Vite client |
| `npm run build` | Production client → `client/dist` |
| `npm start` | Express API + static client |
| `npm run test:benford` | Scoring unit checks |
| `npm run docker:build` | Build Docker image |
| `npm run docker:run` | Run image with `.env` |

## Deploy free (recommended)

The app is **one Docker container**: Node serves `/api/*` and the built React UI.

### 1. Put the code on GitHub

```bash
cd grant-fraud-watch
git init
git add .
git commit -m "Initial grant-fraud-watch"
# create a private repo on GitHub, then:
git remote add origin https://github.com/YOUR_USER/grant-fraud-watch.git
git push -u origin main
```

**Never commit `.env`.** Only `.env.example` is tracked.

### 2. Render free tier (easiest free Docker host)

1. Sign up at [render.com](https://render.com) (free).
2. **New → Blueprint** → connect the repo (uses `render.yaml`),  
   **or** **New → Web Service** → Docker → select repo.
3. Plan: **Free**.
4. Environment variables (Dashboard → Environment):

   | Key | Value |
   |-----|--------|
   | `FAC_API_KEY` | Data.gov key |
   | `SAM_API_KEY` | SAM Account Details key |

5. Deploy. Open the `*.onrender.com` URL.

**Free tier notes:** the service **spins down** after idle; first request after sleep can take ~30–60s. Cache is ephemeral (OK for this app).

### 3. Other free-ish options

| Platform | Notes |
|----------|--------|
| **[Railway](https://railway.app)** | Free trial credits; Docker or Nixpacks |
| **[Fly.io](https://fly.io)** | Small free allowance; `fly launch` + secrets |
| **[Koyeb](https://www.koyeb.com)** | Free web service tier |
| **[Google Cloud Run](https://cloud.google.com/run)** | Generous free tier; pay only if over quota |

All of them: set `FAC_API_KEY` + `SAM_API_KEY`, expose port from `PORT` (the app already reads it).

### Local Docker check

```bash
docker build -t grant-fraud-watch .
docker run --rm -p 3001:3001 --env-file .env grant-fraud-watch
# http://localhost:3001
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FAC_API_KEY` | Recommended | Data.gov key → FAC `X-Api-Key` |
| `SAM_API_KEY` | Recommended | SAM Account Details key → `api_key=` |
| `PORT` | No | Default `3001` (hosts usually inject this) |
| `NODE_ENV` | No | Set `production` on deploy |

## How scoring works (short)

1. Load grants / transactions from USAspending (cached).
2. Enrich by UEI: **FAC** (Single Audit flags) + **SAM** (exclusions, registration age).
3. Structure signals: subaward concentration, temporal patterns, volume/program scale.
4. **Benford** digits: always charted; blend weight is a logistic of sample size (weak under ~100, stronger near 300+) and magnitude span. Grant caps make digit tests secondary.

## Project layout

```
grant-fraud-watch/
  server/           Express API, scoring, FAC/SAM
  client/           Vite + React + TypeScript + Tailwind
  Dockerfile        Production image
  render.yaml       Free Render Blueprint
  .env.example      Env template (safe to commit)
```

## Notes

- Choose a **state**, **facility type**, or **search term** before searching.
- SAM keys expire about every **90 days** — regenerate on SAM Account Details if lookups fail.
- County is a soft text filter after aggregation.
