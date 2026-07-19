# SAM slim data (prod-friendly)

This folder holds **small, redistributable indexes** built from SAM.gov **public** extracts.
The app loads these **before** calling SAM, so Render does not burn your 10/day Entity API quota.

| File | Source | Typical size | Refresh |
|------|--------|--------------|---------|
| `exclusions_ueis.txt` | Public exclusions extract | ~few MB | Daily (GitHub Action) |
| `entities.sqlite` | Public monthly entity extract (slim) | tens–hundreds of MB | Monthly (Action → Release) |

## Local / CI build

```bash
# needs SAM_API_KEY in env (Account Details key)
npm run sam:sync-exclusions   # writes .cache + data/sam/exclusions_ueis.txt
npm run sam:sync-entities     # writes .cache/sam/entities.sqlite
npm run sam:publish-data      # copy slim files into data/sam for commit / release
```

## GitHub Action

Workflow: `.github/workflows/sam-data.yml`

1. **Daily:** download exclusions → commit `data/sam/exclusions_ueis.txt`
2. **Monthly / manual:** download entity extract → build SQLite → upload as Release asset `entities.sqlite` under tag `sam-data-latest`

### Secrets

| Secret | Purpose |
|--------|---------|
| `SAM_API_KEY` | SAM public API key |
| `GITHUB_TOKEN` | Provided automatically for commit + release |

### Render

- Bake `data/sam/exclusions_ueis.txt` into the image (repo file).
- Optional env for entity index:

```env
# Download slim entity DB from GitHub Release on boot if missing
SAM_ENTITY_DB_URL=https://github.com/OWNER/REPO/releases/download/sam-data-latest/entities.sqlite
```

Or copy `entities.sqlite` into `data/sam/` before Docker build.

## Do not commit

- Raw SAM ZIPs / full `.dat` extracts  
- `.cache/sam/*` (gitignored)
