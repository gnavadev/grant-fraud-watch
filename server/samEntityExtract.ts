/**
 * SAM public monthly ENTITY extract → local SQLite index by UEI.
 *
 * File format (PUBLIC V2):
 *  - First line: BOF header (skip)
 *  - Last line: EOF trailer (skip)
 *  - Data: pipe-delimited fields; some multi-value groups use count + tilde (~) lists
 *
 * Field map (PUBLIC V2, UEI-era layout — verify against open.gsa.gov layout PDF if needed):
 *  0  Unique Entity ID (UEI)
 *  5  Registration Status (A=Active, …)
 *  7  Registration Date (YYYYMMDD)
 *  8  Expiration Date (YYYYMMDD)
 *  11 Legal Business Name
 *
 * Download (1 call/month, PUBLIC sensitivity):
 *  GET .../extracts?api_key=...&fileType=ENTITY&sensitivity=PUBLIC&frequency=MONTHLY
 *  or fileName=SAM_PUBLIC_MONTHLY_V2_YYYYMMDD.ZIP
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import yauzl from "yauzl";
import { getSamApiKey } from "./env.js";
import { log } from "./logger.js";
import {
  bundledEntityDbPath,
  cacheEntityDbPath,
  cacheSamDir,
} from "./samDataPaths.js";

export const SAM_CACHE_DIR = cacheSamDir();
let ENTITY_DB = cacheEntityDbPath();
const ENTITY_META = path.join(SAM_CACHE_DIR, "entities_meta.json");
const ENTITY_ZIP = path.join(SAM_CACHE_DIR, "entity_monthly.zip");
const ENTITY_DAT = path.join(SAM_CACHE_DIR, "entity_monthly.dat");

function resolveEntityDbPath(): string {
  // Prefer bundled data/sam/entities.sqlite (repo bake or Docker COPY)
  if (existsSync(bundledEntityDbPath())) return bundledEntityDbPath();
  if (existsSync(cacheEntityDbPath())) return cacheEntityDbPath();
  return cacheEntityDbPath();
}

/** Refresh monthly extract at most every 25 days. */
const ENTITY_TTL_MS = 25 * 24 * 60 * 60 * 1000;

/** PUBLIC V2 column indices (0-based). */
export const ENTITY_COL = {
  UEI: 0,
  REG_STATUS: 5,
  REG_DATE: 7,
  EXP_DATE: 8,
  LEGAL_NAME: 11,
} as const;

export interface SamEntityRow {
  uei: string;
  registrationStatus: string | null;
  registrationDate: string | null; // ISO yyyy-mm-dd
  expirationDate: string | null;
  legalBusinessName: string | null;
}

let db: DatabaseSync | null = null;

function ymdToIso(ymd: string | undefined | null): string | null {
  if (!ymd || !/^\d{8}$/.test(ymd)) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function isDataRow(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("BOF ") || t.startsWith("EOF ")) return false;
  // Data rows are pipe-delimited with many fields
  return t.includes("|");
}

export function parseEntityDataLine(line: string): SamEntityRow | null {
  if (!isDataRow(line)) return null;
  const parts = line.split("|");
  if (parts.length < 12) return null;
  const uei = (parts[ENTITY_COL.UEI] ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(uei)) return null;
  const status = (parts[ENTITY_COL.REG_STATUS] ?? "").trim() || null;
  const name = (parts[ENTITY_COL.LEGAL_NAME] ?? "").trim() || null;
  return {
    uei,
    registrationStatus: status,
    registrationDate: ymdToIso(parts[ENTITY_COL.REG_DATE]),
    expirationDate: ymdToIso(parts[ENTITY_COL.EXP_DATE]),
    legalBusinessName: name,
  };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SAM_CACHE_DIR, { recursive: true });
}

function openDb(readonly = false): DatabaseSync {
  if (db && !readonly) return db;
  // Writes always go to cache; reads prefer bundled then cache
  ENTITY_DB = readonly ? resolveEntityDbPath() : cacheEntityDbPath();
  const database = new DatabaseSync(ENTITY_DB, { readOnly: readonly });
  if (!readonly) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        uei TEXT PRIMARY KEY,
        registration_status TEXT,
        registration_date TEXT,
        expiration_date TEXT,
        legal_business_name TEXT
      );
    `);
  }
  if (!readonly) db = database;
  return database;
}

/**
 * Download slim entities.sqlite from a Release / CDN URL (prod).
 * Env: SAM_ENTITY_DB_URL=https://github.com/OWNER/REPO/releases/download/sam-data-latest/entities.sqlite
 */
export async function downloadEntityDbFromUrl(
  url: string,
): Promise<boolean> {
  try {
    await ensureDir();
    log.info("sam_entity_db_url_download", { url: url.slice(0, 120) });
    const res = await fetch(url, {
      signal: AbortSignal.timeout(300_000),
      headers: { Accept: "application/octet-stream" },
    });
    if (!res.ok) {
      log.warn("sam_entity_db_url_failed", { status: res.status });
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = cacheEntityDbPath();
    await fs.writeFile(dest, buf);
    await fs.writeFile(
      ENTITY_META,
      JSON.stringify({
        builtAt: Date.now(),
        source: url,
        count: -1,
      }),
      "utf8",
    );
    db = null;
    ENTITY_DB = dest;
    log.info("sam_entity_db_url_ready", { bytes: buf.length, dest });
    return true;
  } catch (err) {
    log.warn("sam_entity_db_url_error", { err });
    return false;
  }
}

export function getEntityFromExtract(uei: string): SamEntityRow | null {
  try {
    const database = openDb(true);
    const row = database
      .prepare(
        `SELECT uei, registration_status, registration_date, expiration_date, legal_business_name
         FROM entities WHERE uei = ?`,
      )
      .get(uei.trim().toUpperCase()) as
      | {
          uei: string;
          registration_status: string | null;
          registration_date: string | null;
          expiration_date: string | null;
          legal_business_name: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      uei: row.uei,
      registrationStatus: row.registration_status,
      registrationDate: row.registration_date,
      expirationDate: row.expiration_date,
      legalBusinessName: row.legal_business_name,
    };
  } catch {
    return null;
  }
}

export async function getEntityExtractStatus(): Promise<{
  ready: boolean;
  count: number;
  builtAt: string | null;
  source: string | null;
}> {
  try {
    const metaRaw = await fs.readFile(ENTITY_META, "utf8");
    const meta = JSON.parse(metaRaw) as {
      builtAt: number;
      source: string;
      count: number;
    };
    return {
      ready: true,
      count: meta.count,
      builtAt: new Date(meta.builtAt).toISOString(),
      source: meta.source,
    };
  } catch {
    try {
      const database = openDb(true);
      const row = database
        .prepare(`SELECT COUNT(*) AS c FROM entities`)
        .get() as { c: number };
      return {
        ready: row.c > 0,
        count: row.c,
        builtAt: null,
        source: null,
      };
    } catch {
      return { ready: false, count: 0, builtAt: null, source: null };
    }
  }
}

async function entityIndexFresh(): Promise<boolean> {
  try {
    const metaRaw = await fs.readFile(ENTITY_META, "utf8");
    const meta = JSON.parse(metaRaw) as { builtAt: number };
    return Date.now() - meta.builtAt < ENTITY_TTL_MS;
  } catch {
    return false;
  }
}

function extractZipEntryToFile(
  zipPath: string,
  destPath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("zip open failed"));
        return;
      }
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        const name = entry.fileName;
        if (/\/$/.test(name)) {
          zipfile.readEntry();
          return;
        }
        // Prefer .dat (entity extract); also allow .csv
        if (!/\.(dat|csv|txt)$/i.test(name)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (e2, readStream) => {
          if (e2 || !readStream) {
            done(() => reject(e2 ?? new Error("zip stream failed")));
            return;
          }
          const out = createWriteStream(destPath);
          readStream.pipe(out);
          out.on("finish", () => done(() => resolve(name)));
          out.on("error", (e) => done(() => reject(e)));
          readStream.on("error", (e) => done(() => reject(e)));
        });
      });
      zipfile.on("end", () => {
        done(() => reject(new Error("No .dat/.csv entry in entity ZIP")));
      });
      zipfile.on("error", (e) => done(() => reject(e)));
    });
  });
}

async function streamDownload(url: string, destPath: string): Promise<void> {
  // Follow redirects (SAM extracts often 302 → S3), same as curl -L
  const res = await fetch(url, {
    headers: { Accept: "application/zip, application/octet-stream, */*" },
    signal: AbortSignal.timeout(600_000),
    redirect: "follow",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("Empty body");

  const file = createWriteStream(destPath);
  const reader = res.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((r) => file.once("drain", () => r()));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve());
      file.on("error", reject);
    });
  } finally {
    reader.releaseLock();
  }
  if (bytes < 1000) {
    throw new Error(
      `Download too small (${bytes} bytes). Likely redirect/HTML error, not a ZIP.`,
    );
  }
  log.info("sam_entity_download_bytes", { bytes, destPath });
}

/** Candidate extract URLs (monthly file may lag; try current + previous month). */
function entityExtractUrls(apiKey: string, preferredDate?: string): string[] {
  const urls: string[] = [];
  const now = new Date();
  const months: string[] = [];
  if (preferredDate) months.push(preferredDate);
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const key = `${mm}/${yyyy}`;
    if (!months.includes(key)) months.push(key);
  }
  for (const dateParam of months) {
    urls.push(
      `https://api.sam.gov/data-services/v1/extracts` +
        `?api_key=${encodeURIComponent(apiKey)}` +
        `&fileType=ENTITY` +
        `&sensitivity=PUBLIC` +
        `&frequency=MONTHLY` +
        `&date=${encodeURIComponent(dateParam)}`,
    );
  }
  // UTF-8 monthly without date (latest)
  urls.push(
    `https://api.sam.gov/data-services/v1/extracts` +
      `?api_key=${encodeURIComponent(apiKey)}` +
      `&fileType=ENTITY` +
      `&sensitivity=PUBLIC` +
      `&frequency=MONTHLY` +
      `&charset=UTF8`,
  );
  return urls;
}

async function buildSqliteFromDat(datPath: string, source: string): Promise<number> {
  // Always write the runtime cache DB path (not a missing bundled path)
  ENTITY_DB = cacheEntityDbPath();
  try {
    await fs.unlink(ENTITY_DB);
  } catch {
    /* ok */
  }
  db = null;
  const database = openDb(false);
  database.exec("BEGIN");
  const insert = database.prepare(
    `INSERT OR REPLACE INTO entities
     (uei, registration_status, registration_date, expiration_date, legal_business_name)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let count = 0;
  const rl = readline.createInterface({
    input: createReadStream(datPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const row = parseEntityDataLine(line);
    if (!row) continue;
    insert.run(
      row.uei,
      row.registrationStatus,
      row.registrationDate,
      row.expirationDate,
      row.legalBusinessName,
    );
    count++;
    if (count % 100_000 === 0) {
      log.info("sam_entity_index_progress", { count });
    }
  }

  database.exec("COMMIT");
  await fs.writeFile(
    ENTITY_META,
    JSON.stringify({
      builtAt: Date.now(),
      source,
      count,
    }),
    "utf8",
  );
  return count;
}

/**
 * Download public monthly entity extract and build local SQLite index.
 * Prefer running via `npm run sam:sync` (not on every search).
 */
export async function syncSamEntityExtract(options?: {
  /** MM/YYYY e.g. 07/2026 — defaults to current month */
  date?: string;
  /** Force re-download even if index is fresh */
  force?: boolean;
}): Promise<{
  ok: boolean;
  count: number;
  source: string | null;
  error?: string;
}> {
  await ensureDir();

  if (!options?.force && (await entityIndexFresh())) {
    const st = await getEntityExtractStatus();
    return { ok: st.ready, count: st.count, source: st.source };
  }

  const apiKey = getSamApiKey();
  if (!apiKey) {
    return { ok: false, count: 0, source: null, error: "SAM_API_KEY not set" };
  }

  const urls = entityExtractUrls(apiKey, options?.date);
  log.info("sam_entity_download_start", { candidates: urls.length });

  let downloadError = "unknown";
  let downloaded = false;
  for (const url of urls) {
    try {
      // Log URL without api_key
      log.info("sam_entity_try_url", {
        url: url.replace(/api_key=[^&]+/, "api_key=***"),
      });
      await streamDownload(url, ENTITY_ZIP);
      downloaded = true;
      break;
    } catch (err) {
      downloadError = err instanceof Error ? err.message : String(err);
      log.warn("sam_entity_download_failed", { err: downloadError });
    }
  }

  if (!downloaded) {
    // Manual bootstrap: place entity_manual.zip in .cache/sam/
    try {
      await fs.access(path.join(SAM_CACHE_DIR, "entity_manual.zip"));
      await fs.copyFile(
        path.join(SAM_CACHE_DIR, "entity_manual.zip"),
        ENTITY_ZIP,
      );
      log.info("sam_entity_using_manual_zip");
      downloaded = true;
    } catch {
      return {
        ok: false,
        count: 0,
        source: null,
        error: `Entity extract download failed: ${downloadError}. Try: curl -sL -o .cache/sam/entity_manual.zip "…fileType=ENTITY&sensitivity=PUBLIC&frequency=MONTHLY&date=MM/YYYY" then npm run sam:sync-entities -- --force`,
      };
    }
  }

  try {
    const entryName = await extractZipEntryToFile(ENTITY_ZIP, ENTITY_DAT);
    const count = await buildSqliteFromDat(ENTITY_DAT, entryName);
    log.info("sam_entity_index_ready", { count, source: entryName });

    // Free disk: drop raw zip/dat after successful index (keep sqlite)
    try {
      await fs.unlink(ENTITY_ZIP);
      await fs.unlink(ENTITY_DAT);
    } catch {
      /* ok */
    }

    return { ok: true, count, source: entryName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("sam_entity_parse_failed", { err: msg });
    return { ok: false, count: 0, source: null, error: msg };
  }
}

/**
 * Ensure entity SQLite exists (does not download full monthly extract on web requests).
 * Order: existing DB → bundled data/sam → SAM_ENTITY_DB_URL Release download.
 */
export async function ensureSamEntityIndex(): Promise<boolean> {
  if (await entityIndexFresh()) return true;

  // Bundled / already on disk
  if (existsSync(bundledEntityDbPath()) || existsSync(cacheEntityDbPath())) {
    db = null;
    ENTITY_DB = resolveEntityDbPath();
    const st = await getEntityExtractStatus();
    if (st.ready && st.count > 0) return true;
    // count unknown from meta but file exists
    if (existsSync(ENTITY_DB)) return true;
  }

  // Prod: slim DB from GitHub Release (one HTTP GET, not SAM)
  const url = process.env.SAM_ENTITY_DB_URL?.trim();
  if (url) {
    const ok = await downloadEntityDbFromUrl(url);
    if (ok) return true;
  }

  const st = await getEntityExtractStatus();
  return st.ready && st.count > 0;
}
