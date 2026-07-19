import type { Facility, SortDir, SortKey, SortSpec } from "../types";

/**
 * Cycle sort for a column:
 * 1st click → asc, 2nd → desc, 3rd → remove.
 * Multiple columns can be active (priority = order clicked).
 */
export function cycleSort(existing: SortSpec[], key: SortKey): SortSpec[] {
  const idx = existing.findIndex((s) => s.key === key);
  if (idx === -1) {
    return [...existing, { key, dir: "asc" }];
  }
  const current = existing[idx];
  if (current.dir === "asc") {
    const next = [...existing];
    next[idx] = { key, dir: "desc" };
    return next;
  }
  // remove
  return existing.filter((_, i) => i !== idx);
}

function compareValues(
  a: string | number | null,
  b: string | number | null,
  dir: SortDir,
): number {
  const aNull = a == null || a === "";
  const bNull = b == null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls last
  if (bNull) return -1;

  let cmp = 0;
  if (typeof a === "number" && typeof b === "number") {
    cmp = a - b;
  } else {
    cmp = String(a).localeCompare(String(b), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  }
  return dir === "asc" ? cmp : -cmp;
}

function fieldValue(
  f: Facility,
  key: SortKey,
): string | number | null {
  switch (key) {
    case "name":
      return f.name;
    case "city":
      return f.city;
    case "county":
      return f.county;
    case "state":
      return f.state;
    case "grantReceived":
      return f.grantReceived;
    case "fraudChance":
      return f.fraudChance;
    default:
      return null;
  }
}

export function multiSortFacilities(
  rows: Facility[],
  sorts: SortSpec[],
): Facility[] {
  if (sorts.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { key, dir } of sorts) {
      const cmp = compareValues(fieldValue(a, key), fieldValue(b, key), dir);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}
