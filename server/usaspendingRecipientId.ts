/**
 * Deterministic USAspending recipient profile id from UEI (no HTTP).
 *
 * USAspending builds the base id as UUID(md5("UEI-{UEI}")) (all upper case),
 * then appends a level suffix: -C child, -R recipient, -P parent.
 *
 * Example:
 *   CF2QLVHJTBD7 → 4e05ba89-8df7-4eeb-0f35-e5b880ee03e4-C
 */
import { createHash } from "node:crypto";

export type RecipientLevel = "C" | "R" | "P";

/** MD5 → UUID string (8-4-4-4-12), matching Python uuid.UUID(md5.hexdigest()). */
export function usaspendingRecipientHashFromUei(uei: string): string | null {
  const clean = uei.trim().toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(clean)) return null;
  const hex = createHash("md5")
    .update(`uei-${clean}`.toUpperCase(), "utf8")
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Full profile id for /recipient/{id}/latest.
 * Default -C (child) matches award-level links for most grant UEIs.
 */
export function usaspendingRecipientIdFromUei(
  uei: string,
  level: RecipientLevel = "C",
): string | null {
  const base = usaspendingRecipientHashFromUei(uei);
  if (!base) return null;
  return `${base}-${level}`;
}
