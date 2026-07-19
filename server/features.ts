import { expectedBenfordProb, leadingDigit } from "./benford.js";
import type { AmountFeatures } from "./types.js";

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Structural features from a list of monetary amounts.
 * Used by XGBoost when Benford sample size is weak.
 */
export function extractAmountFeatures(rawAmounts: number[]): AmountFeatures {
  const amounts = rawAmounts.filter((a) => Number.isFinite(a) && a !== 0);
  const abs = amounts.map((a) => Math.abs(a));
  const n = abs.length;

  if (n === 0) {
    return {
      n: 0,
      sum: 0,
      mean: 0,
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
  }

  const sum = abs.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance =
    abs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(n - 1, 1);
  const std = Math.sqrt(variance);
  const sorted = [...abs].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const cv = mean > 0 ? std / mean : 0;
  const maxToMean = mean > 0 ? max / mean : 0;

  let roundCount = 0;
  for (const v of abs) {
    // "Round" if divisible by 1000 or ends in many zeros relatively
    if (v >= 1000 && v % 1000 === 0) roundCount += 1;
  }
  const pctRound = roundCount / n;
  const pctNegative =
    amounts.filter((a) => a < 0).length / Math.max(amounts.length, 1);

  // Leading-digit distribution features
  const digitCounts = Array.from({ length: 9 }, () => 0);
  for (const v of abs) {
    const d = leadingDigit(v);
    if (d) digitCounts[d - 1] += 1;
  }
  let digitEntropy = 0;
  let benfordMad = 0;
  let benfordChi = 0;
  for (let i = 0; i < 9; i++) {
    const p = digitCounts[i] / n;
    if (p > 0) digitEntropy -= p * Math.log2(p);
    const expected = expectedBenfordProb(i + 1);
    benfordMad += Math.abs(p - expected);
    const e = n * expected;
    if (e > 0) benfordChi += (digitCounts[i] - e) ** 2 / e;
  }
  benfordMad /= 9;

  return {
    n,
    sum,
    mean,
    std,
    median: median(sorted),
    min,
    max,
    cv,
    maxToMean,
    pctRound,
    pctNegative,
    logSum: Math.log10(sum + 1),
    logMean: Math.log10(mean + 1),
    digitEntropy,
    benfordMad,
    benfordChi,
  };
}

export const FEATURE_KEYS: (keyof AmountFeatures)[] = [
  "n",
  "sum",
  "mean",
  "std",
  "median",
  "min",
  "max",
  "cv",
  "maxToMean",
  "pctRound",
  "pctNegative",
  "logSum",
  "logMean",
  "digitEntropy",
  "benfordMad",
  "benfordChi",
];

export function featuresToVector(f: AmountFeatures): number[] {
  return FEATURE_KEYS.map((k) => f[k]);
}
