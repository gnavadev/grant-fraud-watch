import { cacheGet, cacheKey, cacheSet } from "./cache.js";
import { getKeywordsForType } from "./facilityTypes.js";
import type {
  AwardRow,
  FacilityFilters,
  TransactionRow,
} from "./types.js";

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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `USAspending API error (${res.status}): ${text.slice(0, 300) || res.statusText}`,
    );
  }

  return (await res.json()) as T;
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
 * This is a fixed program reference distribution — not ranking facilities
 * against other rows in the user's search.
 */
export async function fetchCfdaBaseline(
  cfda: string,
): Promise<CfdaBaseline | null> {
  const code = cfda.trim();
  if (!code) return null;

  const key = `cfda_base_${code.replace(/[^0-9.]/g, "_")}`;
  const cached = await cacheGet<CfdaBaseline>(key, 24 * 60 * 60 * 1000);
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
    await cacheSet(key, baseline);
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

/**
 * Resolve UEI from USAspending recipient profile when award rows lack it
 * (e.g. older cached payloads). Cached 24h.
 */
export async function fetchUeiForRecipientId(
  recipientId: string,
): Promise<string | null> {
  if (!recipientId || recipientId.startsWith("name:")) return null;
  const cacheK = `uei_${recipientId}`;
  const cached = await cacheGet<{ uei: string | null }>(
    cacheK,
    24 * 60 * 60 * 1000,
  );
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
      await cacheSet(cacheK, { uei: null });
      return null;
    }
    const data = (await res.json()) as { uei?: string | null };
    const uei = data.uei ? String(data.uei).trim().toUpperCase() : null;
    await cacheSet(cacheK, { uei });
    return uei;
  } catch {
    return null;
  }
}
