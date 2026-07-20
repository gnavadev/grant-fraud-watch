/**
 * Shared universe of filters to precalculate into Redis.
 * Keep modest for free Upstash + USAspending rate limits.
 */
import type { FacilityFilters, FacilityTypeKey } from "./types.js";

export interface PrecalcJob {
  state: string;
  type: FacilityTypeKey;
  /** Pages of facilities to score (20 each by default). */
  pages: number;
}

/** Popular state × type combos (matches warm-cache targets + a few more). */
export const PRECALC_UNIVERSE: PrecalcJob[] = [
  { state: "CA", type: "healthcare", pages: 3 },
  { state: "TX", type: "healthcare", pages: 2 },
  { state: "NY", type: "healthcare", pages: 2 },
  { state: "FL", type: "healthcare", pages: 2 },
  { state: "IL", type: "healthcare", pages: 1 },
  { state: "PA", type: "healthcare", pages: 1 },
  { state: "OH", type: "healthcare", pages: 1 },
  { state: "CA", type: "education", pages: 2 },
  { state: "TX", type: "education", pages: 1 },
  { state: "NY", type: "education", pages: 1 },
  { state: "CA", type: "daycare", pages: 1 },
  { state: "TX", type: "daycare", pages: 1 },
  { state: "NY", type: "housing", pages: 1 },
  { state: "CA", type: "housing", pages: 1 },
  { state: "CA", type: "food", pages: 1 },
];

export function jobToFilters(job: PrecalcJob): FacilityFilters {
  return {
    state: job.state,
    type: job.type,
  };
}

export function totalPagesInUniverse(jobs = PRECALC_UNIVERSE): number {
  return jobs.reduce((s, j) => s + j.pages, 0);
}
