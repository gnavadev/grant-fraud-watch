import type { FacilityTypeKey } from "./types.js";

export interface FacilityTypePreset {
  key: FacilityTypeKey;
  label: string;
  keywords: string[];
}

/** Friendly facility-type presets mapped to USAspending keyword searches. */
export const FACILITY_TYPES: FacilityTypePreset[] = [
  { key: "all", label: "All types", keywords: [] },
  {
    key: "daycare",
    label: "Daycare / Child care",
    keywords: ["child care", "childcare", "daycare", "day care", "head start"],
  },
  {
    key: "healthcare",
    label: "Healthcare",
    keywords: [
      "hospital",
      "clinic",
      "health center",
      "healthcare",
      "community health",
    ],
  },
  {
    key: "education",
    label: "Education",
    keywords: ["school", "education", "university", "college"],
  },
  {
    key: "housing",
    label: "Housing",
    keywords: ["housing", "homeless", "shelter"],
  },
  {
    key: "food",
    label: "Food & Nutrition",
    keywords: ["food bank", "nutrition", "meal program", "WIC"],
  },
  {
    key: "other",
    label: "Other (community services)",
    keywords: ["community services", "nonprofit", "social services"],
  },
];

export function getKeywordsForType(type?: FacilityTypeKey): string[] {
  if (!type || type === "all") return [];
  const preset = FACILITY_TYPES.find((t) => t.key === type);
  return preset?.keywords ?? [];
}

export function isValidFacilityType(value: string): value is FacilityTypeKey {
  return FACILITY_TYPES.some((t) => t.key === value);
}
