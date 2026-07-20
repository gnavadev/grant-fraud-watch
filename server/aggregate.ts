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

export interface AggregateResult {
  facilities: Facility[];
  transactionCount: number;
  enrichment: {
    facLookups: number;
    samLookups: number;
    subawardRows: number;
    grantsHydrated: number;
  };
}

/** Free Render proxy ~100s; leave headroom for awards fetch + JSON. */
function enrichDeadlineMs(): number {
  const n = Number(process.env.ENRICH_BUDGET_MS);
  return Number.isFinite(n) && n >= 15_000 ? n : 55_000;
}

/**
 * Replace sample awards with the recipient's full grant list (last ~10y).
 * Sets true awardCount (e.g. 19) and scoring amounts from all grants.
 *
 * Only the top MAX_GRANT_HYDRATE facilities by sample $ are hydrated so
 * broad searches (e.g. CA healthcare, 200+ orgs) finish under free-host
 * timeouts. Remaining rows keep sample counts (UI shows "· sample").
 * Env: MAX_GRANT_HYDRATE (default 12), ENRICH_BUDGET_MS (default 55000).
 */
async function hydrateFullGrants(
  groups: MutableFacility[],
  deadline: number,
): Promise<number> {
  const maxHydrate = Math.max(
    5,
    Math.min(
      100,
      Number(process.env.MAX_GRANT_HYDRATE) || 12,
    ),
  );
  // Largest sample totals first
  const targets = [...groups]
    .sort((a, b) => {
      const sa = a.awardAmounts.reduce((s, x) => s + Math.abs(x), 0);
      const sb = b.awardAmounts.reduce((s, x) => s + Math.abs(x), 0);
      return sb - sa;
    })
    .slice(0, maxHydrate);
  let hydrated = 0;

  // Modest concurrency; USAspending also throttles inside fetchGrantsForRecipient
  await mapPool(targets, 3, async (g) => {
    if (Date.now() > deadline) return;
    try {
      const { awards } = await fetchGrantsForRecipient({
        uei: g.uei,
        name: g.name,
      });
      if (awards.length === 0) return;

      // Prefer UEI from full pull if missing
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

      // awardCount is awards.length (matches USASpending Grants tab);
      // amounts drive dollars + scoring.
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

/** Broad state/type searches skip expensive subaward pages (optional signal). */
function isBroadSearch(filters: FacilityFilters): boolean {
  return !filters.city?.trim() && !filters.county?.trim() && !filters.q?.trim();
}

export async function aggregateAwardsToFacilities(
  awards: AwardRow[],
  filters: FacilityFilters,
  transactions: TransactionRow[] = [],
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

  const deadline = Date.now() + enrichDeadlineMs();
  const broad = isBroadSearch(filters);

  // Backfill missing UEIs from recipient profiles (fixes old cache / empty field)
  const missingUei = groups.filter(
    (g) => !g.uei && g.id && !g.id.startsWith("name:"),
  );
  // Free-tier: small backfill only (hydrate also fills UEI when present on grants)
  await mapPool(missingUei.slice(0, broad ? 12 : 25), 4, async (g) => {
    if (Date.now() > deadline) return;
    const uei = await fetchUeiForRecipientId(g.id);
    if (uei) g.uei = uei;
  });

  // Full grant lists per recipient → true award counts (e.g. 19) + scoring amounts
  const grantsHydratedCount = await hydrateFullGrants(groups, deadline);

  // CFDA baselines (national program references)
  const cfdaNeeded = new Set<string>();
  for (const g of groups) {
    const c = primaryCfda(g.cfdaCounts);
    if (c) cfdaNeeded.add(c);
  }
  const baselineMap = new Map<string, CfdaBaseline | null>();
  const cfdaCap = broad ? 8 : 15;
  if (Date.now() < deadline) {
    await Promise.all(
      [...cfdaNeeded].slice(0, cfdaCap).map(async (code) => {
        if (Date.now() > deadline) return;
        baselineMap.set(code, await fetchCfdaBaseline(code));
      }),
    );
  }

  // Subawards for pass-through concentration (skip on broad CA/type searches)
  let subMap = new Map<string, ReturnType<typeof subawardConcentrationByPrime> extends Map<string, infer V> ? V : never>();
  let subawardRows = 0;
  if (!broad && Date.now() < deadline) {
    try {
      const sub = await fetchSubawards(filters, 3);
      subawardRows = sub.rows.length;
      subMap = subawardConcentrationByPrime(sub.rows);
    } catch (err) {
      console.warn("[subawards]", err);
    }
  }

  // Temporal from transactions
  const txnByRecipient = groupTransactionsByRecipient(transactions);

  // FAC + SAM by UEI.
  // SAM uses public exclusions extract (1 download/day), so all UEIs are fine.
  type FacData = Awaited<ReturnType<typeof fetchFacByUei>>;
  type SamData = Awaited<ReturnType<typeof fetchSamByUei>>;
  const facByUei = new Map<string, FacData>();
  const samByUei = new Map<string, SamData>();

  const groupsByGrant = [...groups].sort((a, b) => {
    const sa = a.awardAmounts.reduce((s, x) => s + Math.abs(x), 0);
    const sb = b.awardAmounts.reduce((s, x) => s + Math.abs(x), 0);
    return sb - sa;
  });

  // Cap FAC calls so broad searches stay under proxy timeouts
  const facCap = broad ? 12 : 20;
  const facUeis = [
    ...new Set(
      groupsByGrant.map((g) => g.uei).filter((u): u is string => Boolean(u)),
    ),
  ].slice(0, facCap);

  const samUeis = [
    ...new Set(
      groupsByGrant.map((g) => g.uei).filter((u): u is string => Boolean(u)),
    ),
  ];

  // FAC (network) + SAM (local extract) in parallel
  await Promise.all([
    mapPool(facUeis, 3, async (uei) => {
      if (Date.now() > deadline) return;
      facByUei.set(uei, await fetchFacByUei(uei));
    }),
    mapPool(samUeis, 12, async (uei) => {
      samByUei.set(uei, await fetchSamByUei(uei));
    }),
  ]);

  const facilities: Facility[] = groups.map((m) => {
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
    const baseline = cfda ? (baselineMap.get(cfda) ?? null) : null;
    const types = [...m.awardTypes];

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

    const features = extractAmountFeatures(m.scoreAmounts);
    const benfordDetail = scoreAmountsWithBenford(m.scoreAmounts);

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

  facilities.sort((a, b) => {
    const fa = a.fraudChance ?? -1;
    const fb = b.fraudChance ?? -1;
    if (fb !== fa) return fb - fa;
    return b.grantReceived - a.grantReceived;
  });

  return {
    facilities,
    transactionCount: transactions.length,
    enrichment: {
      facLookups: facByUei.size,
      samLookups: samByUei.size,
      subawardRows,
      grantsHydrated: grantsHydratedCount,
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
    uei ? fetchFacByUei(uei) : Promise.resolve({ status: "skipped" as const }),
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
  return {
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
}
