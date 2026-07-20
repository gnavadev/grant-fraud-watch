/**
 * CLI: refresh SAM public extracts into .cache/sam/
 *
 *   npm run sam:sync-exclusions   # exclusions only (small, ~1/day)
 *   npm run sam:sync-entities     # monthly entity → SQLite (large, ~1/month)
 *   npm run sam:sync              # both
 *
 * Uses PUBLIC sensitivity only (personal API key). FOUO/SENSITIVE need federal system accounts.
 *
 * Manual bootstrap if API quota is blocked:
 *   .cache/sam/exclusions_manual.zip|.csv
 *   .cache/sam/entity_manual.zip
 */
import { loadEnv } from "./env.js";
import { ensureSamExclusionsIndex, getSamExtractStatus } from "./samExtract.js";
import {
  getEntityExtractStatus,
  syncSamEntityExtract,
} from "./samEntityExtract.js";

loadEnv();

// Prefer live download in CI / explicit sync (empty data/ must not win)
if (process.env.CI === "true" || process.argv.includes("--force")) {
  process.env.SAM_FORCE_DOWNLOAD = process.env.SAM_FORCE_DOWNLOAD ?? "1";
}

const mode = (process.argv[2] ?? "all").toLowerCase();

async function syncExclusions() {
  console.log(
    JSON.stringify({
      hasSamKey: Boolean(process.env.SAM_API_KEY?.trim()),
      forceDownload: process.env.SAM_FORCE_DOWNLOAD,
      ci: process.env.CI,
    }),
  );
  const result = await ensureSamExclusionsIndex();
  const status = getSamExtractStatus();
  console.log(
    JSON.stringify(
      {
        kind: "exclusions",
        ok: result.ok,
        fromCache: result.fromCache,
        ageHours: result.ageHours,
        count: status.count || result.count,
        downloadedAt: status.downloadedAt,
        source: status.source,
        error: result.error,
      },
      null,
      2,
    ),
  );
  if (!result.ok || (status.count || result.count) < 1) {
    console.error(result.error ?? "Exclusions sync produced 0 UEIs");
    return false;
  }
  return true;
}

async function syncEntities() {
  const force = process.argv.includes("--force");
  // Optional: --date=07/2026
  const dateArg = process.argv.find((a) => a.startsWith("--date="));
  const date = dateArg ? dateArg.slice("--date=".length) : undefined;
  const result = await syncSamEntityExtract({ force, date });
  const status = await getEntityExtractStatus();
  console.log(
    JSON.stringify(
      {
        kind: "entities",
        ...result,
        builtAt: status.builtAt,
      },
      null,
      2,
    ),
  );
  return result.ok;
}

let ok = true;
if (mode === "exclusions" || mode === "all") {
  ok = (await syncExclusions()) && ok;
}
if (mode === "entities" || mode === "all") {
  ok = (await syncEntities()) && ok;
}

if (!ok) process.exitCode = 1;
