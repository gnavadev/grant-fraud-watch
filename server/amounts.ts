/**
 * Clean monetary amounts for scoring:
 * - drop non-finite / zero
 * - use absolute values (de-obligations still carry digit info)
 * - light de-dupe of exact consecutive duplicates (mod noise)
 */
export function cleanAmountsForScoring(raw: number[]): number[] {
  const cleaned: number[] = [];
  let prev: number | null = null;

  for (const a of raw) {
    if (typeof a !== "number" || !Number.isFinite(a) || a === 0) continue;
    const abs = Math.abs(a);
    // Skip exact consecutive duplicates (common with repeated mod postings)
    if (prev !== null && abs === prev) continue;
    cleaned.push(abs);
    prev = abs;
  }

  return cleaned;
}

/** Positive amounts only (for grant totals). */
export function positiveAmounts(raw: number[]): number[] {
  return raw.filter((a) => typeof a === "number" && Number.isFinite(a) && a > 0);
}

/**
 * Concentration: share of total held by the single largest amount (0–1).
 */
export function concentrationRatio(amounts: number[]): number {
  const pos = positiveAmounts(amounts);
  if (pos.length === 0) return 0;
  const sum = pos.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  const max = Math.max(...pos);
  return max / sum;
}

/**
 * Last-digit bias: chi-square vs uniform 0–9, mapped loosely to 0–100.
 * Fabricated numbers sometimes overuse 0/5.
 */
export function lastDigitBiasScore(amounts: number[]): number {
  const digits = Array.from({ length: 10 }, () => 0);
  let n = 0;
  for (const a of amounts) {
    if (!Number.isFinite(a) || a === 0) continue;
    const last = Math.floor(Math.abs(a)) % 10;
    digits[last] += 1;
    n += 1;
  }
  if (n < 5) return 0;

  const expected = n / 10;
  let chi = 0;
  for (let d = 0; d < 10; d++) {
    chi += (digits[d] - expected) ** 2 / expected;
  }
  // df=9 critical ~16.9 at p=0.05
  const score = 100 * (1 - Math.exp(-chi / 25));
  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Round-number score: share of amounts divisible by 1000, curved to 0–100.
 */
export function roundnessScore(amounts: number[]): number {
  const abs = amounts
    .filter((a) => Number.isFinite(a) && a !== 0)
    .map((a) => Math.abs(a));
  if (abs.length === 0) return 0;
  let round = 0;
  for (const v of abs) {
    if (v >= 1000 && v % 1000 === 0) round += 1;
  }
  const pct = round / abs.length;
  // Natural data has some round numbers; ramp after 20%
  const adjusted = Math.max(0, (pct - 0.15) / 0.85);
  return Math.round(Math.min(100, adjusted * 100));
}
