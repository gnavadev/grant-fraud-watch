import { cacheGet, cacheKey, cacheSet } from "./cache.js";
import { getKeywordsForType } from "./facilityTypes.js";
import { createThrottle, sleep } from "./throttle.js";
import type {
  AwardRow,
  FacilityFilters,
  TransactionRow,
} from "./types.js";

/** Space out recipient-level grant pulls so USAspending is less likely to 429. */
const recipientThrottle = createThrottle(120);

/** Global throttle for all USAspending POSTs (precalc uses a slower gap). */
function usaMinIntervalMs(): number {
  if (process.env.PRECALC === "1") {
    const n = Number(process.env.PRECALC_USA_GAP_MS);
    return Number.isFinite(n) && n >= 200 ? n : 800;
  }
  return 150;
}
const usaPostThrottle = createThrottle(usaMinIntervalMs);

const SPENDING_BY_AWARD =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const SPENDING_BY_TRANSACTION =
  "https://api.usaspending.gov/api/v2/search/spending_by_transaction/";

const GRANT_TYPE_CODES = ["02", "03", "04", "05"];

const AWARD_FIELDS = [
  "Award ID",
  "Recipient Name",
  "recipient_id",
  "Award Amount",
  "Recipient Location",
  "Primary Place of Performance",
  "Award Type",
  "Description",
  "CFDA Number",
  "Recipient UEI",
  "Assistance Listings",
  "primary_assistance_listing",
  "Place of Performance State Code",
  "Place of Performance City Code",
];

const TXN_FIELDS = [
  "Award ID",
  "Recipient Name",
  "recipient_id",
  "Transaction Amount",
  "Action Date",
  "Mod",
];

const PAGE_LIMIT = 100;
/** Narrow searches (city/county/q): deeper list for better samples. */
export const MAX_PAGES_SEARCH = 6; // up to 600 awards / transactions
/** Broad state+type live HTTP: fewer pages so free hosts stay under timeout. */
export const MAX_PAGES_SEARCH_BROAD = 4; // up to 400 awards
/**
 * Precalc / offline: deep pull so "all orgs in state×type" ≈ full USAspending
 * result set for that filter (100 awards/page). Override with PRECALC_AWARD_PAGES.
 */
/**
 * Precalc award depth. Keep moderate: 40×100 full award JSON can exceed Upstash
 * free 10MB per SET. Slimming helps; 20 pages is usually enough for ranking.
 */
export const MAX_PAGES_PRECALC = 20; // up to 2000 awards per state×type
/** List hydrate: enough for true counts on most orgs without 20-page pulls. */
export const MAX_PAGES_PER_RECIPIENT_LIST = 5; // up to 500 grants
/** Deep / full recipient pull safety cap. */
export const MAX_PAGES_PER_RECIPIENT = 12;

function fiscalWindowYears(yearsBack = 10): {
  start_date: string;
  end_date: string;
} {
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - yearsBack);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start_date: fmt(start), end_date: fmt(end) };
}

export function buildFilters(
  filters: FacilityFilters,
  options?: { recipientName?: string; yearsBack?: number },
): Record<string, unknown> {
  const years = options?.yearsBack ?? 10;
  const apiFilters: Record<string, unknown> = {
    award_type_codes: GRANT_TYPE_CODES,
    time_period: [fiscalWindowYears(years)],
  };

  const location: Record<string, string> = { country: "USA" };
  if (filters.state?.trim()) {
    location.state = filters.state.trim().toUpperCase();
  }
  if (filters.city?.trim()) {
    location.city = filters.city.trim();
  }

  if (location.state || location.city) {
    apiFilters.recipient_locations = [location];
  }

  const keywords: string[] = [...getKeywordsForType(filters.type)];

  if (options?.recipientName?.trim()) {
    apiFilters.recipient_search_text = [options.recipientName.trim()];
  } else if (filters.q?.trim()) {
    apiFilters.recipient_search_text = [filters.q.trim()];
  }

  if (keywords.length > 0 && !options?.recipientName) {
    apiFilters.keywords = keywords;
  }

  return apiFilters;
}

class UsaHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "UsaHttpError";
  }
}

async function postJsonOnce<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UsaHttpError(
      res.status,
      `USAspending API error (${res.status}): ${text.slice(0, 200) || res.statusText}`,
    );
  }

  return (await res.json()) as T;
}

/** Retry on 429 / 502 / 503 / timeouts. Precalc uses longer backoff. */
async function postJson<T>(url: string, body: unknown, retries = 5): Promise<T> {
  const precalc = process.env.PRECALC === "1";
  const maxRetries = precalc ? 8 : retries;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await usaPostThrottle(() => postJsonOnce<T>(url, body));
    } catch (err) {
      lastErr = err;
      const status = err instanceof UsaHttpError ? err.status : 0;
      const retriable =
        status === 429 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        (err instanceof Error &&
          /timeout|aborted|network|fetch failed/i.test(err.message));
      if (!retriable || attempt === maxRetries) break;
      // 429: long cool-down (USAspending is aggressive under bulk precalc)
      const wait =
        status === 429
          ? Math.min(15_000 * 2 ** attempt, precalc ? 180_000 : 60_000)
          : Math.min(1500 * 2 ** attempt, 20_000);
      console.warn(
        `[usaspending] ${status || "err"} retry ${attempt + 1}/${maxRetries} wait ${Math.round(wait / 1000)}s`,
      );
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface FetchAwardsResult {
  awards: AwardRow[];
  pagesFetched: number;
  fromCache: boolean;
}

export interface FetchTransactionsResult {
  transactions: TransactionRow[];
  pagesFetched: number;
  fromCache: boolean;
}

async function fetchAwardsUncached(
  filters: FacilityFilters,
  maxPages: number,
): Promise<Omit<FetchAwardsResult, "fromCache">> {
  const apiFilters = buildFilters(filters);
  const awards: AwardRow[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= maxPages) {
    const data = await postJson<{
      results?: AwardRow[];
      page_metadata?: { hasNext?: boolean };
    }>(SPENDING_BY_AWARD, {
      filters: apiFilters,
      fields: AWARD_FIELDS,
      limit: PAGE_LIMIT,
      page,
      sort: "Award Amount",
      order: "desc",
      subawards: false,
    });

    const batch = data.results ?? [];
    awards.push(...batch);
    hasNext = Boolean(data.page_metadata?.hasNext) && batch.length > 0;
    page += 1;
  }

  return { awards, pagesFetched: page - 1 };
}

async function fetchTransactionsUncached(
  filters: FacilityFilters,
  maxPages: number,
): Promise<Omit<FetchTransactionsResult, "fromCache">> {
  const apiFilters = buildFilters(filters);
  const transactions: TransactionRow[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= maxPages) {
    const data = await postJson<{
      results?: TransactionRow[];
      page_metadata?: { hasNext?: boolean };
    }>(SPENDING_BY_TRANSACTION, {
      filters: apiFilters,
      fields: TXN_FIELDS,
      limit: PAGE_LIMIT,
      page,
      sort: "Action Date",
      order: "desc",
    });

    const batch = data.results ?? [];
    transactions.push(...batch);
    hasNext = Boolean(data.page_metadata?.hasNext) && batch.length > 0;
    page += 1;
  }

  return { transactions, pagesFetched: page - 1 };
}

/**
 * Drop heavy/unused award fields before Redis/disk so deep precalc stays under
 * Upstash free 10MB request limit.
 */
export function slimAwardsForCache(awards: AwardRow[]): AwardRow[] {
  return awards.map((a) => {
    const loc = a["Recipient Location"];
    const slimLoc =
      loc && typeof loc === "object"
        ? {
            city_name: (loc as { city_name?: string | null }).city_name ?? null,
            county_name:
              (loc as { county_name?: string | null }).county_name ?? null,
            state_code: (loc as { state_code?: string | null }).state_code ?? null,
            state_name: (loc as { state_name?: string | null }).state_name ?? null,
          }
        : loc;
    return {
      "Award ID": a["Award ID"],
      "Recipient Name": a["Recipient Name"],
      recipient_id: a.recipient_id,
      "Award Amount": a["Award Amount"],
      "Recipient Location": slimLoc as AwardRow["Recipient Location"],
      "Award Type": a["Award Type"],
      "CFDA Number": a["CFDA Number"],
      "Recipient UEI": a["Recipient UEI"],
      primary_assistance_listing: a.primary_assistance_listing
        ? {
            cfda_number: a.primary_assistance_listing.cfda_number ?? null,
            cfda_program_title: null,
          }
        : null,
    };
  });
}

export async function fetchAwards(
  filters: FacilityFilters,
  maxPages = MAX_PAGES_SEARCH,
): Promise<FetchAwardsResult> {
  // v5 + slim payload; maxPages in key so broad vs precalc do not collide
  const key = `${cacheKey("awards_v5", filters)}_mp${maxPages}`;
  const cached = await cacheGet<Omit<FetchAwardsResult, "fromCache">>(key);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const raw = await fetchAwardsUncached(filters, maxPages);
  const result = {
    awards: slimAwardsForCache(raw.awards),
    pagesFetched: raw.pagesFetched,
  };
  await cacheSet(key, result);
  return { ...result, fromCache: false };
}

/**
 * Prefer deep precalc award list from Redis; if missing, fetch a smaller live set.
 * Keeps ranking consistent with precalc when warm, avoids 40-page cold HTTP pulls.
 */
export async function fetchAwardsPreferDeep(
  filters: FacilityFilters,
  deepPages: number,
  livePages: number,
): Promise<FetchAwardsResult> {
  const candidates = [
    `${cacheKey("awards_v5", filters)}_mp${deepPages}`,
    `${cacheKey("awards_v5", filters)}_mp${MAX_PAGES_PRECALC}`,
    // legacy keys from before slim payload
    `${cacheKey("awards_v4", filters)}_mp${deepPages}`,
    `${cacheKey("awards_v4", filters)}_mp${MAX_PAGES_PRECALC}`,
  ];
  for (const deepKey of candidates) {
    const deep = await cacheGet<Omit<FetchAwardsResult, "fromCache">>(deepKey);
    if (deep?.awards?.length) {
      return { ...deep, fromCache: true };
    }
  }
  return fetchAwards(filters, livePages);
}

export async function fetchTransactions(
  filters: FacilityFilters,
  maxPages = MAX_PAGES_SEARCH,
): Promise<FetchTransactionsResult> {
  const key = `${cacheKey("txns_v3", filters)}_mp${maxPages}`;
  const cached = await cacheGet<Omit<FetchTransactionsResult, "fromCache">>(key);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const result = await fetchTransactionsUncached(filters, maxPages);
  await cacheSet(key, result);
  return { ...result, fromCache: false };
}

export function amountsFromAwards(awards: AwardRow[]): number[] {
  return awards
    .map((a) => a["Award Amount"])
    .filter(
      (a): a is number => typeof a === "number" && Number.isFinite(a) && a !== 0,
    );
}

export function amountsFromTransactions(txns: TransactionRow[]): number[] {
  return txns
    .map((t) => t["Transaction Amount"])
    .filter(
      (a): a is number => typeof a === "number" && Number.isFinite(a) && a !== 0,
    );
}

export interface CfdaBaseline {
  cfda: string;
  medianAward: number;
  meanAward: number;
  sampleCount: number;
}

/**
 * National sample of award sizes for a CFDA program (cached 24h).
 * This is a fixed program reference distribution, not ranking facilities
 * against other rows in the user's search.
 */
export async function fetchCfdaBaseline(
  cfda: string,
): Promise<CfdaBaseline | null> {
  const code = cfda.trim();
  if (!code) return null;

  const key = `cfda_base_${code.replace(/[^0-9.]/g, "_")}`;
  const cfdaTtl = 24 * 60 * 60 * 1000;
  const cached = await cacheGet<CfdaBaseline>(key, cfdaTtl);
  if (cached) return cached;

  try {
    const amounts: number[] = [];
    for (let page = 1; page <= 2; page++) {
      const data = await postJson<{ results?: AwardRow[] }>(SPENDING_BY_AWARD, {
        filters: {
          award_type_codes: GRANT_TYPE_CODES,
          time_period: [fiscalWindowYears(10)],
          program_numbers: [code],
        },
        fields: ["Award Amount", "CFDA Number"],
        limit: PAGE_LIMIT,
        page,
        sort: "Award Amount",
        order: "desc",
        subawards: false,
      });
      for (const row of data.results ?? []) {
        const a = row["Award Amount"];
        if (typeof a === "number" && Number.isFinite(a) && a > 0) {
          amounts.push(a);
        }
      }
      if ((data.results?.length ?? 0) < PAGE_LIMIT) break;
    }

    if (amounts.length < 5) return null;

    const sorted = [...amounts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianAward =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    const meanAward = amounts.reduce((s, x) => s + x, 0) / amounts.length;

    const baseline: CfdaBaseline = {
      cfda: code,
      medianAward,
      meanAward,
      sampleCount: amounts.length,
    };
    await cacheSet(key, baseline, cfdaTtl);
    return baseline;
  } catch (err) {
    console.warn("[cfda baseline]", code, err);
    return null;
  }
}

export function extractCfdaFromAward(award: AwardRow): string | null {
  const primary = award.primary_assistance_listing?.cfda_number;
  if (primary) return String(primary);
  if (award["CFDA Number"]) return String(award["CFDA Number"]);
  const list = award["Assistance Listings"];
  if (list?.[0]?.cfda_number) return String(list[0].cfda_number);
  return null;
}

function grantsCacheKey(
  kind: "uei" | "name",
  id: string,
  years: number,
  maxPages: number,
): string {
  const pageTag = `y${years}_mp${maxPages}`;
  if (kind === "uei") return `grants_uei_${id}_${pageTag}`;
  const hash = Buffer.from(id.toLowerCase())
    .toString("base64url")
    .slice(0, 48);
  return `grants_name_${hash}_${pageTag}`;
}

function filterAwardsForRecipient(
  batch: AwardRow[],
  uei: string | null,
  name: string | null,
): AwardRow[] {
  if (uei) {
    return batch.filter((row) => {
      const rowUei = row["Recipient UEI"]
        ? String(row["Recipient UEI"]).trim().toUpperCase()
        : "";
      return !rowUei || rowUei === uei;
    });
  }
  if (name) {
    const needle = name.toLowerCase();
    return batch.filter((row) => {
      const rn = (row["Recipient Name"] ?? "").trim().toLowerCase();
      return rn === needle || rn.includes(needle) || needle.includes(rn);
    });
  }
  return batch;
}

/**
 * Paginated grant pull for one search key (UEI or name). Throttled + retried.
 */
async function fetchGrantsBySearchText(
  searchText: string,
  uei: string | null,
  name: string | null,
  years: number,
  maxPages: number,
): Promise<AwardRow[]> {
  const apiFilters: Record<string, unknown> = {
    award_type_codes: GRANT_TYPE_CODES,
    time_period: [fiscalWindowYears(years)],
    recipient_search_text: [searchText],
  };

  const awards: AwardRow[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= maxPages) {
    const data = await recipientThrottle(() =>
      postJson<{
        results?: AwardRow[];
        page_metadata?: { hasNext?: boolean };
      }>(SPENDING_BY_AWARD, {
        filters: apiFilters,
        fields: AWARD_FIELDS,
        limit: PAGE_LIMIT,
        page,
        sort: "Award Amount",
        order: "desc",
        subawards: false,
      }),
    );

    const batch = data.results ?? [];
    awards.push(...filterAwardsForRecipient(batch, uei, name));
    hasNext = Boolean(data.page_metadata?.hasNext) && batch.length > 0;
    page += 1;
  }

  return awards;
}

/**
 * All federal **grants** (types 02–05) for one recipient over the lookback window.
 * Prefer UEI; on empty/error fall back to recipient name. Cached 12h.
 * Live calls are throttled and retried on 429/5xx.
 *
 * maxPages: list path uses MAX_PAGES_PER_RECIPIENT_LIST (fast); deep can use more.
 */
export async function fetchGrantsForRecipient(opts: {
  uei?: string | null;
  name?: string | null;
  yearsBack?: number;
  maxPages?: number;
}): Promise<{ awards: AwardRow[]; fromCache: boolean }> {
  const uei = opts.uei?.trim().toUpperCase() || null;
  const name = opts.name?.trim() || null;
  if (!uei && !name) return { awards: [], fromCache: false };

  const years = opts.yearsBack ?? 10;
  const maxPages = Math.max(
    1,
    Math.min(
      MAX_PAGES_PER_RECIPIENT,
      opts.maxPages ?? MAX_PAGES_PER_RECIPIENT_LIST,
    ),
  );
  const grantsTtl = 12 * 60 * 60 * 1000;

  // Prefer a deeper cached pull if present (higher maxPages) for better counts
  const pageCandidates = [
    maxPages,
    MAX_PAGES_PER_RECIPIENT,
    MAX_PAGES_PER_RECIPIENT_LIST,
  ].filter((v, i, a) => a.indexOf(v) === i);

  if (uei) {
    for (const mp of pageCandidates) {
      const cached = await cacheGet<{ awards: AwardRow[] }>(
        grantsCacheKey("uei", uei, years, mp),
        grantsTtl,
      );
      if (cached?.awards?.length) {
        return { awards: cached.awards, fromCache: true };
      }
    }
  }
  if (name) {
    for (const mp of pageCandidates) {
      const cached = await cacheGet<{ awards: AwardRow[] }>(
        grantsCacheKey("name", name, years, mp),
        grantsTtl,
      );
      if (cached?.awards?.length) {
        return { awards: cached.awards, fromCache: true };
      }
    }
  }

  // 1) Try UEI
  if (uei) {
    try {
      const awards = await fetchGrantsBySearchText(uei, uei, name, years, maxPages);
      if (awards.length > 0) {
        await cacheSet(
          grantsCacheKey("uei", uei, years, maxPages),
          { awards },
          grantsTtl,
        );
        return { awards, fromCache: false };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/429|502|503|504|timeout|fetch failed/i.test(msg)) {
        console.warn("[grantsForRecipient] uei failed", uei, msg.slice(0, 120));
      }
    }
  }

  // 2) Fall back to legal name
  if (name) {
    try {
      const awards = await fetchGrantsBySearchText(name, uei, name, years, maxPages);
      if (awards.length > 0) {
        await cacheSet(
          grantsCacheKey("name", name, years, maxPages),
          { awards },
          grantsTtl,
        );
        if (uei) {
          await cacheSet(
            grantsCacheKey("uei", uei, years, maxPages),
            { awards },
            grantsTtl,
          );
        }
        return { awards, fromCache: false };
      }
      await cacheSet(
        grantsCacheKey("name", name, years, maxPages),
        { awards: [] },
        grantsTtl,
      );
      return { awards: [], fromCache: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        "[grantsForRecipient]",
        uei ?? name,
        msg.includes("fetch failed") ? "fetch failed (retry exhausted)" : msg.slice(0, 120),
      );
      return { awards: [], fromCache: false };
    }
  }

  return { awards: [], fromCache: false };
}

/**
 * Resolve UEI from USAspending recipient profile when award rows lack it
 * (e.g. older cached payloads). Cached 24h.
 */
export async function fetchUeiForRecipientId(
  recipientId: string,
): Promise<string | null> {
  if (!recipientId || recipientId.startsWith("name:")) return null;
  const cacheK = `uei_${recipientId}`;
  const ueiTtl = 24 * 60 * 60 * 1000;
  const cached = await cacheGet<{ uei: string | null }>(cacheK, ueiTtl);
  if (cached) return cached.uei;

  try {
    const res = await fetch(
      `https://api.usaspending.gov/api/v2/recipient/${encodeURIComponent(recipientId)}/`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) {
      await cacheSet(cacheK, { uei: null }, ueiTtl);
      return null;
    }
    const data = (await res.json()) as { uei?: string | null };
    const uei = data.uei ? String(data.uei).trim().toUpperCase() : null;
    await cacheSet(cacheK, { uei }, ueiTtl);
    return uei;
  } catch {
    return null;
  }
}
