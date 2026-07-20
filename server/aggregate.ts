import { cleanAmountsForScoring, positiveAmounts } from "./amounts.js";
import {
  fraudLabelFromChance,
  scoreAmountsWithBenford,
} from "./benford.js";
import { extractAmountFeatures } from "./features.js";
import { fetchFacByUei } from "./fac.js";
import { parseLocation, preferLocation } from "./location.js";
import { computeMultiSignalScore } from "./multiSignal.js";
import { fetchSamByUei } from "./sam.js";
import {
  applyScoreEntry,
  facilityToScoreEntry,
  getFacilityScores,
  persistFacilityScores,
  scoreEntryStillValid,
  setFacilityScore,
} from "./scoreCache.js";
import {
  fetchSubawards,
  subawardConcentrationByPrime,
} from "./subawards.js";
import {
  groupTransactionsByRecipient,
  temporalRiskFromTransactions,
} from "./temporal.js";
import type {
  AwardRow,
  Facility,
  FacilityFilters,
  SignalBreakdown,
  TransactionRow,
} from "./types.js";
import {
  extractCfdaFromAward,
  fetchCfdaBaseline,
  fetchGrantsForRecipient,
  fetchUeiForRecipientId,
  MAX_PAGES_PER_RECIPIENT_LIST,
  type CfdaBaseline,
} from "./usaspending.js";

interface MutableFacility {
  id: string;
  name: string;
  city: string | null;
  county: string | null;
  state: string | null;
  uei: string | null;
  awardAmounts: number[];
  scoreAmounts: number[];
  usedTransactions: boolean;
  cfdaCounts: Map<string, number>;
  awardTypes: Set<string>;
  /** True after full recipient grant pull (true count, not search sample). */
  grantsHydrated: boolean;
  /** Awards seen in the initial search sample only (debug / fallback). */
  sampleAwardCount: number;
  /**
   * Total grant awards from full recipient pull (USASpending Grants tab).
   * When set, this is what we show as awardCount, not sample size.
   */
  hydratedGrantCount: number | null;
}

function facilityKeyFromAward(award: AwardRow): string {
  if (award.recipient_id) return award.recipient_id;
  const name = (award["Recipient Name"] ?? "Unknown").trim().toLowerCase();
  return `name:${name}`;
}

function groupAwards(awards: AwardRow[]): MutableFacility[] {
  const map = new Map<string, MutableFacility>();

  for (const award of awards) {
    const key = facilityKeyFromAward(award);
    const name =
      (award["Recipient Name"] ?? "Unknown facility").trim() ||
      "Unknown facility";
    const loc = preferLocation(
      parseLocation(award["Recipient Location"]),
      parseLocation(award["Primary Place of Performance"]),
    );
    const uei = award["Recipient UEI"]
      ? String(award["Recipient UEI"]).trim().toUpperCase()
      : null;

    let facility = map.get(key);
    if (!facility) {
      facility = {
        id: key,
        name,
        city: loc.city,
        county: loc.county,
        state: loc.state,
        uei,
        awardAmounts: [],
        scoreAmounts: [],
        usedTransactions: false,
        cfdaCounts: new Map(),
        awardTypes: new Set(),
        grantsHydrated: false,
        sampleAwardCount: 0,
        hydratedGrantCount: null,
      };
      map.set(key, facility);
    } else {
      if (!facility.city && loc.city) facility.city = loc.city;
      if (!facility.county && loc.county) facility.county = loc.county;
      if (!facility.state && loc.state) facility.state = loc.state;
      if (!facility.uei && uei) facility.uei = uei;
    }

    facility.sampleAwardCount += 1;

    const amount = award["Award Amount"];
    if (typeof amount === "number" && Number.isFinite(amount) && amount !== 0) {
      facility.awardAmounts.push(amount);
    }

    const cfda = extractCfdaFromAward(award);
    if (cfda) {
      facility.cfdaCounts.set(cfda, (facility.cfdaCounts.get(cfda) ?? 0) + 1);
    }
    if (award["Award Type"]) {
      facility.awardTypes.add(String(award["Award Type"]));
    }
  }

  for (const f of map.values()) {
    f.scoreAmounts = cleanAmountsForScoring(f.awardAmounts);
  }

  return [...map.values()];
}

function mergeTransactions(
  groups: MutableFacility[],
  transactions: TransactionRow[],
): void {
  if (transactions.length === 0) return;
  const byId = new Map<string, number[]>();
  for (const t of transactions) {
    const amount = t["Transaction Amount"];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount === 0)
      continue;
    if (!t.recipient_id) continue;
    const list = byId.get(t.recipient_id) ?? [];
    list.push(amount);
    byId.set(t.recipient_id, list);
  }
  for (const g of groups) {
    if (g.id.startsWith("name:")) continue;
    const txAmounts = byId.get(g.id);
    if (!txAmounts?.length) continue;
    const cleaned = cleanAmountsForScoring(txAmounts);
    if (cleaned.length >= g.scoreAmounts.length && cleaned.length >= 3) {
      g.scoreAmounts = cleaned;
      g.usedTransactions = true;
    }
  }
}

function primaryCfda(cfdaCounts: Map<string, number>): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [code, count] of cfdaCounts) {
    if (count > n) {
      n = count;
      best = code;
    }
  }
  return best;
}

/** Simple concurrency pool */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

export interface AggregatePageOptions {
  /** 1-based page index (default 1). */
  page?: number;
  /** Facilities per request (default 20, max 50). */
  pageSize?: number;
  /** Ignore Redis score map and recompute (precalc --force). */
  skipScoreCache?: boolean;
  /** Await score map writes (precalc); default fire-and-forget for HTTP. */
  awaitScoreWrites?: boolean;
}

export interface AggregateResult {
  facilities: Facility[];
  transactionCount: number;
  /** Total facilities after grouping (all pages). */
  totalFacilityCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  enrichment: {
    facLookups: number;
    samLookups: number;
    subawardRows: number;
    grantsHydrated: number;
    /** Facilities that reused Redis score map (facility → fraud chance). */
    scoreCacheHits: number;
  };
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
/**
 * Full grant hydrate: only largest sample-$ orgs on the page.
 * Broad state+type: 0 (sample scores only, · sample label) — list stays under ~15s.
 * Narrow (city/county/q): top 5 for better counts without crushing latency.
 */
const LIST_HYDRATE_TOP_BROAD = 0;
const LIST_HYDRATE_TOP_NARROW = 5;
/** FAC light lookups per page (flags only). Rest still score without FAC. */
const LIST_FAC_TOP_BROAD = 8;
const LIST_FAC_TOP_NARROW = 12;

/** Free Render proxy ~100s; leave headroom for awards fetch + JSON. */
function enrichDeadlineMs(): number {
  const n = Number(process.env.ENRICH_BUDGET_MS);
  return Number.isFinite(n) && n >= 10_000 ? n : 25_000;
}

function sampleGrantTotal(g: MutableFacility): number {
  return g.awardAmounts.reduce((s, x) => s + Math.abs(x), 0);
}

/**
 * Replace sample awards with the recipient's full grant list (last ~10y).
 * Hydrates only the top maxHydrate by sample $ (page is already $‑sorted).
 * Remaining rows stay sample-labeled in the UI.
 */
async function hydrateFullGrants(
  groups: MutableFacility[],
  deadline: number,
  maxHydrate: number,
): Promise<number> {
  if (maxHydrate <= 0) return 0;
  const targets = groups.slice(0, maxHydrate);
  let hydrated = 0;

  await mapPool(targets, 3, async (g) => {
    if (Date.now() > deadline) return;
    try {
      const { awards } = await fetchGrantsForRecipient({
        uei: g.uei,
        name: g.name,
        maxPages: MAX_PAGES_PER_RECIPIENT_LIST,
      });
      if (awards.length === 0) return;

      if (!g.uei) {
        for (const a of awards) {
          if (a["Recipient UEI"]) {
            g.uei = String(a["Recipient UEI"]).trim().toUpperCase();
            break;
          }
        }
      }

      const amounts: number[] = [];
      const cfdaCounts = new Map<string, number>();
      const awardTypes = new Set<string>();

      for (const award of awards) {
        const amount = award["Award Amount"];
        if (
          typeof amount === "number" &&
          Number.isFinite(amount) &&
          amount !== 0
        ) {
          amounts.push(amount);
        }
        const cfda = extractCfdaFromAward(award);
        if (cfda) {
          cfdaCounts.set(cfda, (cfdaCounts.get(cfda) ?? 0) + 1);
        }
        if (award["Award Type"]) {
          awardTypes.add(String(award["Award Type"]));
        }
      }

      g.awardAmounts = amounts;
      g.scoreAmounts = cleanAmountsForScoring(amounts);
      g.cfdaCounts = cfdaCounts.size > 0 ? cfdaCounts : g.cfdaCounts;
      g.awardTypes = awardTypes.size > 0 ? awardTypes : g.awardTypes;
      g.grantsHydrated = true;
      g.hydratedGrantCount = awards.length;
      hydrated += 1;
    } catch {
      /* keep sample-based data */
    }
  });

  return hydrated;
}

/** Broad state/type searches: fewer upstream calls (still free-tier friendly). */
export function isBroadSearch(filters: FacilityFilters): boolean {
  return !filters.city?.trim() && !filters.county?.trim() && !filters.q?.trim();
}

export function normalizePageOptions(
  opts?: AggregatePageOptions,
): { page: number; pageSize: number } {
  const rawSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.max(
    5,
    Math.min(MAX_PAGE_SIZE, Number.isFinite(rawSize) ? Math.floor(rawSize) : DEFAULT_PAGE_SIZE),
  );
  const rawPage = opts?.page ?? 1;
  const page = Math.max(1, Number.isFinite(rawPage) ? Math.floor(rawPage) : 1);
  return { page, pageSize };
}

export async function aggregateAwardsToFacilities(
  awards: AwardRow[],
  filters: FacilityFilters,
  transactions: TransactionRow[] = [],
  pageOpts?: AggregatePageOptions,
): Promise<AggregateResult> {
  let groups = groupAwards(awards);
  mergeTransactions(groups, transactions);

  if (filters.county?.trim()) {
    const needle = filters.county.trim().toLowerCase();
    groups = groups.filter((f) => {
      const county = (f.county ?? "").toLowerCase();
      const city = (f.city ?? "").toLowerCase();
      const name = f.name.toLowerCase();
      return (
        county.includes(needle) ||
        city.includes(needle) ||
        name.includes(needle)
      );
    });
  }

  // Stable order for pagination: largest sample grant $ first
  groups.sort((a, b) => sampleGrantTotal(b) - sampleGrantTotal(a));

  const { page: rawPage, pageSize } = normalizePageOptions(pageOpts);
  const totalFacilityCount = groups.length;
  const totalPages = Math.max(1, Math.ceil(totalFacilityCount / pageSize) || 1);
  const page = Math.min(rawPage, totalPages);
  const start = (page - 1) * pageSize;
  // Enrich only this page so broad CA healthcare fits under free-host timeouts
  const pageGroups = groups.slice(start, start + pageSize);

  const deadline = Date.now() + enrichDeadlineMs();
  const broad = isBroadSearch(filters);
  const hydrateTop = broad ? LIST_HYDRATE_TOP_BROAD : LIST_HYDRATE_TOP_NARROW;
  const facTop = broad ? LIST_FAC_TOP_BROAD : LIST_FAC_TOP_NARROW;

  // Load facility → fraud-chance map (small Redis keys, shared across searches)
  const skipScoreCache = Boolean(pageOpts?.skipScoreCache);
  const awaitScoreWrites = Boolean(pageOpts?.awaitScoreWrites);
  const scoreMap = skipScoreCache
    ? new Map()
    : await getFacilityScores(pageGroups.map((g) => g.id));
  const cachedOk = new Set<string>();
  if (!skipScoreCache) {
    for (const g of pageGroups) {
      const entry = scoreMap.get(g.id);
      if (!entry) continue;
      const grantReceived = positiveAmounts(g.awardAmounts).reduce(
        (a, b) => a + b,
        0,
      );
      const awardCount = positiveAmounts(g.awardAmounts).length;
      if (scoreEntryStillValid(entry, grantReceived, awardCount)) {
        cachedOk.add(g.id);
      }
    }
  }
  const scoreCacheHits = cachedOk.size;

  // UEI backfill is slow (USAspending profile). Skip on broad — awards usually have UEI.
  if (!broad) {
    const missingUei = pageGroups.filter(
      (g) =>
        !cachedOk.has(g.id) &&
        !g.uei &&
        g.id &&
        !g.id.startsWith("name:"),
    );
    await mapPool(missingUei.slice(0, 10), 4, async (g) => {
      if (Date.now() > deadline) return;
      const uei = await fetchUeiForRecipientId(g.id);
      if (uei) g.uei = uei;
    });
  }

  type FacData = Awaited<ReturnType<typeof fetchFacByUei>>;
  type SamData = Awaited<ReturnType<typeof fetchSamByUei>>;
  const facByUei = new Map<string, FacData>();
  const samByUei = new Map<string, SamData>();
  const baselineMap = new Map<string, CfdaBaseline | null>();
  let subMap = new Map<string, ReturnType<typeof subawardConcentrationByPrime> extends Map<string, infer V> ? V : never>();
  let subawardRows = 0;
  let grantsHydratedCount = 0;

  // Only enrich rows without a valid score map hit
  const needEnrich = pageGroups.filter((g) => !cachedOk.has(g.id));
  const pageUeis = [
    ...new Set(
      needEnrich.map((g) => g.uei).filter((u): u is string => Boolean(u)),
    ),
  ];
  const facUeis = [
    ...new Set(
      needEnrich
        .slice(0, facTop)
        .map((g) => g.uei)
        .filter((u): u is string => Boolean(u)),
    ),
  ];

  // Hydrate (optional) ∥ FAC light ∥ SAM local — only uncached rows
  await Promise.all([
    (async () => {
      grantsHydratedCount = await hydrateFullGrants(
        needEnrich,
        deadline,
        hydrateTop,
      );
    })(),
    (async () => {
      await mapPool(facUeis, 5, async (uei) => {
        if (Date.now() > deadline) return;
        facByUei.set(
          uei,
          await fetchFacByUei(uei, { includeFindings: false }),
        );
      });
    })(),
    (async () => {
      await mapPool(pageUeis, 20, async (uei) => {
        samByUei.set(uei, await fetchSamByUei(uei));
      });
    })(),
    (async () => {
      if (broad || Date.now() > deadline) return;
      const cfdaNeeded = new Set<string>();
      for (const g of needEnrich.slice(0, hydrateTop || 5)) {
        const c = primaryCfda(g.cfdaCounts);
        if (c) cfdaNeeded.add(c);
      }
      await Promise.all(
        [...cfdaNeeded].slice(0, 3).map(async (code) => {
          if (Date.now() > deadline) return;
          baselineMap.set(code, await fetchCfdaBaseline(code));
        }),
      );
    })(),
    (async () => {
      if (broad || Date.now() > deadline) return;
      try {
        const sub = await fetchSubawards(filters, 2);
        subawardRows = sub.rows.length;
        subMap = subawardConcentrationByPrime(sub.rows);
      } catch (err) {
        console.warn("[subawards]", err);
      }
    })(),
  ]);

  // Temporal from transactions (may be empty on broad searches)
  const txnByRecipient = groupTransactionsByRecipient(transactions);

  const facilities: Facility[] = pageGroups.map((m) => {
    // Prefer full recipient grant count (USASpending Grants tab), not sample size
    const awardCount =
      m.hydratedGrantCount != null
        ? m.hydratedGrantCount
        : positiveAmounts(m.awardAmounts).length;
    const grantReceived = positiveAmounts(m.awardAmounts).reduce(
      (a, b) => a + b,
      0,
    );
    const cfda = primaryCfda(m.cfdaCounts);
    const types = [...m.awardTypes];
    const features = extractAmountFeatures(m.scoreAmounts);
    const benfordDetail = scoreAmountsWithBenford(m.scoreAmounts);

    // Fast path: facility → fraud chance map hit
    const cached = scoreMap.get(m.id);
    if (cached && cachedOk.has(m.id)) {
      const base: Facility = {
        id: m.id,
        name: m.name,
        city: m.city,
        county: m.county,
        state: m.state,
        grantReceived,
        awardCount,
        grantsHydrated: m.grantsHydrated || cached.grantsHydrated,
        sampleCount: features.n,
        fraudChance: cached.fraudChance,
        fraudLabel: cached.fraudLabel,
        confidence: cached.confidence,
        scoreMethod: cached.scoreMethod,
        scoreStatus: "ok",
        benfordScore: cached.benfordScore,
        multiScore: cached.multiScore,
        signals: cached.signals,
        avgAward: cached.avgAward ?? (awardCount ? grantReceived / awardCount : null),
        primaryCfda: cfda ?? cached.primaryCfda,
        awardTypes: types,
        uei: m.uei ?? cached.uei,
        recipientId: m.id.startsWith("name:") ? null : m.id,
        benfordEligible: features.n >= 3,
        enrichment: cached.enrichment,
        rescore: {
          scoreAmounts: m.scoreAmounts,
          awardTypes: types,
          usedTransactions: m.usedTransactions,
          primaryCfda: cfda ?? cached.primaryCfda ?? null,
          grantReceived,
          awardCount,
        },
        benford: benfordDetail.benford,
        features,
        deepScored: m.usedTransactions,
      };
      return applyScoreEntry(base, cached);
    }

    const baseline = cfda ? (baselineMap.get(cfda) ?? null) : null;
    const facLookup = m.uei ? facByUei.get(m.uei) : undefined;
    const samLookup = m.uei ? samByUei.get(m.uei) : undefined;
    const fac = facLookup?.status === "ok" ? facLookup.data : null;
    const sam = samLookup?.status === "ok" ? samLookup.data : null;
    const enrichmentFailed = Boolean(
      m.uei &&
        ((facLookup && facLookup.status === "error") ||
          (samLookup && samLookup.status === "error")),
    );
    const failReasons: string[] = [];
    if (facLookup?.status === "error") failReasons.push(`FAC: ${facLookup.message}`);
    if (samLookup?.status === "error") failReasons.push(`SAM: ${samLookup.message}`);

    const sub = subMap.get(m.id) ?? null;
    const txns = txnByRecipient.get(m.id) ?? [];
    const temporal =
      txns.length > 0 ? temporalRiskFromTransactions(m.id, txns) : null;

    const multi = computeMultiSignalScore({
      scoreAmounts: m.scoreAmounts,
      features,
      grantReceived,
      awardCount,
      awardTypes: types,
      usedTransactions: m.usedTransactions,
      cfdaBaseline: baseline,
      fac,
      sam,
      subaward: sub,
      temporal,
    });

    return {
      id: m.id,
      name: m.name,
      city: m.city,
      county: m.county,
      state: m.state,
      grantReceived,
      awardCount,
      grantsHydrated: m.grantsHydrated,
      sampleCount: features.n,
      fraudChance: multi.multiScore,
      fraudLabel: fraudLabelFromChance(multi.multiScore),
      confidence: multi.confidence,
      scoreMethod: multi.multiScore != null ? "statistical" : "none",
      scoreStatus: enrichmentFailed ? "failed" : "ok",
      failReasons: failReasons.length ? failReasons : undefined,
      benfordScore: multi.signals.benford,
      multiScore: multi.multiScore,
      signals: multi.signals as SignalBreakdown,
      avgAward: multi.avgAward,
      primaryCfda: cfda,
      awardTypes: types,
      uei: m.uei,
      recipientId: m.id.startsWith("name:") ? null : m.id,
      benfordEligible: multi.benfordEligible,
      enrichment: {
        fac: fac
          ? {
              found: fac.found,
              riskScore: fac.riskScore,
              findingsCount: fac.findingsCount,
              materialWeakness: fac.materialWeakness,
              goingConcern: fac.goingConcern,
              lowRiskAuditee: fac.lowRiskAuditee,
              reportId: fac.reportId,
              auditYear: fac.auditYear,
            }
          : null,
        sam: sam
          ? {
              found: sam.found,
              riskScore: sam.riskScore,
              excluded: sam.excluded,
              registrationAgeDays: sam.registrationAgeDays,
              legalBusinessName: sam.legalBusinessName,
            }
          : null,
        subaward: sub
          ? {
              riskScore: sub.riskScore,
              topSubShare: sub.topSubShare,
              uniqueSubs: sub.uniqueSubs,
            }
          : null,
        temporal: temporal
          ? {
              riskScore: temporal.riskScore,
              fyq4Share: temporal.fyq4Share,
              deobligationShare: temporal.deobligationShare,
            }
          : null,
      },
      rescore: {
        scoreAmounts: m.scoreAmounts,
        awardTypes: types,
        usedTransactions: m.usedTransactions,
        primaryCfda: cfda,
        grantReceived,
        awardCount,
      },
      benford: benfordDetail.benford,
      features,
      deepScored: m.usedTransactions,
    };
  });

  // Persist facility → fraud chance (small keys for Upstash)
  const toWrite = facilities.filter(
    (f) => f.scoreStatus === "ok" && (skipScoreCache || !cachedOk.has(f.id)),
  );
  if (toWrite.length > 0) {
    if (awaitScoreWrites) {
      await persistFacilityScores(toWrite);
    } else {
      void persistFacilityScores(toWrite).catch(() => {
        /* ignore */
      });
    }
  }

  // Within this page: fraud chance first, then dollars
  facilities.sort((a, b) => {
    const fa = a.fraudChance ?? -1;
    const fb = b.fraudChance ?? -1;
    if (fb !== fa) return fb - fa;
    return b.grantReceived - a.grantReceived;
  });

  return {
    facilities,
    transactionCount: transactions.length,
    totalFacilityCount,
    page,
    pageSize,
    totalPages,
    enrichment: {
      facLookups: facByUei.size,
      samLookups: samByUei.size,
      subawardRows,
      grantsHydrated: grantsHydratedCount,
      scoreCacheHits,
    },
  };
}

/**
 * Retry enrichment (FAC/SAM) + rescore one facility. Used when lookups fail/timeout.
 */
export async function rescoreFacility(input: {
  facility: Facility;
}): Promise<Facility> {
  const f = input.facility;
  const payload = f.rescore;
  if (!payload) {
    throw new Error("Facility is missing rescore data.");
  }

  const uei = f.uei?.trim().toUpperCase() || null;
  const [facLookup, samLookup, baseline] = await Promise.all([
    // Full FAC (with findings) on rescore / deep dive retry
    uei
      ? fetchFacByUei(uei, { includeFindings: true })
      : Promise.resolve({ status: "skipped" as const }),
    uei ? fetchSamByUei(uei) : Promise.resolve({ status: "skipped" as const }),
    payload.primaryCfda
      ? fetchCfdaBaseline(payload.primaryCfda)
      : Promise.resolve(null),
  ]);

  const fac = facLookup.status === "ok" ? facLookup.data : null;
  const sam = samLookup.status === "ok" ? samLookup.data : null;
  const notes: string[] = [];
  if (facLookup.status === "error") notes.push(`FAC unavailable: ${facLookup.message}`);
  if (samLookup.status === "error") notes.push(`SAM unavailable: ${samLookup.message}`);

  const sub = f.enrichment?.subaward
    ? {
        primeRecipientId: f.id,
        subCount: f.enrichment.subaward.uniqueSubs,
        uniqueSubs: f.enrichment.subaward.uniqueSubs,
        totalSubAmount: 0,
        topSubShare: f.enrichment.subaward.topSubShare,
        riskScore: f.enrichment.subaward.riskScore,
      }
    : null;

  const temporal = f.enrichment?.temporal
    ? {
        recipientKey: f.id,
        txnCount: 10,
        fyq4Share: f.enrichment.temporal.fyq4Share,
        modChurn: 0,
        deobligationShare: f.enrichment.temporal.deobligationShare,
        riskScore: f.enrichment.temporal.riskScore,
      }
    : null;

  const features =
    f.features ?? extractAmountFeatures(payload.scoreAmounts);
  const benfordDetail = scoreAmountsWithBenford(payload.scoreAmounts);

  // Always rescore with whatever enrichment we got (partial OK)
  const multi = computeMultiSignalScore({
    scoreAmounts: payload.scoreAmounts,
    features,
    grantReceived: payload.grantReceived,
    awardCount: payload.awardCount,
    awardTypes: payload.awardTypes,
    usedTransactions: payload.usedTransactions,
    cfdaBaseline: baseline,
    fac,
    sam,
    subaward: sub,
    temporal,
  });

  // After a retry attempt we always settle: show score (or N/A), never keep spinning.
  // Partial enrichment (e.g. SAM down) is fine, score without that data.
  const updated: Facility = {
    ...f,
    fraudChance: multi.multiScore,
    fraudLabel: fraudLabelFromChance(multi.multiScore),
    confidence: multi.confidence,
    scoreMethod: multi.multiScore != null ? "statistical" : "none",
    scoreStatus: "ok",
    failReasons: notes.length ? notes : undefined,
    benfordScore: multi.signals.benford,
    multiScore: multi.multiScore,
    signals: multi.signals as SignalBreakdown,
    avgAward: multi.avgAward,
    benfordEligible: multi.benfordEligible,
    enrichment: {
      fac: fac
        ? {
            found: fac.found,
            riskScore: fac.riskScore,
            findingsCount: fac.findingsCount,
            materialWeakness: fac.materialWeakness,
            goingConcern: fac.goingConcern,
            lowRiskAuditee: fac.lowRiskAuditee,
            reportId: fac.reportId,
            auditYear: fac.auditYear,
          }
        : f.enrichment?.fac ?? null,
      sam: sam
        ? {
            found: sam.found,
            riskScore: sam.riskScore,
            excluded: sam.excluded,
            registrationAgeDays: sam.registrationAgeDays,
            legalBusinessName: sam.legalBusinessName,
          }
        : f.enrichment?.sam ?? null,
      subaward: f.enrichment?.subaward ?? null,
      temporal: f.enrichment?.temporal ?? null,
    },
    benford: benfordDetail.benford,
    features,
  };
  void setFacilityScore(facilityToScoreEntry(updated)).catch(() => {});
  return updated;
}
