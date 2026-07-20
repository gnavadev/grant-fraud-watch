/**
 * Precalculate facility scores into Redis (score map + awards cache).
 *
 * Does NOT hit Render — runs USAspending/FAC locally and writes Upstash.
 *
 * Usage:
 *   npm run scores:precalc
 *   npm run scores:precalc -- --force          # recompute even if score map hit
 *   npm run scores:precalc -- --pages 1        # only first page of each job
 *   npm run scores:precalc -- --state CA --type healthcare
 *
 * Env (from .env or CI secrets):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (required for shared store)
 *   FAC_API_KEY  (recommended)
 *   SAM_API_KEY  (optional; extracts still used if bundled)
 */
import { loadEnv } from "./env.js";
import {
  aggregateAwardsToFacilities,
  DEFAULT_PAGE_SIZE,
} from "./aggregate.js";
import { cacheKey, cacheSet, probeRedis } from "./cache.js";
import { ensureSamExtractsReady } from "./sam.js";
import {
  jobToFilters,
  PRECALC_UNIVERSE,
  type PrecalcJob,
} from "./precalcUniverse.js";
import type { FacilitiesResponse, FacilityTypeKey } from "./types.js";
import {
  fetchAwards,
  MAX_PAGES_SEARCH_BROAD,
} from "./usaspending.js";
import { isValidFacilityType } from "./facilityTypes.js";

loadEnv();

const DISCLAIMER =
  "Audit-worthiness score from federal awards, FAC Single Audits, and SAM entity data. Not proof of fraud, use for triage only.";

function parseArgs(argv: string[]) {
  let force = process.env.PRECALC_FORCE === "1";
  let maxPagesPerJob: number | null = null;
  let onlyState: string | null = null;
  let onlyType: FacilityTypeKey | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--pages" && argv[i + 1]) {
      maxPagesPerJob = Math.max(1, Number(argv[++i]) || 1);
    } else if (a === "--state" && argv[i + 1]) {
      onlyState = argv[++i].toUpperCase();
    } else if (a === "--type" && argv[i + 1]) {
      const t = argv[++i];
      onlyType = isValidFacilityType(t) ? t : null;
    }
  }
  return { force, maxPagesPerJob, onlyState, onlyType };
}

function selectJobs(opts: ReturnType<typeof parseArgs>): PrecalcJob[] {
  let jobs = [...PRECALC_UNIVERSE];
  if (opts.onlyState) {
    jobs = jobs.filter((j) => j.state === opts.onlyState);
  }
  if (opts.onlyType) {
    jobs = jobs.filter((j) => j.type === opts.onlyType);
  }
  if (opts.maxPagesPerJob != null) {
    jobs = jobs.map((j) => ({
      ...j,
      pages: Math.min(j.pages, opts.maxPagesPerJob!),
    }));
  }
  return jobs;
}

async function precalcJob(
  job: PrecalcJob,
  force: boolean,
): Promise<{
  label: string;
  scored: number;
  cacheHits: number;
  pages: number;
  ms: number;
  error?: string;
}> {
  const label = `${job.state}/${job.type}`;
  const t0 = Date.now();
  const filters = jobToFilters(job);

  try {
    const awardResult = await fetchAwards(filters, MAX_PAGES_SEARCH_BROAD);
    let scored = 0;
    let cacheHits = 0;

    for (let page = 1; page <= job.pages; page++) {
      const result = await aggregateAwardsToFacilities(
        awardResult.awards,
        filters,
        [],
        {
          page,
          pageSize: DEFAULT_PAGE_SIZE,
          skipScoreCache: force,
          awaitScoreWrites: true,
        },
      );

      cacheHits += result.enrichment.scoreCacheHits;
      scored += result.facilities.length;
      // Scores written inside aggregate (awaitScoreWrites: true)

      // Full page response cache (same key shape as /api/facilities)
      const scoredCount = result.facilities.filter(
        (f) => f.fraudChance != null,
      ).length;
      const body: FacilitiesResponse = {
        facilities: result.facilities,
        meta: {
          awardCount: awardResult.awards.length,
          facilityCount: result.totalFacilityCount,
          scoredCount,
          insufficientCount: result.facilities.length - scoredCount,
          filters,
          disclaimer: DISCLAIMER,
          transactionCount: 0,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
          hasMore: result.page < result.totalPages,
          cache: {
            awards: awardResult.fromCache,
            transactions: true,
          },
        },
      };
      const responseKey = `${cacheKey("facilities_v5", filters)}_p${page}_s${DEFAULT_PAGE_SIZE}`;
      await cacheSet(responseKey, body, 6 * 60 * 60 * 1000);
    }

    return {
      label,
      scored,
      cacheHits,
      pages: job.pages,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      label,
      scored: 0,
      cacheHits: 0,
      pages: 0,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const jobs = selectJobs(opts);

  console.log("=== Facility score precalc → Redis ===");
  console.log(`Jobs: ${jobs.length}  force=${opts.force}`);

  const redis = await probeRedis();
  if (!redis.configured) {
    console.warn(
      "WARNING: Upstash not configured. Scores will write to local disk only (.cache/).",
    );
  } else if (!redis.ok) {
    console.error(
      "ERROR: Redis probe failed:",
      redis.error ?? "unknown",
      `\n  latency=${redis.latencyMs ?? "?"}ms`,
      "\n  Fix UPSTASH_REDIS_REST_URL (full https://….upstash.io) + REST TOKEN.",
    );
    process.exit(1);
  } else {
    console.log(`Redis OK (${redis.latencyMs}ms)`);
  }

  // Load SAM extracts once (exclusions / entity) so list path stays local
  try {
    await ensureSamExtractsReady();
    console.log("SAM extracts ready");
  } catch (err) {
    console.warn(
      "SAM extracts not fully ready (continuing):",
      err instanceof Error ? err.message : err,
    );
  }

  let okJobs = 0;
  let totalScored = 0;
  let totalHits = 0;

  for (const job of jobs) {
    process.stdout.write(`→ ${job.state}/${job.type} (${job.pages}p) … `);
    const r = await precalcJob(job, opts.force);
    if (r.error) {
      console.log(`FAIL ${r.ms}ms ${r.error.slice(0, 120)}`);
    } else {
      okJobs += 1;
      totalScored += r.scored;
      totalHits += r.cacheHits;
      console.log(
        `OK ${r.ms}ms facilities=${r.scored} scoreCacheHits=${r.cacheHits}`,
      );
    }
    // Gentle pause for USAspending
    await new Promise((res) => setTimeout(res, 1500));
  }

  console.log(
    `\nDone: ${okJobs}/${jobs.length} jobs, ${totalScored} facility rows scored, ${totalHits} score-map hits`,
  );
  if (okJobs === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
