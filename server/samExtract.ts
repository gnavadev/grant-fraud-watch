import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { getSamApiKey } from "./env.js";
import { log } from "./logger.js";
import {
  bundledExclusionsPath,
  cacheExclusionsJsonPath,
  cacheSamDir,
} from "./samDataPaths.js";

export const SAM_CACHE_DIR = cacheSamDir();
const EXCLUSIONS_FILE = cacheExclusionsJsonPath();

/** Refresh exclusions extract at most once per day (local). */
const EXCLUSIONS_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExclusionsIndex {
  downloadedAt: number;
  source: string;
  count: number;
  /** Uppercase UEIs present on the public exclusions list. */
  ueis: string[];
}

let memorySet: Set<string> | null = null;
let memoryMeta: { downloadedAt: number; source: string } | null = null;
let loadPromise: Promise<void> | null = null;

function isUei(s: string): boolean {
  return /^[A-Z0-9]{12}$/.test(s);
}

/**
 * Minimal CSV line split that respects double quotes.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseExclusionUeisFromCsv(text: string): Set<string> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return new Set();

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  let ueiIdx = header.findIndex(
    (h) =>
      h === "unique entity id" ||
      h === "uei" ||
      h.includes("unique entity") ||
      h === "uei sam",
  );

  const set = new Set<string>();
  const scanAll = ueiIdx < 0;

  for (let li = 1; li < lines.length; li++) {
    const cols = splitCsvLine(lines[li]);
    if (!scanAll && ueiIdx >= 0) {
      const raw = (cols[ueiIdx] ?? "").trim().toUpperCase();
      if (isUei(raw)) set.add(raw);
      continue;
    }
    for (const c of cols) {
      const raw = c.trim().toUpperCase();
      if (isUei(raw)) set.add(raw);
    }
  }

  return set;
}

async function saveIndex(index: ExclusionsIndex): Promise<void> {
  await fs.mkdir(SAM_CACHE_DIR, { recursive: true });
  await fs.writeFile(EXCLUSIONS_FILE, JSON.stringify(index), "utf8");
  memorySet = new Set(index.ueis);
  memoryMeta = { downloadedAt: index.downloadedAt, source: index.source };
}

/** Load slim UEI list committed under data/sam/ (prod default). */
async function loadBundledExclusions(): Promise<boolean> {
  try {
    const raw = await fs.readFile(bundledExclusionsPath(), "utf8");
    const ueis = raw
      .split(/\r?\n/)
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l && !l.startsWith("#") && isUei(l));
    if (ueis.length === 0) return false;
    memorySet = new Set(ueis);
    memoryMeta = {
      downloadedAt: Date.now(),
      source: "data/sam/exclusions_ueis.txt",
    };
    log.info("sam_exclusions_bundled", { count: ueis.length });
    return true;
  } catch {
    return false;
  }
}

async function loadIndexFromDisk(): Promise<boolean> {
  try {
    const raw = await fs.readFile(EXCLUSIONS_FILE, "utf8");
    const index = JSON.parse(raw) as ExclusionsIndex;
    if (!index?.ueis || !Array.isArray(index.ueis) || !index.downloadedAt) {
      return false;
    }
    memorySet = new Set(index.ueis);
    memoryMeta = { downloadedAt: index.downloadedAt, source: index.source };
    // Fresh?
    return Date.now() - index.downloadedAt <= EXCLUSIONS_TTL_MS;
  } catch {
    return false;
  }
}

async function indexFromBuffer(
  buf: Buffer,
  sourceHint: string,
): Promise<ExclusionsIndex | null> {
  let csvText = "";
  let source = sourceHint;

  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    const csvName =
      names.find((n) => /\.csv$/i.test(n) && !zip.files[n].dir) ??
      names.find((n) => !zip.files[n].dir);
    if (!csvName) {
      log.warn("sam_extract_no_csv_in_zip", { names: names.slice(0, 10) });
      return null;
    }
    source = csvName;
    csvText = await zip.files[csvName].async("string");
  } else {
    csvText = buf.toString("utf8");
  }

  const set = parseExclusionUeisFromCsv(csvText);
  const index: ExclusionsIndex = {
    downloadedAt: Date.now(),
    source,
    count: set.size,
    ueis: [...set],
  };
  await saveIndex(index);
  log.info("sam_extract_ready", {
    source,
    ueiCount: index.count,
    bytes: buf.length,
  });
  return index;
}

/**
 * Optional offline bootstrap: drop a ZIP/CSV at
 *   .cache/sam/exclusions_manual.zip  or  exclusions_manual.csv
 */
async function tryManualExclusionsFile(): Promise<ExclusionsIndex | null> {
  const candidates = [
    path.join(SAM_CACHE_DIR, "exclusions_manual.zip"),
    path.join(SAM_CACHE_DIR, "exclusions_manual.csv"),
  ];
  for (const file of candidates) {
    try {
      const buf = await fs.readFile(file);
      log.info("sam_extract_manual_file", { file });
      return await indexFromBuffer(buf, path.basename(file));
    } catch {
      /* next */
    }
  }
  return null;
}

async function downloadExclusionsExtract(): Promise<ExclusionsIndex | null> {
  const apiKey = getSamApiKey();
  if (!apiKey) {
    log.warn("sam_extract_no_key");
    return tryManualExclusionsFile();
  }

  // Public exclusions: most recent file (daily extract in production calendar)
  // Also works with frequency=MONTHLY if you pass date=MM/YYYY — we use latest.
  const url =
    `https://api.sam.gov/data-services/v1/extracts` +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&fileType=EXCLUSION` +
    `&sensitivity=PUBLIC`;

  log.info("sam_extract_download_start", { fileType: "EXCLUSION" });

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/zip, application/octet-stream, */*" },
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn("sam_extract_download_failed", {
        status: res.status,
        body: text.slice(0, 200),
      });
      const manual = await tryManualExclusionsFile();
      if (manual) return manual;
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return await indexFromBuffer(buf, "EXCLUSION");
  } catch (err) {
    log.warn("sam_extract_download_error", { err });
    return tryManualExclusionsFile();
  }
}

/**
 * Ensure exclusions UEI set is in memory (download at most ~1×/day).
 *
 * Load order:
 *  1) Fresh .cache JSON
 *  2) If CI / SAM_FORCE_DOWNLOAD=1 → hit SAM API (do not treat empty data/ as success)
 *  3) Bundled data/sam/exclusions_ueis.txt (must contain real UEIs)
 *  4) Stale cache
 *  5) Download (unless SAM_DOWNLOAD_EXTRACTS=0)
 */
export async function ensureSamExclusionsIndex(): Promise<{
  ok: boolean;
  count: number;
  fromCache: boolean;
  ageHours: number | null;
  error?: string;
}> {
  if (memorySet && memoryMeta && memorySet.size > 0) {
    const age = Date.now() - memoryMeta.downloadedAt;
    if (age <= EXCLUSIONS_TTL_MS) {
      return {
        ok: true,
        count: memorySet.size,
        fromCache: true,
        ageHours: Math.round((age / 3600000) * 10) / 10,
      };
    }
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      const forceDownload =
        process.env.CI === "true" ||
        process.env.SAM_FORCE_DOWNLOAD === "1" ||
        process.env.SAM_FORCE_DOWNLOAD === "true";

      const hasKey = Boolean(getSamApiKey());
      log.info("sam_exclusions_ensure", {
        hasKey,
        forceDownload,
        downloadDisabled: process.env.SAM_DOWNLOAD_EXTRACTS === "0",
      });

      // 1) Fresh runtime cache with data
      const fresh = await loadIndexFromDisk();
      if (fresh && memorySet && memorySet.size > 0) return;

      // 2) CI / force: download first (empty bundle must not short-circuit)
      if (
        forceDownload &&
        hasKey &&
        process.env.SAM_DOWNLOAD_EXTRACTS !== "0"
      ) {
        const downloaded = await downloadExclusionsExtract();
        if (downloaded && memorySet && memorySet.size > 0) return;
      }

      // 3) Bundled data/sam (prod image / repo) — only if non-empty
      if (await loadBundledExclusions()) return;

      // 4) Stale cache still usable
      if (memorySet && memorySet.size > 0) return;

      // 5) Optional download for local/dev
      if (process.env.SAM_DOWNLOAD_EXTRACTS === "0") {
        log.info("sam_exclusions_download_skipped", {
          reason: "SAM_DOWNLOAD_EXTRACTS=0",
        });
        return;
      }
      if (hasKey) {
        const downloaded = await downloadExclusionsExtract();
        if (downloaded && memorySet && memorySet.size > 0) return;
      } else {
        log.warn("sam_exclusions_no_api_key", {
          hint: "Set SAM_API_KEY env or GitHub secret SAM_API_KEY",
        });
      }

      if (!memorySet) await loadIndexFromDisk();
      if (!memorySet || memorySet.size === 0) await loadBundledExclusions();
    })().finally(() => {
      loadPromise = null;
    });
  }

  await loadPromise;

  if (!memorySet || memorySet.size === 0) {
    return {
      ok: false,
      count: 0,
      fromCache: false,
      ageHours: null,
      error: getSamApiKey()
        ? "SAM exclusions download returned no UEIs (quota 429, bad key, or parse failed). Check Action logs for sam_extract_download_failed."
        : "SAM_API_KEY is missing. Add repo secret SAM_API_KEY (Actions → Settings → Secrets).",
    };
  }
  const age = memoryMeta ? Date.now() - memoryMeta.downloadedAt : 0;
  return {
    ok: true,
    count: memorySet.size,
    fromCache: age > 0 && age <= EXCLUSIONS_TTL_MS,
    ageHours: Math.round((age / 3600000) * 10) / 10,
  };
}

export function getExcludedUeis(): string[] {
  return memorySet ? [...memorySet] : [];
}

export function isUeiExcluded(uei: string): boolean | null {
  if (!memorySet) return null;
  return memorySet.has(uei.trim().toUpperCase());
}

export function getSamExtractStatus(): {
  loaded: boolean;
  count: number;
  downloadedAt: string | null;
  source: string | null;
} {
  return {
    loaded: Boolean(memorySet),
    count: memorySet?.size ?? 0,
    downloadedAt: memoryMeta
      ? new Date(memoryMeta.downloadedAt).toISOString()
      : null,
    source: memoryMeta?.source ?? null,
  };
}
