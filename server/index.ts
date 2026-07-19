import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateAwardsToFacilities,
  rescoreFacility,
} from "./aggregate.js";
import { loadEnv, getFacApiKey, getSamApiKey } from "./env.js";
import { FACILITY_TYPES, isValidFacilityType } from "./facilityTypes.js";
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

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const DISCLAIMER =
  "Audit-worthiness score from federal awards, FAC Single Audits, and SAM entity data. Not proof of fraud — use for triage only.";

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "grant-fraud-watch",
    facKey: Boolean(getFacApiKey()),
    samKey: Boolean(getSamApiKey()),
  });
});

app.get("/api/facility-types", (_req, res) => {
  res.json({
    types: FACILITY_TYPES.map(({ key, label }) => ({ key, label })),
  });
});

app.get("/api/facilities", async (req, res) => {
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

    const [awardResult, txnResult] = await Promise.all([
      fetchAwards(filters),
      fetchTransactions(filters).catch((err) => {
        console.warn("[facilities] transaction fetch failed:", err);
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

    // Debug enrichment counts (harmless extra fields)
    (body.meta as FacilitiesResponse["meta"] & {
      enrichment?: typeof enrichment;
    }).enrichment = enrichment;

    res.json(body);
  } catch (err) {
    console.error("[/api/facilities]", err);
    const message =
      err instanceof Error ? err.message : "Something went wrong loading grants.";
    res.status(502).json({
      error: `Could not load data. ${message}`,
    });
  }
});

/**
 * Retry FAC/SAM enrichment + rescore for one facility (after timeouts/errors).
 */
app.post("/api/facilities/rescore", async (req, res) => {
  try {
    const facility = req.body?.facility as Facility | undefined;
    if (!facility?.id || !facility.rescore) {
      res.status(400).json({ error: "Missing facility rescore payload." });
      return;
    }
    const updated = await rescoreFacility({ facility });
    res.json({ facility: updated });
  } catch (err) {
    console.error("[/api/facilities/rescore]", err);
    const message =
      err instanceof Error ? err.message : "Rescore failed.";
    res.status(502).json({ error: message });
  }
});

const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
  console.log(
    `  FAC key: ${getFacApiKey() ? "yes" : "no"} | SAM key: ${getSamApiKey() ? "yes" : "no"}`,
  );
});
