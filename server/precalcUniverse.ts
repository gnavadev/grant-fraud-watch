/**
 * Precalc universe: every US state/territory × facility type (not "all").
 * Each job pulls a deep award sample for that filter and scores EVERY recipient
 * in that sample (true fraud-chance ranking within the sample).
 */
import type { FacilityFilters, FacilityTypeKey } from "./types.js";

export interface PrecalcJob {
  state: string;
  type: FacilityTypeKey;
}

/** 50 states + DC + PR (matches app state list). */
export const PRECALC_STATES: string[] = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "PR",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY",
];

/** Types users can pick (exclude "all"). */
export const PRECALC_TYPES: FacilityTypeKey[] = [
  "healthcare",
  "education",
  "daycare",
  "housing",
  "food",
  "other",
];

/** Full cartesian product: state × type. */
export const PRECALC_UNIVERSE: PrecalcJob[] = PRECALC_STATES.flatMap((state) =>
  PRECALC_TYPES.map((type) => ({ state, type })),
);

export function jobToFilters(job: PrecalcJob): FacilityFilters {
  return {
    state: job.state,
    type: job.type,
  };
}

export function totalJobs(jobs = PRECALC_UNIVERSE): number {
  return jobs.length;
}
