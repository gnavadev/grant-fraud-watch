/**
 * Download FAC full dissemination CSVs (general, findings, federal_awards).
 * URLs redirect to short-lived S3 signed URLs — we follow redirects.
 *
 *   npm run bulk:download-fac
 */
import path from "node:path";
import {
  bulkDir,
  downloadToFile,
  loadConfig,
  ensureDir,
  readCheckpoint,
  writeCheckpoint,
} from "./lib.mjs";

async function main() {
  const cfg = loadConfig();
  const root = bulkDir(cfg);
  const rawDir = path.join(root, "raw", "fac");
  ensureDir(rawDir);
  const cp = readCheckpoint(root);
  cp.files = cp.files || {};

  const tables = cfg.facTables || ["general", "findings"];
  console.log(`FAC tables: ${tables.join(", ")} → ${rawDir}`);

  for (const table of tables) {
    const url = `${cfg.facBase}/${table}.csv`;
    const dest = path.join(rawDir, `${table}.csv`);
    const key = `fac:${table}.csv`;
    if (cp.files[key]?.ok && cp.files[key].bytes > 1000) {
      console.log(`skip (checkpoint) ${table}.csv (${cp.files[key].bytes} bytes)`);
      continue;
    }
    process.stdout.write(`→ ${table}.csv … `);
    try {
      // FAC redirects; fetch must not use Range on first hit easily — full download
      const r = await downloadToFile(url, dest, { resume: false });
      cp.files[key] = {
        ok: true,
        bytes: r.bytes,
        url,
        at: new Date().toISOString(),
      };
      writeCheckpoint(root, cp);
      console.log(`OK ${r.bytes} bytes`);
    } catch (err) {
      cp.files[key] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      };
      writeCheckpoint(root, cp);
      console.log(`FAIL ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("Done. Files land under data/bulk/raw/fac/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
