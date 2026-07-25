# Bulk ranking snapshot (no Redis required)

After `npm run bulk:load` (DuckDB) and scoring:

```bash
npm run bulk:export
# or: npm run bulk:score-publish -- --no-redis
```

Writes:

| File | Purpose |
|------|---------|
| `snapshot.json.gz` | **Ship this** — gzip ranks + slim facilities |
| `snapshot.json` | Local debug only (gitignored) |

## Deploy without Upstash

1. Generate `snapshot.json.gz` locally (needs DuckDB + SAM entity index).
2. Either:
   - **Commit** `data/bulk/snapshot.json.gz` into the repo (if under ~50–80 MB), or
   - **GitHub Release** asset + set on Render:  
     `BULK_SNAPSHOT_URL=https://github.com/OWNER/REPO/releases/download/bulk-latest/snapshot.json.gz`
3. Docker already `COPY data/ ./data/` — baked snapshot is loaded at first `/api/facilities` request into memory.
4. Redis env vars are **optional**. Quota / 429 on Upstash no longer blanks the app.

## Env

| Variable | Meaning |
|----------|---------|
| `BULK_SNAPSHOT_PATH` | Absolute path to json or json.gz |
| `BULK_SNAPSHOT_URL` | HTTPS download (Release / CDN) |
| `BULK_DATA_DIR` | Override `data/bulk` directory |
| `SCORING_MODE` | `bulk` or `auto` (default) |

## Size note

~12k scored facilities + state×type rank lists typically compress to a few–tens of MB gzip. Keep the raw DuckDB out of git (already ignored).
