import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateAwardsToFacilities,
  DEFAULT_PAGE_SIZE,
  isBroadSearch,
  MAX_PAGE_SIZE,
  normalizePageOptions,
  rescoreFacility,
} from "./aggregate.js";
import { getFacilitiesFromBulk } from "./bulkRedis.js";
import {
  cacheBackend,
  cacheGet,
  cacheKey,
  cacheSet,
  probeRedis,
} from "./cache.js";
import { loadEnv, getFacApiKey, getSamApiKey } from "./env.js";
import { FACILITY_TYPES, isValidFacilityType } from "./facilityTypes.js";
import { log } from "./logger.js";
import { rateLimit } from "./rateLimit.js";
import { getSamExtractStatus, getSamQuotaStatus } from "./sam.js";
import { ensureSamExclusionsIndex } from "./samExtract.js";
import {
  ensureSamEntityIndex,
  getEntityExtractStatus,
} from "./samEntityExtract.js";
import type {
  FacilitiesResponse,
  Facility,
  FacilityFilters,
  FacilityTypeKey,
} from "./types.js";
import { slimFacilitiesResponse } from "./slimResponse.js";
import {
  fetchAwardsPreferDeep,
  fetchTransactions,
  MAX_PAGES_PRECALC,
  MAX_PAGES_SEARCH,
  MAX_PAGES_SEARCH_BROAD,
} from "./usaspending.js";

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STARTED_AT = Date.now();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Free hosts (Render) sit behind a proxy
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const DISCLAIMER =
  "Audit-worthiness score from federal awards, FAC Single Audits, and SAM entity data. Not proof of fraud, use for triage only.";

/** Light rate limit: search endpoints only (protect free tier + upstream APIs). */
function apiPath(req: express.Request): string {
  // Prefer originalUrl so mount stripping does not hide /api prefix
  const raw = req.originalUrl?.split("?")[0] ?? req.path;
  return raw;
}
const searchLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  when: (req) =>
    req.method === "GET" &&
    (apiPath(req) === "/api/facilities" || apiPath(req).startsWith("/api/facilities?")),
});
const rescoreLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  when: (req) =>
    req.method === "POST" && apiPath(req) === "/api/facilities/rescore",
});

app.use(searchLimit);
app.use(rescoreLimit);

app.get("/api/health", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const facKey = Boolean(getFacApiKey());
  const samKey = Boolean(getSamApiKey());
  const samQuota = getSamQuotaStatus();
  const backend = cacheBackend();
  const redisProbe = await probeRedis();

  // Actually load bundled exclusions + entity DB (from data/ or SAM_ENTITY_DB_URL)
  // so health reflects runtime readiness, not "never touched yet"
  let exclusions = { ok: false, count: 0, fromCache: false as boolean };
  try {
    exclusions = await ensureSamExclusionsIndex();
  } catch {
    /* ignore */
  }
  let entityReady = false;
  try {
    entityReady = await ensureSamEntityIndex();
  } catch {
    /* ignore */
  }
  const samExtract = getSamExtractStatus();
  const entityExtract = await getEntityExtractStatus();

  const scoringMode = (process.env.SCORING_MODE ?? "auto").trim().toLowerCase();
  let bulkBuildId: string | null = null;
  try {
    const { getBulkBuildId } = await import("./bulkRedis.js");
    bulkBuildId = await getBulkBuildId();
  } catch {
    /* ignore */
  }

  res.json({
    ok: true,
    service: "grant-fraud-watch",
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    facKey,
    samKey,
    cacheBackend: backend,
    scoringMode,
    bulkBuildId,
    /** True only if SET+GET against Upstash succeeded (not just env present). */
    redisOk: redisProbe.ok,
    redisConfigured: redisProbe.configured,
    redisLatencyMs: redisProbe.latencyMs ?? null,
    redisError: redisProbe.error ?? null,
    samExtractLoaded: samExtract.loaded && samExtract.count > 0,
    samExtractCount: samExtract.count || exclusions.count,
    samEntityExtractReady: entityReady || entityExtract.ready,
    samEntityExtractCount: entityExtract.count,
    samEntityDbUrl: Boolean(process.env.SAM_ENTITY_DB_URL?.trim()),
    samQuotaBlocked: samQuota.blocked,
    samQuotaUntil: samQuota.until
      ? new Date(samQuota.until).toISOString()
      : null,
    /** Hint for UI when keys missing on free deploy. */
    notes: [
      !facKey ? "FAC_API_KEY not set, Single Audit enrichment disabled" : null,
      !samKey
        ? "SAM_API_KEY not set, SAM enrichment disabled (keys expire ~90 days)"
        : null,
      redisProbe.ok
        ? `Shared cache: Upstash Redis OK (${redisProbe.latencyMs ?? "?"}ms)`
        : redisProbe.configured
          ? `Upstash configured but not working: ${redisProbe.error ?? "unknown"} (app falls back to disk; Data Browser stays empty)`
          : "Cache: local disk only (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN from Upstash REST API)",
      samExtract.loaded && samExtract.count > 0
        ? `SAM exclusions loaded (${samExtract.count} UEIs, source: ${samExtract.source ?? "unknown"})`
        : "SAM exclusions not loaded (need data/sam/exclusions_ueis.txt in deploy or allow download)",
      entityReady || entityExtract.ready
        ? `SAM entity index ready (${entityExtract.count} rows)`
        : process.env.SAM_ENTITY_DB_URL?.trim()
          ? "SAM entity DB URL set but download/open failed (check URL / logs)"
          : "SAM_ENTITY_DB_URL not set, registration age limited",
      samQuota.blocked
        ? `SAM live API quota exceeded until ${new Date(samQuota.until!).toISOString()} (extract mode still works)`
        : null,
    ].filter(Boolean),
  });
});

app.get("/api/facility-types", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    types: FACILITY_TYPES.map(({ key, label }) => ({ key, label })),
  });
});

app.get("/api/facilities", async (req, res) => {
  const t0 = Date.now();
  try {
    const state =
      typeof req.query.state === "string" ? req.query.state.trim() : "";
    const city =
      typeof req.query.city === "string" ? req.query.city.trim() : "";
    const county =
      typeof req.query.county === "string" ? req.query.county.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const typeRaw =
      typeof req.query.type === "string" ? req.query.type.trim() : "all";

    const type: FacilityTypeKey = isValidFacilityType(typeRaw)
      ? typeRaw
      : "all";

    if (!state && type === "all" && !q) {
      res.status(400).json({
        error:
          "Please choose a state, a facility type, or enter a search term before searching.",
      });
      return;
    }

    const filters: FacilityFilters = {
      state: state || undefined,
      city: city || undefined,
      county: county || undefined,
      type,
      q: q || undefined,
    };

    const pageRaw =
      typeof req.query.page === "string" ? Number(req.query.page) : 1;
    const pageSizeRaw =
      typeof req.query.pageSize === "string"
        ? Number(req.query.pageSize)
        : DEFAULT_PAGE_SIZE;
    const { page: reqPage, pageSize } = normalizePageOptions({
      page: Number.isFinite(pageRaw) ? pageRaw : 1,
      pageSize: Number.isFinite(pageSizeRaw)
        ? Math.min(MAX_PAGE_SIZE, pageSizeRaw)
        : DEFAULT_PAGE_SIZE,
    });

    // Avoid caching personalized search results in shared proxies
    res.setHeader("Cache-Control", "private, no-store");

    /**
     * Scoring modes:
     *   bulk  — Redis ranks from DuckDB offline build only
     *   auto  — try bulk first, else legacy live APIs (default)
     *   legacy — always live USAspending/FAC path
     */
    const scoringMode = (
      process.env.SCORING_MODE ?? "auto"
    ).trim().toLowerCase();

    if (scoringMode === "bulk" || scoringMode === "auto") {
      const bulkBody = await getFacilitiesFromBulk(
        filters,
        reqPage,
        pageSize,
      );
      if (bulkBody) {
        log.info("facilities_bulk_hit", {
          ms: Date.now() - t0,
          state: filters.state ?? "",
          type: filters.type,
          page: reqPage,
          facilities: bulkBody.facilities.length,
          buildId: bulkBody.meta.bulk?.buildId,
        });
        res.json(bulkBody);
        return;
      }
      if (scoringMode === "bulk") {
        res.status(503).json({
          error:
            "Bulk ranking not available for this filter yet. Run npm run bulk:score-publish, or set SCORING_MODE=auto.",
        });
        return;
      }
    }

    // Per-page response cache (v5: faster list path). First hit fills it.
    const responseCacheKey = `${cacheKey("facilities_v5", filters)}_p${reqPage}_s${pageSize}`;
    const responseTtl = 6 * 60 * 60 * 1000; // 6 hours
    const cachedBody = await cacheGet<FacilitiesResponse>(
      responseCacheKey,
      responseTtl,
    );
    if (cachedBody && Array.isArray(cachedBody.facilities)) {
      log.info("facilities_response_cache_hit", {
        ms: Date.now() - t0,
        state: filters.state ?? "",
        type: filters.type,
        page: reqPage,
        pageSize,
        facilities: cachedBody.facilities.length,
      });
      res.json({
        ...cachedBody,
        meta: {
          ...cachedBody.meta,
          cache: {
            awards: true,
            transactions: true,
            response: true,
          },
        },
      });
      return;
    }

    const broad = isBroadSearch(filters);
    // Prefer deep precalc awards from Redis; live fallback uses fewer pages
    const liveAwardPages = broad ? MAX_PAGES_SEARCH_BROAD : MAX_PAGES_SEARCH;
    const txnPages = broad ? 0 : Math.min(3, MAX_PAGES_SEARCH);

    const [awardResult, txnResult] = await Promise.all([
      broad
        ? fetchAwardsPreferDeep(filters, MAX_PAGES_PRECALC, liveAwardPages)
        : fetchAwardsPreferDeep(filters, MAX_PAGES_SEARCH, liveAwardPages),
      txnPages > 0
        ? fetchTransactions(filters, txnPages).catch((err) => {
            log.warn("transactions_fetch_failed", { err });
            return { transactions: [], pagesFetched: 0, fromCache: false };
          })
        : Promise.resolve({
            transactions: [],
            pagesFetched: 0,
            fromCache: true as const,
          }),
    ]);

    const {
      facilities,
      transactionCount,
      enrichment,
      totalFacilityCount,
      page,
      pageSize: usedPageSize,
      totalPages,
    } = await aggregateAwardsToFacilities(
      awardResult.awards,
      filters,
      txnResult.transactions,
      {
        page: reqPage,
        pageSize,
        // Score every org in sample for true fraud ranking (network FAC capped on cold)
        scoreEntireSample: true,
      },
    );

    const scoredCount = facilities.filter((f) => f.fraudChance != null).length;

    const body: FacilitiesResponse = {
      facilities,
      meta: {
        awardCount: awardResult.awards.length,
        facilityCount: totalFacilityCount,
        scoredCount,
        insufficientCount: facilities.length - scoredCount,
        filters,
        disclaimer: DISCLAIMER,
        transactionCount,
        page,
        pageSize: usedPageSize,
        totalPages,
        hasMore: page < totalPages,
        cache: {
          awards: awardResult.fromCache,
          transactions: txnResult.fromCache,
        },
      },
    };

    (body.meta as FacilitiesResponse["meta"] & {
      enrichment?: typeof enrichment;
    }).enrichment = enrichment;

    // Await write so the next user (or retry) hits Redis immediately
    // Slim payload: Upstash free plan max request size is 10MB
    try {
      await cacheSet(
        responseCacheKey,
        slimFacilitiesResponse(body),
        responseTtl,
      );
    } catch {
      /* best-effort */
    }

    log.info("facilities_ok", {
      ms: Date.now() - t0,
      state: filters.state ?? "",
      type: filters.type,
      awards: awardResult.awards.length,
      facilities: facilities.length,
      totalFacilities: totalFacilityCount,
      page,
      pageSize: usedPageSize,
      fac: enrichment.facLookups,
      sam: enrichment.samLookups,
      grantsHydrated: enrichment.grantsHydrated,
      scoreCacheHits: enrichment.scoreCacheHits,
      cacheAwards: awardResult.fromCache,
      msTotal: Date.now() - t0,
    });

    res.json(body);
  } catch (err) {
    log.error("facilities_failed", { err, ms: Date.now() - t0 });
    const message =
      err instanceof Error ? err.message : "Something went wrong loading grants.";
    // Don't leak internal stack traces to clients
    const safe =
      message.includes("USAspending") || message.includes("Please")
        ? message
        : "Upstream data source failed. Please try again in a moment.";
    res.status(502).json({
      error: `Could not load data. ${safe}`,
    });
  }
});

/**
 * Retry FAC/SAM enrichment + rescore for one facility (after timeouts/errors).
 */
app.post("/api/facilities/rescore", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const facility = req.body?.facility as Facility | undefined;
    if (!facility?.id || !facility.rescore) {
      res.status(400).json({ error: "Missing facility rescore payload." });
      return;
    }
    // Bound payload size (rescore embeds amount arrays)
    const amounts = facility.rescore.scoreAmounts?.length ?? 0;
    if (amounts > 5000) {
      res.status(400).json({ error: "Rescore payload too large." });
      return;
    }
    const updated = await rescoreFacility({ facility });
    res.json({ facility: updated });
  } catch (err) {
    log.error("rescore_failed", { err });
    res.status(502).json({ error: "Rescore failed. Please try again." });
  }
});

// Static client: resolve from project root (works for both tsx and compiled dist/)
const clientDist = path.join(process.cwd(), "client", "dist");
app.use(
  express.static(clientDist, {
    maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
    index: false,
  }),
);
app.get(/^(?!\/api).*/, (req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  log.info("server_listen", {
    port: PORT,
    facKey: Boolean(getFacApiKey()),
    samKey: Boolean(getSamApiKey()),
    cacheBackend: cacheBackend(),
    clientDist,
    // __dirname helps debug whether we are running from source or dist/
    entryDir: __dirname,
  });
});
