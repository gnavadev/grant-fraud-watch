/**
 * CLI: score DuckDB bulk data and publish ranks to Redis.
 *
 *   npm run bulk:score-publish
 *   npm run bulk:score-publish -- --state CA
 *   npm run bulk:score-publish -- --state CA --type healthcare
 */
import { loadEnv } from "./env.js";
import { probeRedis } from "./cache.js";
import { publishBulkBuild } from "./bulkRedis.js";
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
  // config.json minEvidenceN
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
  return { onlyState, onlyType, minN };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("=== Bulk score → Redis ===");
  console.log(
    `state=${opts.onlyState ?? "ALL"} type=${opts.onlyType ?? "ALL"} minEvidenceN=${opts.minN}`,
  );

  const redis = await probeRedis();
  if (!redis.ok) {
    console.error(
      "Redis required for publish:",
      redis.error ?? "not configured",
    );
    process.exit(1);
  }
  console.log(`Redis OK (${redis.latencyMs}ms)`);

  try {
    await ensureSamExclusionsIndex();
    console.log("SAM exclusions index ready");
  } catch (e) {
    console.warn("SAM exclusions optional:", e);
  }

  console.log("Scoring from DuckDB (no HTTP)…");
  const t0 = Date.now();
  const { facilities, stats } = await scoreAllFromDuck({
    minEvidenceN: opts.minN,
    onlyState: opts.onlyState,
    onlyType: opts.onlyType,
  });
  console.log(
    `Scored in ${Date.now() - t0}ms: recipients=${stats.recipients} scored=${stats.scored} insufficient=${stats.insufficient} withFac=${stats.withFac}`,
  );

  if (facilities.length === 0) {
    console.error("No facilities scored. Run npm run bulk:load first.");
    process.exit(1);
  }

  console.log("Publishing to Redis…");
  const pub = await publishBulkBuild(facilities);
  console.log(
    `Published build=${pub.buildId} facKeys=${pub.facKeys} rankKeys=${pub.rankKeys}`,
  );
  console.log("Flipped gfw:bulk:current → this build.");
  console.log(
    "Set SCORING_MODE=bulk on Render (or leave auto) and redeploy to serve ranks.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
