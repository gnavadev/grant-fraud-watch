/**
 * Publish / serve bulk scores via Upstash Redis (storage-tight for free 256MB).
 *
 * Keys:
 *   gfw:bulk:current              → buildId
 *   gfw:bulk:{build}:fac:{id}     → slim facility JSON (scored only)
 *   gfw:bulk:{build}:rank:{ST}:{type} → ZSET member=id score=fraudChance
 *   gfw:bulk:{build}:meta:{ST}:{type} → coverage meta
 *   gfw:bulk:{build}:info         → build stats
 */
import { getRedis } from "./cache.js";
import type { BulkScoredFacility } from "./bulkScore.js";
import type {
  FacilitiesResponse,
  Facility,
  FacilityFilters,
  FacilityTypeKey,
} from "./types.js";

const PREFIX = "gfw:bulk:";

export function bulkCurrentKey(): string {
  return `${PREFIX}current`;
}

export function bulkFacKey(buildId: string, id: string): string {
  return `${PREFIX}${buildId}:fac:${id}`;
}

export function bulkRankKey(
  buildId: string,
  state: string,
  type: FacilityTypeKey | string,
): string {
  return `${PREFIX}${buildId}:rank:${state.toUpperCase()}:${type}`;
}

export function bulkMetaKey(
  buildId: string,
  state: string,
  type: FacilityTypeKey | string,
): string {
  return `${PREFIX}${buildId}:meta:${state.toUpperCase()}:${type}`;
}

export interface BulkRankMeta {
  nScored: number;
  nInsufficient: number;
  facilityCount: number;
  builtAt: string;
  buildId: string;
}

const DISCLAIMER =
  "Audit-worthiness ranking from offline bulk awards (USAspending archive) + FAC dissemination. Universe: assistance awards types 02–05 in loaded fiscal years. Not proof of fraud.";

/** Minimal list row — avoids bloating free Upstash (256MB). */
function slimFacilityForRedis(b: BulkScoredFacility): Facility {
  const emptyBenford = {
    counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
    n: b.sampleCount,
    mad: null as number | null,
    chiSquare: null as number | null,
  };
  return {
    id: b.id,
    name: b.name,
    city: b.city,
    county: b.county,
    state: b.state,
    grantReceived: b.grantReceived,
    awardCount: b.awardCount,
    grantsHydrated: true,
    sampleCount: b.sampleCount,
    fraudChance: b.fraudChance,
    fraudLabel: b.fraudLabel,
    confidence: b.confidence,
    scoreMethod: b.scoreMethod,
    scoreStatus: "ok",
    benfordScore: b.benfordScore,
    multiScore: b.multiScore,
    signals: b.signals,
    avgAward: b.avgAward,
    primaryCfda: b.primaryCfda,
    awardTypes: [],
    uei: b.uei,
    recipientId: b.recipientId ?? null,
    benfordEligible: b.benfordEligible,
    enrichment: {
      fac: b.enrichment?.fac
        ? {
            found: b.enrichment.fac.found,
            riskScore: b.enrichment.fac.riskScore,
            findingsCount: b.enrichment.fac.findingsCount,
            materialWeakness: b.enrichment.fac.materialWeakness,
            goingConcern: b.enrichment.fac.goingConcern,
            lowRiskAuditee: b.enrichment.fac.lowRiskAuditee,
            reportId: b.enrichment.fac.reportId ?? null,
            auditYear: b.enrichment.fac.auditYear ?? null,
          }
        : null,
      sam: b.enrichment?.sam
        ? {
            found: b.enrichment.sam.found,
            riskScore: b.enrichment.sam.riskScore,
            excluded: b.enrichment.sam.excluded,
            registrationAgeDays: b.enrichment.sam.registrationAgeDays,
            legalBusinessName: null,
          }
        : null,
      subaward: null,
      temporal: null,
    },
    benford: (b.benford ?? emptyBenford) as Facility["benford"],
    features: {
      n: b.sampleCount,
      sum: b.grantReceived,
      mean: b.avgAward ?? 0,
      std: 0,
      median: 0,
      min: 0,
      max: 0,
      cv: 0,
      maxToMean: 0,
      pctRound: 0,
      pctNegative: 0,
      logSum: 0,
      logMean: 0,
      digitEntropy: 0,
      benfordMad: 0,
      benfordChi: 0,
    },
    deepScored: false,
  };
}

/**
 * Delete keys matching prefix patterns (free-tier reclaim).
 * Uses SCAN; best-effort.
 */
export async function purgeRedisPrefixes(
  prefixes: string[],
  maxDelete = 50_000,
): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  let deleted = 0;
  for (const p of prefixes) {
    let cursor: string | number = 0;
    do {
      const res = (await r.scan(cursor, {
        match: `${p}*`,
        count: 200,
      })) as [string | number, string[]];
      cursor = res[0];
      const keys = res[1] ?? [];
      if (keys.length) {
        // del in small batches
        for (let i = 0; i < keys.length; i += 50) {
          const chunk = keys.slice(i, i + 50);
          await r.del(...chunk);
          deleted += chunk.length;
          if (deleted >= maxDelete) return deleted;
        }
      }
    } while (String(cursor) !== "0");
  }
  return deleted;
}

/**
 * Write a full build to Redis and flip bulk:current.
 * Only stores **scored** facilities (not insufficient) to fit free tier.
 */
export async function publishBulkBuild(
  facilities: BulkScoredFacility[],
  opts?: { buildId?: string; purgeLegacy?: boolean },
): Promise<{ buildId: string; rankKeys: number; facKeys: number; purged: number }> {
  const r = getRedis();
  if (!r) {
    throw new Error(
      "Redis not configured (UPSTASH_REDIS_REST_URL + TOKEN). Bulk publish requires Redis.",
    );
  }

  // Space already reclaimed in bulkPublish pre-purge; optional second pass
  let purged = 0;
  if (opts?.purgeLegacy === true) {
    purged = await purgeRedisPrefixes(["gfw:bulk:", "gfw:"], 20_000);
  }

  const buildId =
    opts?.buildId ??
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ttlSec = 21 * 24 * 3600; // 21 days

  const ranks = new Map<string, { id: string; score: number }[]>();
  const metaAcc = new Map<
    string,
    { scored: number; insufficient: number; total: number }
  >();

  // Only persist detail hashes for rankable (scored) orgs
  const scoredOnly = facilities.filter(
    (b) => !b.insufficient && b.fraudChance != null,
  );

  let facKeys = 0;
  const pending: Promise<unknown>[] = [];

  async function flush() {
    if (!pending.length) return;
    await Promise.all(pending);
    pending.length = 0;
  }

  for (const b of scoredOnly) {
    const fac = slimFacilityForRedis(b);
    pending.push(r.set(bulkFacKey(buildId, b.id), fac, { ex: ttlSec }));
    facKeys += 1;
    if (pending.length >= 25) await flush();
  }
  await flush();

  // Build rank membership for ALL facilities (counts include insufficient)
  for (const b of facilities) {
    const typeList = [...new Set([...b.types, "all" as const])];
    for (const type of typeList) {
      const rk = `${b.state}|${type}`;
      if (!ranks.has(rk)) ranks.set(rk, []);
      if (!metaAcc.has(rk)) {
        metaAcc.set(rk, { scored: 0, insufficient: 0, total: 0 });
      }
      const m = metaAcc.get(rk)!;
      m.total += 1;
      if (b.insufficient || b.fraudChance == null) m.insufficient += 1;
      else {
        m.scored += 1;
        ranks.get(rk)!.push({ id: b.id, score: b.fraudChance });
      }
    }
  }

  let rankKeys = 0;
  for (const [rk, members] of ranks) {
    const [state, type] = rk.split("|");
    const zkey = bulkRankKey(buildId, state, type);
    await r.del(zkey);
    if (members.length > 0) {
      for (let i = 0; i < members.length; i += 80) {
        const chunk = members.slice(i, i + 80).map((m) => ({
          score: m.score,
          member: m.id,
        }));
        if (!chunk.length) continue;
        const [first, ...rest] = chunk;
        await r.zadd(zkey, first, ...rest);
      }
      await r.expire(zkey, ttlSec);
    }
    rankKeys += 1;

    const m = metaAcc.get(rk)!;
    const meta: BulkRankMeta = {
      nScored: m.scored,
      nInsufficient: m.insufficient,
      facilityCount: m.total,
      builtAt: new Date().toISOString(),
      buildId,
    };
    await r.set(bulkMetaKey(buildId, state, type), meta, { ex: ttlSec });
  }

  await r.set(
    `${PREFIX}${buildId}:info`,
    {
      builtAt: new Date().toISOString(),
      recipients: facilities.length,
      scoredStored: scoredOnly.length,
      rankKeys,
      facKeys,
    },
    { ex: ttlSec },
  );

  await r.set(bulkCurrentKey(), buildId);

  return { buildId, rankKeys, facKeys, purged };
}

export async function getBulkBuildId(): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  const v = await r.get<string>(bulkCurrentKey());
  return v ? String(v) : null;
}

function normPlace(s: string | null | undefined): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bcounty\b/g, "")
    .trim();
}

/** Case-insensitive place match: exact, contains, or "Los Angeles" vs "LOS ANGELES". */
function matchesPlace(
  field: string | null | undefined,
  needle: string | undefined,
): boolean {
  if (!needle?.trim()) return true;
  const f = normPlace(field);
  const n = normPlace(needle);
  if (!n) return true;
  if (!f) return false;
  return f === n || f.includes(n) || n.includes(f);
}

function matchesName(
  name: string | null | undefined,
  needle: string | undefined,
): boolean {
  if (!needle?.trim()) return true;
  const f = (name ?? "").trim().toLowerCase();
  const n = needle.trim().toLowerCase();
  return f.includes(n);
}

async function loadFacilitiesByIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r: any,
  buildId: string,
  ids: string[],
): Promise<Facility[]> {
  const out: Facility[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const keys = chunk.map((id) => bulkFacKey(buildId, id));
    const rows = (await r.mget(...keys)) as (Facility | null)[];
    for (const fac of rows) {
      if (fac && typeof fac === "object" && fac.id) out.push(fac);
    }
  }
  return out;
}

/**
 * Serve ranked facilities from Redis bulk build.
 * City / county / name (q) filter in-memory on facility hashes — no live APIs.
 */
export async function getFacilitiesFromBulk(
  filters: FacilityFilters,
  page: number,
  pageSize: number,
): Promise<FacilitiesResponse | null> {
  const r = getRedis();
  if (!r) return null;

  const buildId = await getBulkBuildId();
  if (!buildId) return null;

  const state = filters.state?.trim().toUpperCase();
  if (!state) return null;

  const type: FacilityTypeKey | string = filters.type ?? "all";
  const zkey = bulkRankKey(buildId, state, type);
  const meta = await r.get<BulkRankMeta>(bulkMetaKey(buildId, state, type));

  const zcard = (await r.zcard(zkey)) ?? 0;
  if (!zcard && !meta?.nScored) return null;

  const cityQ = filters.city?.trim();
  const countyQ = filters.county?.trim();
  const nameQ = filters.q?.trim();
  const needsFilter = Boolean(cityQ || countyQ || nameQ);

  let facilities: Facility[];
  let total: number;
  let insufficientCount = meta?.nInsufficient ?? 0;

  if (!needsFilter) {
    // Fast path: page directly from ZSET
    total = meta?.nScored ?? zcard;
    if (!total) return null;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    const end = start + pageSize - 1;
    const ids = (await r.zrange(zkey, start, end, { rev: true })) as string[];
    facilities = await loadFacilitiesByIds(r, buildId, ids);
    const scoredCount = facilities.filter((f) => f.fraudChance != null).length;
    return {
      facilities,
      meta: {
        awardCount: meta?.facilityCount ?? total,
        facilityCount: total,
        scoredCount,
        insufficientCount,
        filters,
        disclaimer: DISCLAIMER,
        transactionCount: 0,
        page: safePage,
        pageSize,
        totalPages,
        hasMore: safePage < totalPages,
        cache: { awards: true, transactions: true, response: true },
        bulk: {
          buildId,
          mode: "bulk",
          nScored: meta?.nScored ?? total,
        },
      },
    };
  }

  // City / county / name: load full ranked id list, hydrate, filter, then page.
  // Still Redis-only — no USAspending/FAC.
  const allIds = (await r.zrange(zkey, 0, -1, { rev: true })) as string[];
  if (!allIds.length) return null;

  const allFacs = await loadFacilitiesByIds(r, buildId, allIds);
  const filtered = allFacs.filter(
    (f) =>
      matchesPlace(f.city, cityQ) &&
      matchesPlace(f.county, countyQ) &&
      matchesName(f.name, nameQ),
  );

  total = filtered.length;
  // Ranking list is scored-only; insufficient count not in ZSET
  insufficientCount = 0;

  if (total === 0) {
    // Valid bulk coverage but no geo/name match — empty result, not legacy fallback
    return {
      facilities: [],
      meta: {
        awardCount: meta?.facilityCount ?? 0,
        facilityCount: 0,
        scoredCount: 0,
        insufficientCount: 0,
        filters,
        disclaimer: DISCLAIMER,
        transactionCount: 0,
        page: 1,
        pageSize,
        totalPages: 1,
        hasMore: false,
        cache: { awards: true, transactions: true, response: true },
        bulk: {
          buildId,
          mode: "bulk",
          nScored: meta?.nScored ?? 0,
        },
      },
    };
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  facilities = filtered.slice(start, start + pageSize);
  const scoredCount = facilities.filter((f) => f.fraudChance != null).length;

  return {
    facilities,
    meta: {
      awardCount: meta?.facilityCount ?? total,
      facilityCount: total,
      scoredCount,
      insufficientCount,
      filters,
      disclaimer: DISCLAIMER,
      transactionCount: 0,
      page: safePage,
      pageSize,
      totalPages,
      hasMore: safePage < totalPages,
      cache: { awards: true, transactions: true, response: true },
      bulk: {
        buildId,
        mode: "bulk",
        nScored: meta?.nScored ?? total,
      },
    },
  };
}

export async function bulkCoverage(
  state: string,
  type: string,
): Promise<BulkRankMeta | null> {
  const r = getRedis();
  if (!r) return null;
  const buildId = await getBulkBuildId();
  if (!buildId) return null;
  return r.get<BulkRankMeta>(bulkMetaKey(buildId, state, type));
}
