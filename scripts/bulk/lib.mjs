/**
 * Shared helpers for bulk download scripts (no heavy deps).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");

export function loadConfig() {
  const p = path.join(ROOT, "bulk", "config.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function bulkDir(cfg = loadConfig()) {
  return path.resolve(ROOT, cfg.dataDir || "data/bulk");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readCheckpoint(dir) {
  const p = path.join(dir, "checkpoint.json");
  if (!fs.existsSync(p)) return { files: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { files: {} };
  }
}

export function writeCheckpoint(dir, data) {
  ensureDir(dir);
  fs.writeFileSync(
    path.join(dir, "checkpoint.json"),
    JSON.stringify(data, null, 2),
    "utf8",
  );
}

export async function downloadToFile(url, dest, { resume = true } = {}) {
  ensureDir(path.dirname(dest));
  let start = 0;
  if (resume && fs.existsSync(dest)) {
    start = fs.statSync(dest).size;
  }
  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;

  const res = await fetch(url, {
    headers,
    redirect: "follow",
  });

  // 416 = already complete
  if (res.status === 416) return { path: dest, bytes: start, skipped: true };
  if (start > 0 && res.status === 200) {
    // Server ignored Range — re-download full
    start = 0;
  }
  if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed ${res.status} ${url}`);
  }

  const flag = start > 0 ? "a" : "w";
  const file = fs.createWriteStream(dest, { flags: flag });
  const reader = res.body.getReader();
  let bytes = start;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    file.write(Buffer.from(value));
    bytes += value.length;
  }
  await new Promise((resolve, reject) => {
    file.end(() => resolve());
    file.on("error", reject);
  });
  return { path: dest, bytes, skipped: false };
}

export async function listS3Keys(prefix, maxKeys = 1000) {
  const base = "https://files.usaspending.gov/award_data_archive/";
  const keys = [];
  let token = null;
  do {
    const u = new URL(base);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    u.searchParams.set("max-keys", String(Math.min(maxKeys, 1000)));
    if (token) u.searchParams.set("continuation-token", token);
    const res = await fetch(u);
    if (!res.ok) throw new Error(`S3 list failed ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(m[1]);
    }
    const cont = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = cont ? cont[1] : null;
    if (!xml.includes("<IsTruncated>true</IsTruncated>")) token = null;
  } while (token && keys.length < maxKeys);
  return keys;
}

export function usaAssistanceUrl(cfg, fy, agencyOrAll = "All") {
  const tag = cfg.usaArchiveDateTag || "20260706";
  const name = `FY${fy}_${agencyOrAll}_Assistance_Full_${tag}.zip`;
  return `${cfg.usaArchiveBase}/${name}`;
}
