/**
 * CLI: score DuckDB bulk data → static snapshot (+ optional Redis).
 *
 *   npm run bulk:score-publish
 *   npm run bulk:score-publish -- --state CA
 *   npm run bulk:score-publish -- --no-redis
 *
 * Primary output: data/bulk/snapshot.json + snapshot.json.gz
 * (commit the .gz or attach to a GitHub Release; set BULK_SNAPSHOT_URL on Render)
 *
 * Redis is optional and skipped when Upstash is full/unavailable.
 */
import { loadEnv } from "./env.js";
import { probeRedis } from "./cache.js";
import { publishBulkBuild } from "./bulkRedis.js";
import {
  buildBulkSnapshot,
  setLoadedBulkSnapshot,
  writeBulkSnapshot,
} from "./bulkSnapshot.js";
import { scoreAllFromDuck } from "./bulkScore.js";
import { ensureSamExclusionsIndex } from "./samExtract.js";
import { isValidFacilityType } from "./facilityTypes.js";
import type { FacilityTypeKey } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  let onlyState: string | undefined;
  let onlyType: FacilityTypeKey | undefined;
  let minN = 10;
  let skipRedis = argv.includes("--no-redis");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--state" && argv[i + 1]) {
      onlyState = argv[++i].toUpperCase();
    } else if (argv[i] === "--type" && argv[i + 1]) {
      const t = argv[++i];
      if (isValidFacilityType(t)) onlyType = t;
    } else if (argv[i] === "--min-n" && argv[i + 1]) {
      minN = Math.max(1, Number(argv[++i]) || 10);
    }
  }
  try {
    const cfgPath = path.join(__dirname, "..", "bulk", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      minEvidenceN?: number;
    };
    if (cfg.minEvidenceN != null && !argv.includes("--min-n")) {
      minN = cfg.minEvidenceN;
    }
  } catch {
    /* ignore */
  }
  return { onlyState, onlyType, minN, skipRedis };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("=== Bulk score → static snapshot (+ optional Redis) ===");
  console.log(
    `state=${opts.onlyState ?? "ALL"} type=${opts.onlyType ?? "ALL"} minEvidenceN=${opts.minN} redis=${opts.skipRedis ? "skip" : "try"}`,
  );

  try {
    await ensureSamExclusionsIndex();
    console.log("SAM exclusions index ready");
  } catch (e) {
    console.warn("SAM exclusions optional:", e);
  }
  try {
    const { ensureSamEntityIndex, getEntityExtractStatus } = await import(
      "./samEntityExtract.js"
    );
    const ok = await ensureSamEntityIndex();
    const st = await getEntityExtractStatus();
    console.log(
      ok
        ? `SAM entity extract ready (count≈${st.count}) — needed for SAM.gov links`
        : "SAM entity extract NOT ready — most SAM links will stay grey",
    );
  } catch (e) {
    console.warn("SAM entity extract optional:", e);
  }

  console.log("Scoring from DuckDB (no HTTP)…");
  const t0 = Date.now();
  const { facilities, stats } = await scoreAllFromDuck({
    minEvidenceN: opts.minN,
    onlyState: opts.onlyState,
    onlyType: opts.onlyType,
  });
  console.log(
    `Scored in ${Date.now() - t0}ms: recipients=${stats.recipients} scored=${stats.scored} insufficient=${stats.insufficient} withFac=${stats.withFac} withSam=${stats.withSam}`,
  );

  if (facilities.length === 0) {
    console.error("No facilities scored. Run npm run bulk:load first.");
    process.exit(1);
  }

  // ── Primary: static snapshot (survives Upstash free-tier death) ──
  console.log("Writing static bulk snapshot…");
  const snap = buildBulkSnapshot(facilities);
  setLoadedBulkSnapshot(snap);
  const written = await writeBulkSnapshot(snap);
  console.log(
    `Snapshot build=${snap.buildId} facs=${Object.keys(snap.facilities).length} ranks=${Object.keys(snap.ranks).length}`,
  );
  console.log(
    `  ${written.jsonPath} (${(written.jsonBytes / 1e6).toFixed(1)} MB)`,
  );
  console.log(
    `  ${written.gzPath} (${(written.gzBytes / 1e6).toFixed(1)} MB gzip)`,
  );
  console.log(
    "Commit data/bulk/snapshot.json.gz OR upload to a GitHub Release and set BULK_SNAPSHOT_URL on the host.",
  );

  // ── Optional Redis (skip if quota / --no-redis) ──
  if (opts.skipRedis) {
    console.log("Skipped Redis (--no-redis). App will serve from snapshot file.");
    return;
  }

  const { getRedis } = await import("./cache.js");
  if (!getRedis()) {
    console.log(
      "Redis not configured — OK. Serving from data/bulk/snapshot.json.gz only.",
    );
    return;
  }

  try {
    const { purgeRedisPrefixes } = await import("./bulkRedis.js");
    console.log("Trying Redis publish (optional)…");
    await purgeRedisPrefixes(
      ["gfw:bulk:", "gfw:sc:", "gfw:facilities_v", "gfw:"],
      50_000,
    );
    const redis = await probeRedis();
    if (!redis.ok) {
      console.warn(
        "Redis not writable (quota or error):",
        redis.error ?? "unknown",
      );
      console.warn(
        "Ignoring Redis — static snapshot is enough. Clear Upstash or upgrade later if you want shared cache.",
      );
      return;
    }
    const pub = await publishBulkBuild(facilities, { buildId: snap.buildId });
    console.log(
      `Redis published build=${pub.buildId} facKeys=${pub.facKeys} rankKeys=${pub.rankKeys}`,
    );
  } catch (e) {
    console.warn(
      "Redis publish failed (snapshot still written):",
      e instanceof Error ? e.message : e,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
