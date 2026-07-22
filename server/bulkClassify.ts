/**
 * Assign facility types from recipient name + CFDA (offline bulk path).
 *
 * CFDA prefixes follow Catalog of Federal Domestic Assistance agency numbering
 * (provable public taxonomy), not model invention:
 *   84.xxx Education (ED), 93.xxx HHS, 14.xxx HUD, 10.5xx FNS nutrition, etc.
 * Name keywords are secondary and only expand membership, not scores.
 */
import { FACILITY_TYPES } from "./facilityTypes.js";
import type { FacilityTypeKey } from "./types.js";

/**
 * Prefix match: CFDA "93.600" matches "93." and "93.6".
 * Prefer longer / more specific prefixes first when both match.
 */
const CFDA_PREFIX: Partial<Record<FacilityTypeKey, string[]>> = {
  education: [
    "84.", // Department of Education
  ],
  healthcare: [
    "93.", // HHS (broad; includes many health programs)
    "64.", // VA (health-related assistance often 64.xxx)
  ],
  housing: [
    "14.", // HUD
  ],
  food: [
    "10.55", // FNS child nutrition cluster-ish
    "10.56",
    "10.557", // WIC
    "10.558",
    "10.559",
    "10.565",
    "10.568",
    "10.569",
    "10.561", // SNAP admin etc.
    "10.551",
  ],
  daycare: [
    "93.575", // CCDF
    "93.596",
    "93.600", // Head Start
    "93.708",
    "93.709",
  ],
  other: [
    "16.", // DOJ
    "17.", // DOL
    "15.", // Interior
    "11.", // Commerce
    "97.", // DHS (mixed)
  ],
};

function cfdaMatchesPrefix(cfda: string, prefix: string): boolean {
  const c = cfda.trim();
  if (!c || c === "null") return false;
  if (c === prefix || c.startsWith(prefix)) return true;
  // "93.6" should match "93.600"
  if (!prefix.endsWith(".") && c.startsWith(prefix)) return true;
  return false;
}

export function classifyFacilityTypes(
  recipientName: string,
  cfdaNumbers: string[],
): FacilityTypeKey[] {
  const name = (recipientName ?? "").toLowerCase();
  const cfdas = cfdaNumbers.map((c) => String(c ?? "").trim()).filter(Boolean);
  const hits = new Set<FacilityTypeKey>();

  // Prefer specific types before "other"
  const order: FacilityTypeKey[] = [
    "daycare",
    "healthcare",
    "education",
    "housing",
    "food",
    "other",
  ];

  for (const key of order) {
    const preset = FACILITY_TYPES.find((t) => t.key === key);
    if (!preset) continue;
    const kw = preset.keywords.some((k) => name.includes(k.toLowerCase()));
    if (kw) hits.add(key);
    const prefixes = CFDA_PREFIX[key] ?? [];
    if (prefixes.some((p) => cfdas.some((c) => cfdaMatchesPrefix(c, p)))) {
      hits.add(key);
    }
  }

  // If only matched "other" via CFDA and also matched a specific type, drop other
  if (hits.size > 1 && hits.has("other")) {
    const specific = [...hits].filter((k) => k !== "other");
    if (specific.length) hits.delete("other");
  }

  if (hits.size === 0) hits.add("other");
  return [...hits];
}
