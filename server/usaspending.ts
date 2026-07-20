import { cacheGet, cacheKey, cacheSet } from "./cache.js";
import { getKeywordsForType } from "./facilityTypes.js";
import { createThrottle, sleep } from "./throttle.js";
import type {
  AwardRow,
  FacilityFilters,
  TransactionRow,
} from "./types.js";

/** Space out recipient-level grant pulls so USAspending is less likely to 429. */
const recipientThrottle = createThrottle(280);

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
/** Deeper default pulls for better Benford samples. */
const MAX_PAGES_SEARCH = 8; // up to 800 awards / transactions

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

/** Retry on 429 / 502 / 503 / timeouts. */
async function postJson<T>(url: string, body: unknown, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await postJsonOnce<T>(url, body);
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
      if (!retriable || attempt === retries) break;
      const wait = Math.min(1500 * 2 ** attempt, 12_000);
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

export async function fetchAwards(
  filters: FacilityFilters,
  maxPages = MAX_PAGES_SEARCH,
): Promise<FetchAwardsResult> {
  // v3 includes Recipient UEI for FAC/SAM enrichment + deep-dive links
  const key = cacheKey("awards_v3", filters);
  const cached = await cacheGet<Omit<FetchAwardsResult, "fromCache">>(key);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const result = await fetchAwardsUncached(filters, maxPages);
  await cacheSet(key, result);
  return { ...result, fromCache: false };
}

export async function fetchTransactions(
  filters: FacilityFilters,
  maxPages = MAX_PAGES_SEARCH,
): Promise<FetchTransactionsResult> {
  const key = cacheKey("txns_v2", filters);
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

const MAX_PAGES_PER_RECIPIENT = 20; // up to 2000 grants / recipient safety cap

function grantsCacheKey(
  kind: "uei" | "name",
  id: string,
  years: number,
): string {
  if (kind === "uei") return `grants_uei_${id}_y${years}`;
  const hash = Buffer.from(id.toLowerCase())
    .toString("base64url")
    .slice(0, 48);
  return `grants_name_${hash}_y${years}`;
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
): Promise<AwardRow[]> {
  const apiFilters: Record<string, unknown> = {
    award_type_codes: GRANT_TYPE_CODES,
    time_period: [fiscalWindowYears(years)],
    recipient_search_text: [searchText],
  };

  const awards: AwardRow[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= MAX_PAGES_PER_RECIPIENT) {
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
 */
export async function fetchGrantsForRecipient(opts: {
  uei?: string | null;
  name?: string | null;
  yearsBack?: number;
}): Promise<{ awards: AwardRow[]; fromCache: boolean }> {
  const uei = opts.uei?.trim().toUpperCase() || null;
  const name = opts.name?.trim() || null;
  if (!uei && !name) return { awards: [], fromCache: false };

  const years = opts.yearsBack ?? 10;
  const grantsTtl = 12 * 60 * 60 * 1000;

  // Check caches (UEI preferred key, then name)
  if (uei) {
    const cached = await cacheGet<{ awards: AwardRow[] }>(
      grantsCacheKey("uei", uei, years),
      grantsTtl,
    );
    if (cached?.awards?.length) {
      return { awards: cached.awards, fromCache: true };
    }
  }
  if (name) {
    const cached = await cacheGet<{ awards: AwardRow[] }>(
      grantsCacheKey("name", name, years),
      grantsTtl,
    );
    if (cached?.awards?.length) {
      return { awards: cached.awards, fromCache: true };
    }
  }

  // 1) Try UEI
  if (uei) {
    try {
      const awards = await fetchGrantsBySearchText(uei, uei, name, years);
      if (awards.length > 0) {
        await cacheSet(grantsCacheKey("uei", uei, years), { awards }, grantsTtl);
        return { awards, fromCache: false };
      }
      // empty is valid but uncommon, fall through to name
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only log briefly; name fallback often succeeds
      if (!/429|502|503|504|timeout|fetch failed/i.test(msg)) {
        console.warn("[grantsForRecipient] uei failed", uei, msg.slice(0, 120));
      }
    }
  }

  // 2) Fall back to legal name
  if (name) {
    try {
      const awards = await fetchGrantsBySearchText(name, uei, name, years);
      if (awards.length > 0) {
        await cacheSet(grantsCacheKey("name", name, years), { awards }, grantsTtl);
        if (uei) {
          // Also store under UEI so later lookups hit cache
          await cacheSet(grantsCacheKey("uei", uei, years), { awards }, grantsTtl);
        }
        return { awards, fromCache: false };
      }
      // Cache empty success so we don't hammer the same miss
      await cacheSet(grantsCacheKey("name", name, years), { awards: [] }, grantsTtl);
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
