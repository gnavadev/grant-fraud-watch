import { cacheGet, cacheKey, cacheSet } from "./cache.js";
import type { FacilityFilters } from "./types.js";
import { buildFilters } from "./usaspending.js";

const SPENDING_BY_AWARD =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";

export interface SubawardRow {
  "Sub-Award Amount"?: number | null;
  "Sub-Awardee Name"?: string | null;
  "Sub-Award Date"?: string | null;
  "Prime Award ID"?: string | null;
  "Prime Recipient Name"?: string | null;
  "Sub-Recipient UEI"?: string | null;
  prime_award_recipient_id?: string | null;
}

export interface SubawardConcentration {
  primeRecipientId: string;
  subCount: number;
  uniqueSubs: number;
  totalSubAmount: number;
  topSubShare: number;
  /** 0–100: high pass-through concentration / single-sub dominance. */
  riskScore: number;
}

/**
 * Fetch subawards for the same search filters (pass-through patterns).
 */
export async function fetchSubawards(
  filters: FacilityFilters,
  maxPages = 4,
): Promise<{ rows: SubawardRow[]; fromCache: boolean }> {
  const key = cacheKey("subawards_v1", filters);
  const cached = await cacheGet<{ rows: SubawardRow[] }>(key);
  if (cached) return { rows: cached.rows, fromCache: true };

  const apiFilters = buildFilters(filters);
  const rows: SubawardRow[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= maxPages) {
    const res = await fetch(SPENDING_BY_AWARD, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        filters: apiFilters,
        fields: [
          "Sub-Award Amount",
          "Sub-Awardee Name",
          "Sub-Award Date",
          "Prime Award ID",
          "Prime Recipient Name",
          "Sub-Recipient UEI",
          "prime_award_recipient_id",
        ],
        limit: 100,
        page,
        sort: "Sub-Award Amount",
        order: "desc",
        subawards: true,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Subaward API ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: SubawardRow[];
      page_metadata?: { hasNext?: boolean };
    };
    const batch = data.results ?? [];
    rows.push(...batch);
    hasNext = Boolean(data.page_metadata?.hasNext) && batch.length > 0;
    page += 1;
  }

  await cacheSet(key, { rows });
  return { rows, fromCache: false };
}

/**
 * Concentration of subawards under each prime recipient id.
 */
export function subawardConcentrationByPrime(
  rows: SubawardRow[],
): Map<string, SubawardConcentration> {
  const map = new Map<
    string,
    { amounts: number[]; names: Set<string> }
  >();

  for (const r of rows) {
    const prime = r.prime_award_recipient_id;
    if (!prime) continue;
    const amt = r["Sub-Award Amount"];
    if (typeof amt !== "number" || !Number.isFinite(amt) || amt <= 0) continue;
    let g = map.get(prime);
    if (!g) {
      g = { amounts: [], names: new Set() };
      map.set(prime, g);
    }
    g.amounts.push(amt);
    const name = (r["Sub-Awardee Name"] ?? r["Sub-Recipient UEI"] ?? "").trim();
    if (name) g.names.add(name.toLowerCase());
  }

  const out = new Map<string, SubawardConcentration>();
  for (const [prime, g] of map) {
    const total = g.amounts.reduce((a, b) => a + b, 0);
    const max = Math.max(...g.amounts);
    const topShare = total > 0 ? max / total : 0;
    const uniqueSubs = g.names.size;
    const subCount = g.amounts.length;

    let risk = 0;
    // Single sub takes almost everything
    if (topShare >= 0.9 && subCount >= 2) risk = Math.max(risk, 75);
    else if (topShare >= 0.75) risk = Math.max(risk, 55);
    else if (topShare >= 0.6) risk = Math.max(risk, 35);

    // Very few unique subrecipients with many sub-awards
    if (uniqueSubs === 1 && subCount >= 3) risk = Math.max(risk, 70);
    if (uniqueSubs <= 2 && subCount >= 8) risk = Math.max(risk, 50);

    out.set(prime, {
      primeRecipientId: prime,
      subCount,
      uniqueSubs,
      totalSubAmount: total,
      topSubShare: topShare,
      riskScore: Math.min(100, risk),
    });
  }
  return out;
}
