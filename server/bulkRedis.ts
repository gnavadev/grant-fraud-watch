/**
 * Publish / serve bulk scores via Upstash Redis.
 *
 * Keys:
 *   gfw:bulk:current              → buildId
 *   gfw:bulk:{build}:fac:{id}     → facility JSON (list payload)
 *   gfw:bulk:{build}:rank:{ST}:{type} → ZSET member=id score=fraudChance
 *   gfw:bulk:{build}:meta:{ST}:{type} → { nScored, nInsufficient, builtAt }
 *   gfw:bulk:{build}:info         → { builtAt, fy, stats }
 */
import { getRedis } from "./cache.js";
import type { BulkScoredFacility } from "./bulkScore.js";
import { bulkToFacility } from "./bulkScore.js";
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

function slimFac(f: Facility): Facility {
  return {
    ...f,
    rescore: f.rescore
      ? {
          ...f.rescore,
          scoreAmounts: (f.rescore.scoreAmounts ?? []).slice(0, 40),
        }
      : undefined,
  };
}

/**
 * Write a full build to Redis and flip scores:current.
 */
export async function publishBulkBuild(
  facilities: BulkScoredFacility[],
  opts?: { buildId?: string; retainPrevious?: boolean },
): Promise<{ buildId: string; rankKeys: number; facKeys: number }> {
  const r = getRedis();
  if (!r) {
    throw new Error(
      "Redis not configured (UPSTASH_REDIS_REST_URL + TOKEN). Bulk publish requires Redis.",
    );
  }

  const buildId =
    opts?.buildId ??
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ttlSec = 30 * 24 * 3600; // 30 days

  // Group into rank keys
  const ranks = new Map<string, { id: string; score: number }[]>();
  const metaAcc = new Map<
    string,
    { scored: number; insufficient: number; total: number }
  >();

  let facKeys = 0;
  const pipeline: Promise<unknown>[] = [];

  for (const b of facilities) {
    const fac = slimFac(bulkToFacility(b));
    const facKey = bulkFacKey(buildId, b.id);
    pipeline.push(r.set(facKey, fac, { ex: ttlSec }));
    facKeys += 1;

    // Flush pipeline periodically (Upstash REST is HTTP-per-call; batch await chunks)
    if (pipeline.length >= 40) {
      await Promise.all(pipeline);
      pipeline.length = 0;
    }

    for (const type of b.types) {
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
        ranks.get(rk)!.push({
          id: b.id,
          score: b.fraudChance,
        });
      }
    }
    // Also index under type "all"
    {
      const rk = `${b.state}|all`;
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
  if (pipeline.length) await Promise.all(pipeline);

  let rankKeys = 0;
  for (const [rk, members] of ranks) {
    const [state, type] = rk.split("|");
    const zkey = bulkRankKey(buildId, state, type);
    // Replace zset
    await r.del(zkey);
    if (members.length > 0) {
      // Upstash zadd: zadd(key, { score, member }, ...)
      const args: { score: number; member: string }[] = members.map((m) => ({
        score: m.score,
        member: m.id,
      }));
      // chunk zadd (Upstash requires at least one ScoreMember after key)
      for (let i = 0; i < args.length; i += 100) {
        const chunk = args.slice(i, i + 100);
        if (chunk.length === 0) continue;
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
      rankKeys,
      facKeys,
    },
    { ex: ttlSec },
  );

  // Atomic cutover
  await r.set(bulkCurrentKey(), buildId);

  return { buildId, rankKeys, facKeys };
}

export async function getBulkBuildId(): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  const v = await r.get<string>(bulkCurrentKey());
  return v ? String(v) : null;
}

/**
 * Serve a ranked page from Redis bulk build. Returns null if no build / no rank key.
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
  if (!state) return null; // bulk ranks are state-scoped

  // City / county / q: not supported as rank keys yet → fall back to legacy
  if (filters.city?.trim() || filters.county?.trim() || filters.q?.trim()) {
    return null;
  }

  const type: FacilityTypeKey | string = filters.type ?? "all";
  const zkey = bulkRankKey(buildId, state, type);
  const meta = await r.get<BulkRankMeta>(bulkMetaKey(buildId, state, type));
  if (!meta || meta.nScored === 0) {
    // Try existence of zset
    const card = await r.zcard(zkey);
    if (!card) return null;
  }

  const total = meta?.nScored ?? (await r.zcard(zkey)) ?? 0;
  if (!total) return null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize - 1;

  // Highest fraud chance first
  const ids = (await r.zrange(zkey, start, end, {
    rev: true,
  })) as string[];

  const facilities: Facility[] = [];
  for (const id of ids) {
    const fac = await r.get<Facility>(bulkFacKey(buildId, id));
    if (fac) facilities.push(fac);
  }

  const scoredCount = facilities.filter((f) => f.fraudChance != null).length;

  return {
    facilities,
    meta: {
      awardCount: meta?.facilityCount ?? total,
      facilityCount: total,
      scoredCount,
      insufficientCount: meta?.nInsufficient ?? 0,
      filters,
      disclaimer: DISCLAIMER,
      transactionCount: 0,
      page: safePage,
      pageSize,
      totalPages,
      hasMore: safePage < totalPages,
      cache: {
        awards: true,
        transactions: true,
        response: true,
      },
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
