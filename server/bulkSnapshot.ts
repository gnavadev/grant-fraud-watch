/**
 * Static bulk ranking snapshot (no Upstash required).
 *
 * Write:  npm run bulk:score-publish  → data/bulk/snapshot.json[.gz]
 * Serve:  load into memory at first request (or BULK_SNAPSHOT_URL download)
 *
 * Structure is small enough for free hosts (~12k scored facs + rank lists).
 * Prefer committing snapshot.json.gz OR attaching a GitHub Release and setting
 * BULK_SNAPSHOT_URL on Render.
 */
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { BulkScoredFacility } from "./bulkScore.js";
import { log } from "./logger.js";
import type {
  FacilitiesResponse,
  Facility,
  FacilityFilters,
  FacilityTypeKey,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const BULK_SNAPSHOT_VERSION = 1 as const;

export interface BulkRankMeta {
  nScored: number;
  nInsufficient: number;
  facilityCount: number;
  builtAt: string;
  buildId: string;
}

export interface BulkSnapshot {
  version: typeof BULK_SNAPSHOT_VERSION;
  buildId: string;
  builtAt: string;
  /** Scored facilities only, keyed by id (UEI). */
  facilities: Record<string, Facility>;
  /**
   * Rank lists: key = `${STATE}|${type}` e.g. `CA|healthcare`.
   * Member order = highest fraudChance first.
   */
  ranks: Record<string, string[]>;
  meta: Record<string, BulkRankMeta>;
}

const DISCLAIMER =
  "Audit-worthiness ranking from offline bulk awards (USAspending archive) + FAC dissemination. Universe: assistance awards types 02–05 in loaded fiscal years. Not proof of fraud.";

export function defaultBulkDataDir(): string {
  return (
    process.env.BULK_DATA_DIR?.trim() || path.join(ROOT, "data", "bulk")
  );
}

export function snapshotJsonPath(dir = defaultBulkDataDir()): string {
  return path.join(dir, "snapshot.json");
}

export function snapshotGzPath(dir = defaultBulkDataDir()): string {
  return path.join(dir, "snapshot.json.gz");
}

/** Slim facility for snapshot / Redis (no amounts[], no rescore payload). */
export function slimFacilityForBulk(b: BulkScoredFacility): Facility {
  const features = b.features ?? {
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
  };
  const emptyDigitCounts: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
    "6": 0,
    "7": 0,
    "8": 0,
    "9": 0,
  };
  const benford = b.benford ?? {
    sampleSize: b.sampleCount,
    chiSquare: null,
    mad: null,
    digitCounts: emptyDigitCounts,
    minFullSample: 50,
    minLowSample: 1,
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
    benford,
    features,
    deepScored: false,
  };
}

export function buildBulkSnapshot(
  facilities: BulkScoredFacility[],
  opts?: { buildId?: string },
): BulkSnapshot {
  const buildId =
    opts?.buildId ??
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const builtAt = new Date().toISOString();

  const scoredOnly = facilities.filter(
    (b) => !b.insufficient && b.fraudChance != null,
  );

  const facMap: Record<string, Facility> = {};
  for (const b of scoredOnly) {
    facMap[b.id] = slimFacilityForBulk(b);
  }

  /** rankKey → { id, score }[] */
  const rankAcc = new Map<string, { id: string; score: number }[]>();
  const metaAcc = new Map<
    string,
    { scored: number; insufficient: number; total: number }
  >();

  for (const b of facilities) {
    const typeList = [...new Set([...b.types, "all" as const])];
    for (const type of typeList) {
      const rk = `${b.state.toUpperCase()}|${type}`;
      if (!rankAcc.has(rk)) rankAcc.set(rk, []);
      if (!metaAcc.has(rk)) {
        metaAcc.set(rk, { scored: 0, insufficient: 0, total: 0 });
      }
      const m = metaAcc.get(rk)!;
      m.total += 1;
      if (b.insufficient || b.fraudChance == null) m.insufficient += 1;
      else {
        m.scored += 1;
        rankAcc.get(rk)!.push({ id: b.id, score: b.fraudChance });
      }
    }
  }

  const ranks: Record<string, string[]> = {};
  const meta: Record<string, BulkRankMeta> = {};
  for (const [rk, members] of rankAcc) {
    members.sort((a, b) => b.score - a.score);
    ranks[rk] = members.map((m) => m.id);
    const m = metaAcc.get(rk)!;
    meta[rk] = {
      nScored: m.scored,
      nInsufficient: m.insufficient,
      facilityCount: m.total,
      builtAt,
      buildId,
    };
  }

  return {
    version: BULK_SNAPSHOT_VERSION,
    buildId,
    builtAt,
    facilities: facMap,
    ranks,
    meta,
  };
}

export async function writeBulkSnapshot(
  snap: BulkSnapshot,
  dir = defaultBulkDataDir(),
): Promise<{ jsonPath: string; gzPath: string; jsonBytes: number; gzBytes: number }> {
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = snapshotJsonPath(dir);
  const gzPath = snapshotGzPath(dir);
  const json = JSON.stringify(snap);
  await fs.writeFile(jsonPath, json, "utf8");

  await pipeline(
    Readable.from([json]),
    createGzip({ level: 9 }),
    createWriteStream(gzPath),
  );

  const jsonBytes = Buffer.byteLength(json, "utf8");
  const gzStat = await fs.stat(gzPath);
  return { jsonPath, gzPath, jsonBytes, gzBytes: gzStat.size };
}

let memory: BulkSnapshot | null = null;
let loadPromise: Promise<BulkSnapshot | null> | null = null;

export function getLoadedBulkSnapshot(): BulkSnapshot | null {
  return memory;
}

export function setLoadedBulkSnapshot(snap: BulkSnapshot | null): void {
  memory = snap;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

async function readGzJsonFileSimple(filePath: string): Promise<unknown> {
  const buf = await fs.readFile(filePath);
  const json = gunzipSync(buf).toString("utf8");
  return JSON.parse(json) as unknown;
}

function parseSnapshot(raw: unknown): BulkSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as BulkSnapshot;
  if (s.version !== 1) return null;
  if (!s.buildId || !s.facilities || !s.ranks) return null;
  return s;
}

async function downloadSnapshotUrl(url: string): Promise<BulkSnapshot | null> {
  try {
    log.info("bulk_snapshot_download", { url: url.slice(0, 120) });
    const res = await fetch(url, {
      headers: { Accept: "application/json, application/gzip, */*" },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      log.warn("bulk_snapshot_download_failed", { status: res.status });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const isGz =
      url.endsWith(".gz") ||
      res.headers.get("content-type")?.includes("gzip") ||
      (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
    let raw: unknown;
    if (isGz) {
      raw = JSON.parse(gunzipSync(buf).toString("utf8"));
    } else {
      raw = JSON.parse(buf.toString("utf8"));
    }
    // Cache to disk for next boot
    try {
      const dir = defaultBulkDataDir();
      await fs.mkdir(dir, { recursive: true });
      if (isGz) await fs.writeFile(snapshotGzPath(dir), buf);
      else await fs.writeFile(snapshotJsonPath(dir), buf);
    } catch {
      /* ok */
    }
    return parseSnapshot(raw);
  } catch (err) {
    log.warn("bulk_snapshot_download_error", { err });
    return null;
  }
}

/**
 * Load snapshot once: env path → local gz/json → BULK_SNAPSHOT_URL.
 */
export async function ensureBulkSnapshotLoaded(): Promise<BulkSnapshot | null> {
  if (memory) return memory;
  if (!loadPromise) {
    loadPromise = (async () => {
      const explicit = process.env.BULK_SNAPSHOT_PATH?.trim();
      if (explicit && existsSync(explicit)) {
        try {
          const raw = explicit.endsWith(".gz")
            ? await readGzJsonFileSimple(explicit)
            : await readJsonFile(explicit);
          const snap = parseSnapshot(raw);
          if (snap) {
            memory = snap;
            log.info("bulk_snapshot_loaded", {
              source: "BULK_SNAPSHOT_PATH",
              buildId: snap.buildId,
              facs: Object.keys(snap.facilities).length,
            });
            return snap;
          }
        } catch (err) {
          log.warn("bulk_snapshot_path_error", { err });
        }
      }

      const dir = defaultBulkDataDir();
      const gz = snapshotGzPath(dir);
      const js = snapshotJsonPath(dir);
      for (const [file, reader] of [
        [gz, readGzJsonFileSimple] as const,
        [js, readJsonFile] as const,
      ]) {
        if (!existsSync(file)) continue;
        try {
          const snap = parseSnapshot(await reader(file));
          if (snap) {
            memory = snap;
            log.info("bulk_snapshot_loaded", {
              source: file,
              buildId: snap.buildId,
              facs: Object.keys(snap.facilities).length,
            });
            return snap;
          }
        } catch (err) {
          log.warn("bulk_snapshot_file_error", { file, err });
        }
      }

      const url = process.env.BULK_SNAPSHOT_URL?.trim();
      if (url) {
        const snap = await downloadSnapshotUrl(url);
        if (snap) {
          memory = snap;
          log.info("bulk_snapshot_loaded", {
            source: "BULK_SNAPSHOT_URL",
            buildId: snap.buildId,
            facs: Object.keys(snap.facilities).length,
          });
          return snap;
        }
      }

      log.info("bulk_snapshot_missing", {
        hint: "Run npm run bulk:score-publish (writes data/bulk/snapshot.json.gz) or set BULK_SNAPSHOT_URL",
      });
      return null;
    })().finally(() => {
      /* keep loadPromise so we don't thrash; clear on failure so retries work */
      if (!memory) loadPromise = null;
    });
  }
  return loadPromise;
}

function normPlace(s: string | null | undefined): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bcounty\b/g, "")
    .trim();
}

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

function rankKey(state: string, type: string): string {
  return `${state.toUpperCase()}|${type}`;
}

export async function getBulkBuildIdFromSnapshot(): Promise<string | null> {
  const snap = await ensureBulkSnapshotLoaded();
  return snap?.buildId ?? null;
}

/**
 * Serve ranked facilities from in-memory static snapshot (no Redis).
 */
export async function getFacilitiesFromSnapshot(
  filters: FacilityFilters,
  page: number,
  pageSize: number,
): Promise<FacilitiesResponse | null> {
  const snap = await ensureBulkSnapshotLoaded();
  if (!snap) return null;

  const state = filters.state?.trim().toUpperCase();
  if (!state) return null;

  const type: FacilityTypeKey | string = filters.type ?? "all";
  const rk = rankKey(state, type);
  const ids = snap.ranks[rk] ?? [];
  const meta = snap.meta[rk];
  if (!ids.length && !meta?.nScored) return null;

  const cityQ = filters.city?.trim();
  const countyQ = filters.county?.trim();
  const nameQ = filters.q?.trim();
  const needsFilter = Boolean(cityQ || countyQ || nameQ);

  const hydrate = (idList: string[]): Facility[] => {
    const out: Facility[] = [];
    for (const id of idList) {
      const f = snap.facilities[id];
      if (f) out.push(f);
    }
    return out;
  };

  if (!needsFilter) {
    const total = meta?.nScored ?? ids.length;
    if (!total) return null;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    const pageIds = ids.slice(start, start + pageSize);
    const facilities = hydrate(pageIds);
    return {
      facilities,
      meta: {
        awardCount: meta?.facilityCount ?? total,
        facilityCount: total,
        scoredCount: facilities.filter((f) => f.fraudChance != null).length,
        insufficientCount: meta?.nInsufficient ?? 0,
        filters,
        disclaimer: DISCLAIMER,
        transactionCount: 0,
        page: safePage,
        pageSize,
        totalPages,
        hasMore: safePage < totalPages,
        cache: { awards: true, transactions: true, response: true },
        bulk: {
          buildId: snap.buildId,
          mode: "bulk",
          nScored: meta?.nScored ?? total,
        },
      },
    };
  }

  const allFacs = hydrate(ids);
  const filtered = allFacs.filter(
    (f) =>
      matchesPlace(f.city, cityQ) &&
      matchesPlace(f.county, countyQ) &&
      matchesName(f.name, nameQ),
  );
  const total = filtered.length;
  if (total === 0) {
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
          buildId: snap.buildId,
          mode: "bulk",
          nScored: meta?.nScored ?? 0,
        },
      },
    };
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const facilities = filtered.slice(start, start + pageSize);
  return {
    facilities,
    meta: {
      awardCount: meta?.facilityCount ?? total,
      facilityCount: total,
      scoredCount: facilities.filter((f) => f.fraudChance != null).length,
      insufficientCount: 0,
      filters,
      disclaimer: DISCLAIMER,
      transactionCount: 0,
      page: safePage,
      pageSize,
      totalPages,
      hasMore: safePage < totalPages,
      cache: { awards: true, transactions: true, response: true },
      bulk: {
        buildId: snap.buildId,
        mode: "bulk",
        nScored: meta?.nScored ?? total,
      },
    },
  };
}
