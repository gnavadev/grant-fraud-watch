/**
 * Assign facility types from recipient name + CFDA (offline bulk path).
 */
import { FACILITY_TYPES } from "./facilityTypes.js";
import type { FacilityTypeKey } from "./types.js";

/** CFDA program prefixes commonly tied to facility types. */
const CFDA_PREFIX: Partial<Record<FacilityTypeKey, string[]>> = {
  education: ["84."],
  healthcare: ["93."],
  housing: ["14."],
  food: ["10.55", "10.56", "10.557", "10.558", "10.559", "10.565", "10.568", "10.569"],
  daycare: ["93.6"], // rough: child care / Head Start family
};

export function classifyFacilityTypes(
  recipientName: string,
  cfdaNumbers: string[],
): FacilityTypeKey[] {
  const name = (recipientName ?? "").toLowerCase();
  const cfdas = cfdaNumbers.map((c) => String(c ?? "").trim());
  const hits = new Set<FacilityTypeKey>();

  for (const preset of FACILITY_TYPES) {
    if (preset.key === "all") continue;
    const kw = preset.keywords.some((k) => name.includes(k.toLowerCase()));
    if (kw) hits.add(preset.key);
    const prefixes = CFDA_PREFIX[preset.key] ?? [];
    if (
      prefixes.some((p) =>
        cfdas.some((c) => c === p || c.startsWith(p) || c.startsWith(p.replace(/\.$/, ""))),
      )
    ) {
      hits.add(preset.key);
    }
  }

  if (hits.size === 0) hits.add("other");
  return [...hits];
}
