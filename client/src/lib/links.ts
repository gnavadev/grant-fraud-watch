import type { Facility } from "../types";

export interface FacilityLink {
  label: string;
  href: string | null;
  description: string;
  /** false = show grayed-out, not clickable (no real target for this facility). */
  available: boolean;
}

/**
 * USAspending profile IDs are internal hashes ending in -C (child) or -R (recipient),
 * e.g. 4e05ba89-8df7-4eeb-0f35-e5b880ee03e4-C.
 * They are NOT `${UEI}-R` — that form always 404s as "Invalid Recipient".
 */
export function isUsaspendingRecipientHash(id: string | null | undefined): boolean {
  const s = (id ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[CR]$/i.test(
    s,
  );
}

/** Official links aimed at this specific facility (UEI / recipient id when known). */
export function facilityLinks(f: Facility): FacilityLink[] {
  const links: FacilityLink[] = [];
  const nameQ = encodeURIComponent(f.name);
  const uei = f.uei?.trim().toUpperCase();
  const recipientId = f.recipientId?.trim() || null;
  const facFound = Boolean(f.enrichment?.fac?.found && f.enrichment.fac.reportId);
  const reportId = f.enrichment?.fac?.reportId?.trim() || null;
  const samFound = Boolean(f.enrichment?.sam?.found);

  // USAspending: only use /recipient/{id}/ when id is a real hash (-C/-R).
  // Bulk ranking stores UEI only (no archive hash) → keyword search by UEI.
  if (isUsaspendingRecipientHash(recipientId)) {
    links.push({
      label: "USAspending facility profile",
      href: `https://www.usaspending.gov/recipient/${encodeURIComponent(recipientId!)}/latest`,
      description: "Federal awards for this recipient",
      available: true,
    });
  } else if (uei) {
    links.push({
      label: "USAspending search (UEI)",
      href: `https://www.usaspending.gov/search/?hash=false&keyword=${encodeURIComponent(uei)}`,
      description: `Search federal awards for UEI ${uei}`,
      available: true,
    });
  } else {
    links.push({
      label: "USAspending search (this name)",
      href: `https://www.usaspending.gov/search/?hash=false&keyword=${nameQ}`,
      description: "Search federal spending for this exact name",
      available: true,
    });
  }

  // SAM.gov — only when bulk/extract expects a public hit (active reg or exclusion).
  // Entity coreData deep links 404 for most public users; search by UEI only.
  const samExcluded = Boolean(f.enrichment?.sam?.excluded);
  if (uei && samFound) {
    if (samExcluded) {
      links.push({
        label: "SAM.gov exclusions search (UEI)",
        href: `https://sam.gov/search/?index=ex&page=1&pageSize=25&sfm[simpleSearch][keywordRadio]=ALL&sfm[simpleSearch][keywordTags][0][key]=${encodeURIComponent(uei)}&sfm[simpleSearch][keywordTags][0][value]=${encodeURIComponent(uei)}`,
        description: `Public exclusion list search for UEI ${uei}`,
        available: true,
      });
    }
    links.push({
      label: "SAM.gov entity search (UEI)",
      href: `https://sam.gov/search/?index=ei&page=1&pageSize=25&sort=-relevance&sfm[simpleSearch][keywordRadio]=ALL&sfm[simpleSearch][keywordTags][0][key]=${encodeURIComponent(uei)}&sfm[simpleSearch][keywordTags][0][value]=${encodeURIComponent(uei)}`,
      description: `Registration / exclusions for UEI ${uei}`,
      available: true,
    });
  } else if (uei) {
    links.push({
      label: "SAM.gov entity",
      href: null,
      description:
        "Not available: no currently active public registration in our SAM extract (expired, opted out of public display, or not registered)",
      available: false,
    });
  } else {
    links.push({
      label: "SAM.gov search (this name)",
      href: `https://sam.gov/search/?index=ei&page=1&pageSize=25&sort=-relevance&sfm[simpleSearch][keywordRadio]=ALL&sfm[simpleSearch][keywordTags][0][key]=${nameQ}&sfm[simpleSearch][keywordTags][0][value]=${nameQ}`,
      description: "Search registration by facility name",
      available: true,
    });
  }

  // FAC, only real deep links via report_id. Search page query params do not work.
  if (facFound && reportId) {
    links.push({
      label: "FAC Single Audit summary",
      href: `https://app.fac.gov/dissemination/summary/${encodeURIComponent(reportId)}`,
      description: uei
        ? `Official audit summary for UEI ${uei}`
        : "Official Single Audit summary for this facility",
      available: true,
    });
    links.push({
      label: "FAC audit report (PDF)",
      href: `https://app.fac.gov/dissemination/report/pdf/${encodeURIComponent(reportId)}`,
      description: "Download the Single Audit PDF",
      available: true,
    });
  } else {
    links.push({
      label: "FAC Single Audit",
      href: null,
      description:
        "Not available, no Single Audit on file for this facility in FAC",
      available: false,
    });
  }

  // Federal program / CFDA SAM FAL URLs are unreliable (often client-side 404), omitted.

  return links;
}
