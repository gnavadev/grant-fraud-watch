import type { ParsedLocation } from "./types.js";

const STATE_ABBREV = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

/** Structured location object returned by spending_by_award. */
export interface LocationObject {
  location_country_code?: string | null;
  country_name?: string | null;
  state_code?: string | null;
  state_name?: string | null;
  city_name?: string | null;
  county_code?: string | null;
  county_name?: string | null;
  address_line1?: string | null;
  zip5?: string | null;
  congressional_code?: string | null;
}

export type LocationInput = string | LocationObject | null | undefined;

/**
 * Parse USAspending location (object or legacy string) into city / county / state.
 */
export function parseLocation(value: LocationInput): ParsedLocation {
  if (value == null) {
    return { city: null, county: null, state: null };
  }

  if (typeof value === "object") {
    return parseLocationObject(value);
  }

  if (typeof value === "string") {
    return parseLocationString(value);
  }

  return { city: null, county: null, state: null };
}

function parseLocationObject(loc: LocationObject): ParsedLocation {
  const stateRaw = (loc.state_code ?? "").toString().trim().toUpperCase();
  const state = STATE_ABBREV.has(stateRaw) ? stateRaw : null;

  const city = loc.city_name ? titleCase(String(loc.city_name)) : null;
  const county = loc.county_name
    ? normalizeCounty(String(loc.county_name))
    : null;

  return { city, county, state };
}

/**
 * Parse legacy string formats, e.g. "HOUSTON, HARRIS, TX".
 */
export function parseLocationString(
  value: string | null | undefined,
): ParsedLocation {
  if (!value || typeof value !== "string" || !value.trim()) {
    return { city: null, county: null, state: null };
  }

  const raw = value.trim();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { city: null, county: null, state: null };
  }

  let state: string | null = null;
  let stateIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const token = parts[i].replace(/\./g, "").toUpperCase();
    const maybeState = token.split(/\s+/)[0];
    if (STATE_ABBREV.has(maybeState)) {
      state = maybeState;
      stateIdx = i;
      break;
    }
  }

  if (stateIdx === 0) {
    return { city: null, county: null, state };
  }

  if (stateIdx === 1) {
    return { city: titleCase(parts[0]), county: null, state };
  }

  if (stateIdx >= 2) {
    const city = titleCase(parts[0]);
    const county = normalizeCounty(parts[stateIdx - 1]);
    return { city, county, state };
  }

  if (parts.length === 1) {
    const only = parts[0].toUpperCase();
    if (STATE_ABBREV.has(only)) {
      return { city: null, county: null, state: only };
    }
    return { city: titleCase(parts[0]), county: null, state: null };
  }

  return {
    city: titleCase(parts[0]),
    county: parts.length > 1 ? normalizeCounty(parts[1]) : null,
    state: null,
  };
}

function normalizeCounty(value: string): string | null {
  let c = titleCase(value);
  c = c.replace(/\s+County$/i, "").trim();
  return c || null;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function preferLocation(
  primary: ParsedLocation,
  fallback: ParsedLocation,
): ParsedLocation {
  return {
    city: primary.city || fallback.city,
    county: primary.county || fallback.county,
    state: primary.state || fallback.state,
  };
}
