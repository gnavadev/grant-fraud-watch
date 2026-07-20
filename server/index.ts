import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateAwardsToFacilities,
  rescoreFacility,
} from "./aggregate.js";
import { cacheBackend } from "./cache.js";
import { loadEnv, getFacApiKey, getSamApiKey } from "./env.js";
import { FACILITY_TYPES, isValidFacilityType } from "./facilityTypes.js";
import { log } from "./logger.js";
import { rateLimit } from "./rateLimit.js";
import { getSamExtractStatus, getSamQuotaStatus } from "./sam.js";
import { getEntityExtractStatus } from "./samEntityExtract.js";
import type {
  FacilitiesResponse,
  Facility,
  FacilityFilters,
  FacilityTypeKey,
} from "./types.js";
import { fetchAwards, fetchTransactions } from "./usaspending.js";

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
  const samExtract = getSamExtractStatus();
  const entityExtract = await getEntityExtractStatus();
  const backend = cacheBackend();
  res.json({
    ok: true,
    service: "grant-fraud-watch",
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    facKey,
    samKey,
    cacheBackend: backend,
    samExtractLoaded: samExtract.loaded,
    samExtractCount: samExtract.count,
    samEntityExtractReady: entityExtract.ready,
    samEntityExtractCount: entityExtract.count,
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
      backend === "redis"
        ? "Shared cache: Upstash Redis (survives sleep, shared by all users)"
        : "Cache: local disk only (set UPSTASH_REDIS_REST_URL + TOKEN for shared cache)",
      samExtract.loaded
        ? `SAM exclusions extract loaded (${samExtract.count} UEIs)`
        : samKey
          ? "SAM exclusions extract not loaded yet (will download on first search)"
          : null,
      entityExtract.ready
        ? `SAM entity extract index ready (${entityExtract.count} UEIs)`
        : "SAM entity extract not synced (npm run sam:sync-entities), registration age limited",
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

    // Avoid caching personalized search results in shared proxies
    res.setHeader("Cache-Control", "private, no-store");

    const [awardResult, txnResult] = await Promise.all([
      fetchAwards(filters),
      fetchTransactions(filters).catch((err) => {
        log.warn("transactions_fetch_failed", { err });
        return { transactions: [], pagesFetched: 0, fromCache: false };
      }),
    ]);

    const { facilities, transactionCount, enrichment } =
      await aggregateAwardsToFacilities(
        awardResult.awards,
        filters,
        txnResult.transactions,
      );

    const scoredCount = facilities.filter((f) => f.fraudChance != null).length;

    const body: FacilitiesResponse = {
      facilities,
      meta: {
        awardCount: awardResult.awards.length,
        facilityCount: facilities.length,
        scoredCount,
        insufficientCount: facilities.length - scoredCount,
        filters,
        disclaimer: DISCLAIMER,
        transactionCount,
        cache: {
          awards: awardResult.fromCache,
          transactions: txnResult.fromCache,
        },
      },
    };

    (body.meta as FacilitiesResponse["meta"] & {
      enrichment?: typeof enrichment;
    }).enrichment = enrichment;

    log.info("facilities_ok", {
      ms: Date.now() - t0,
      state: filters.state ?? "",
      type: filters.type,
      awards: awardResult.awards.length,
      facilities: facilities.length,
      fac: enrichment.facLookups,
      sam: enrichment.samLookups,
      cacheAwards: awardResult.fromCache,
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
