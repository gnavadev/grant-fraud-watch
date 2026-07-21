/**
 * Precalculate ALL orgs in each state × facility-type into Redis.
 *
 * For each filter:
 *   1) Deep USAspending award pull (up to MAX_PAGES_PRECALC × 100 awards)
 *   2) Group every recipient in that pull
 *   3) Score every recipient (FAC light + SAM extract + sample math)
 *   4) Rank by fraud chance → write score map + ranked page caches
 *
 * Usage:
 *   npm run scores:precalc
 *   npm run scores:precalc -- --force
 *   npm run scores:precalc -- --state CA --type healthcare
 *   npm run scores:precalc -- --limit 5          # first 5 jobs only (smoke test)
 *
 * Env (.env or CI):
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (required)
 *   FAC_API_KEY  (recommended)
 *   PRECALC_AWARD_PAGES  (optional, default MAX_PAGES_PRECALC)
 */
import { loadEnv } from "./env.js";
import {
  aggregateAwardsToFacilities,
  DEFAULT_PAGE_SIZE,
} from "./aggregate.js";
import { cacheKey, cacheSet, probeRedis } from "./cache.js";
import { isValidFacilityType } from "./facilityTypes.js";
import {
  jobToFilters,
  PRECALC_UNIVERSE,
  type PrecalcJob,
} from "./precalcUniverse.js";
import { ensureSamExtractsReady } from "./sam.js";
import { slimFacilitiesResponse } from "./slimResponse.js";
import type { FacilitiesResponse, FacilityTypeKey } from "./types.js";
import {
  fetchAwards,
  MAX_PAGES_PRECALC,
} from "./usaspending.js";

loadEnv();

const DISCLAIMER =
  "Audit-worthiness score from federal awards, FAC Single Audits, and SAM entity data. Not proof of fraud, use for triage only.";

function parseArgs(argv: string[]) {
  let force = process.env.PRECALC_FORCE === "1";
  let onlyState: string | null = null;
  let onlyType: FacilityTypeKey | null = null;
  let limit: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--state" && argv[i + 1]) {
      onlyState = argv[++i].toUpperCase();
    } else if (a === "--type" && argv[i + 1]) {
      const t = argv[++i];
      onlyType = isValidFacilityType(t) ? t : null;
    } else if (a === "--limit" && argv[i + 1]) {
      limit = Math.max(1, Number(argv[++i]) || 1);
    } else if (a === "--pages" && argv[i + 1]) {
      // legacy: treat as limit on jobs for smoke tests
      limit = Math.max(1, Number(argv[++i]) || 1);
    }
  }
  return { force, onlyState, onlyType, limit };
}

function selectJobs(opts: ReturnType<typeof parseArgs>): PrecalcJob[] {
  let jobs = [...PRECALC_UNIVERSE];
  if (opts.onlyState) {
    jobs = jobs.filter((j) => j.state === opts.onlyState);
  }
  if (opts.onlyType) {
    jobs = jobs.filter((j) => j.type === opts.onlyType);
  }
  if (opts.limit != null) {
    jobs = jobs.slice(0, opts.limit);
  }
  return jobs;
}

function awardPagesForPrecalc(): number {
  const n = Number(process.env.PRECALC_AWARD_PAGES);
  if (Number.isFinite(n) && n >= 1) return Math.min(80, Math.floor(n));
  return MAX_PAGES_PRECALC;
}

async function precalcJob(
  job: PrecalcJob,
  force: boolean,
  awardPages: number,
): Promise<{
  label: string;
  orgs: number;
  pagesWritten: number;
  awards: number;
  scoreHits: number;
  ms: number;
  error?: string;
}> {
  const label = `${job.state}/${job.type}`;
  const t0 = Date.now();
  const filters = jobToFilters(job);

  try {
    const awardResult = await fetchAwards(filters, awardPages);
    if (awardResult.awards.length === 0) {
      return {
        label,
        orgs: 0,
        pagesWritten: 0,
        awards: 0,
        scoreHits: 0,
        ms: Date.now() - t0,
      };
    }

    // First call: score EVERY org in sample, write Redis score map, return page 1 ranked by fraud chance
    const page1 = await aggregateAwardsToFacilities(
      awardResult.awards,
      filters,
      [],
      {
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        skipScoreCache: force,
        awaitScoreWrites: true,
        scoreEntireSample: true,
      },
    );

    const totalOrgs = page1.totalFacilityCount;
    const totalPages = page1.totalPages;
    let scoreHits = page1.enrichment.scoreCacheHits;

    async function storePage(
      page: number,
      facilities: typeof page1.facilities,
      total: number,
      pages: number,
      hits: number,
    ) {
      const scoredCount = facilities.filter((f) => f.fraudChance != null).length;
      const body: FacilitiesResponse = {
        facilities,
        meta: {
          awardCount: awardResult.awards.length,
          facilityCount: total,
          scoredCount,
          insufficientCount: facilities.length - scoredCount,
          filters,
          disclaimer: DISCLAIMER,
          transactionCount: 0,
          page,
          pageSize: DEFAULT_PAGE_SIZE,
          totalPages: pages,
          hasMore: page < pages,
          cache: {
            awards: awardResult.fromCache,
            transactions: true,
          },
        },
      };
      (body.meta as FacilitiesResponse["meta"] & {
        enrichment?: typeof page1.enrichment;
      }).enrichment = {
        ...page1.enrichment,
        scoreCacheHits: hits,
      };
      const responseKey = `${cacheKey("facilities_v5", filters)}_p${page}_s${DEFAULT_PAGE_SIZE}`;
      // Slim so Upstash free 10MB request limit is not hit
      await cacheSet(
        responseKey,
        slimFacilitiesResponse(body),
        7 * 24 * 60 * 60 * 1000,
      );
    }

    await storePage(
      1,
      page1.facilities,
      totalOrgs,
      totalPages,
      scoreHits,
    );

    // Remaining ranked pages (scores already in Redis → fast)
    for (let page = 2; page <= totalPages; page++) {
      const result = await aggregateAwardsToFacilities(
        awardResult.awards,
        filters,
        [],
        {
          page,
          pageSize: DEFAULT_PAGE_SIZE,
          skipScoreCache: false,
          awaitScoreWrites: true,
          scoreEntireSample: true,
        },
      );
      scoreHits += result.enrichment.scoreCacheHits;
      await storePage(
        page,
        result.facilities,
        result.totalFacilityCount,
        result.totalPages,
        result.enrichment.scoreCacheHits,
      );
    }

    return {
      label,
      orgs: totalOrgs,
      pagesWritten: totalPages,
      awards: awardResult.awards.length,
      scoreHits,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      label,
      orgs: 0,
      pagesWritten: 0,
      awards: 0,
      scoreHits: 0,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  // Enables slower throttles / longer 429 backoff in usaspending + fac
  process.env.PRECALC = "1";

  const opts = parseArgs(process.argv.slice(2));
  const jobs = selectJobs(opts);
  const awardPages = awardPagesForPrecalc();
  const jobGapMs = Number(process.env.PRECALC_JOB_GAP_MS) || 4000;

  console.log("=== Precalc: all orgs in each state × type → Redis ===");
  console.log(
    `Jobs: ${jobs.length} / universe ${PRECALC_UNIVERSE.length}  force=${opts.force}  awardPages=${awardPages} (≤${awardPages * 100} awards/filter)`,
  );
  console.log(
    `Rate limits: PRECALC=1  jobGap=${jobGapMs}ms  (tune PRECALC_USA_GAP_MS / PRECALC_FAC_GAP_MS / PRECALC_JOB_GAP_MS)`,
  );

  const redis = await probeRedis();
  if (!redis.configured) {
    console.error(
      "ERROR: Upstash not configured. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in .env",
    );
    process.exit(1);
  }
  if (!redis.ok) {
    console.error(
      "ERROR: Redis probe failed:",
      redis.error ?? "unknown",
      `\n  Fix URL (must be https://….upstash.io) and REST token.`,
    );
    process.exit(1);
  }
  console.log(`Redis OK (${redis.latencyMs}ms)`);

  try {
    await ensureSamExtractsReady();
    console.log("SAM extracts ready");
  } catch (err) {
    console.warn(
      "SAM extracts limited:",
      err instanceof Error ? err.message : err,
    );
  }

  let okJobs = 0;
  let totalOrgs = 0;
  let totalAwards = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    process.stdout.write(
      `[${i + 1}/${jobs.length}] ${job.state}/${job.type} … `,
    );
    const r = await precalcJob(job, opts.force, awardPages);
    if (r.error) {
      console.log(`FAIL ${r.ms}ms ${r.error.slice(0, 140)}`);
      // Extra pause after failure (often 429) so the next job is less likely to fail
      if (/429|rate/i.test(r.error)) {
        console.log("  cooling down 60s after rate limit…");
        await new Promise((res) => setTimeout(res, 60_000));
      }
    } else {
      okJobs += 1;
      totalOrgs += r.orgs;
      totalAwards += r.awards;
      console.log(
        `OK ${r.ms}ms awards=${r.awards} orgs=${r.orgs} pages=${r.pagesWritten} scoreHits=${r.scoreHits}`,
      );
    }
    // Cool down between state×type jobs (helps 429 recovery)
    await new Promise((res) => setTimeout(res, jobGapMs));
  }

  console.log(
    `\nDone: ${okJobs}/${jobs.length} jobs, ${totalOrgs} orgs scored, ${totalAwards} awards pulled`,
  );
  console.log(
    "Upstash Data Browser should show gfw:sc:v1:… and gfw:facilities_v5:… / awards keys.",
  );
  if (okJobs === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
