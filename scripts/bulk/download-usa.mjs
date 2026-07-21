/**
 * Download USAspending assistance archive ZIPs with checkpoint resume.
 *
 *   npm run bulk:download-usa -- --fy 2024 --agency 025
 *   npm run bulk:download-usa -- --all-years
 *   npm run bulk:download-usa -- --all-years --agency All
 */
import path from "node:path";
import {
  bulkDir,
  downloadToFile,
  loadConfig,
  listS3Keys,
  readCheckpoint,
  writeCheckpoint,
  ensureDir,
} from "./lib.mjs";

function parseArgs(argv) {
  let fy = null;
  let agency = "025"; // small default for safety
  let allYears = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fy" && argv[i + 1]) fy = Number(argv[++i]);
    else if (argv[i] === "--agency" && argv[i + 1]) agency = argv[++i];
    else if (argv[i] === "--all-years") allYears = true;
  }
  return { fy, agency, allYears };
}

async function resolveKeys(cfg, { fy, agency, allYears }) {
  const years = allYears
    ? Array.from(
        { length: cfg.fyEnd - cfg.fyStart + 1 },
        (_, i) => cfg.fyStart + i,
      )
    : [fy ?? cfg.fyEnd];

  const keys = [];
  for (const y of years) {
    const prefix =
      agency === "All" || agency === "all"
        ? `FY${y}_All_Assistance_Full_`
        : `FY${y}_${agency}_Assistance_Full_`;
    const found = await listS3Keys(prefix, 10);
    if (found.length === 0) {
      console.warn(`No keys for prefix ${prefix}`);
      continue;
    }
    // Prefer latest date tag in name (sort lexicographically on full key)
    found.sort();
    keys.push(found[found.length - 1]);
  }
  return keys;
}

async function main() {
  const cfg = loadConfig();
  const opts = parseArgs(process.argv.slice(2));
  const root = bulkDir(cfg);
  const rawDir = path.join(root, "raw", "usa");
  ensureDir(rawDir);

  const keys = await resolveKeys(cfg, opts);
  if (keys.length === 0) {
    console.error("Nothing to download.");
    process.exit(1);
  }

  const cp = readCheckpoint(root);
  cp.files = cp.files || {};

  console.log(`Downloading ${keys.length} file(s) → ${rawDir}`);
  for (const key of keys) {
    const url = `${cfg.usaArchiveBase}/${key}`;
    const dest = path.join(rawDir, key);
    const prev = cp.files[key];
    if (prev?.ok && prev.bytes > 1000) {
      console.log(`skip (checkpoint) ${key}`);
      continue;
    }
    process.stdout.write(`→ ${key} … `);
    try {
      const r = await downloadToFile(url, dest);
      cp.files[key] = {
        ok: true,
        bytes: r.bytes,
        url,
        at: new Date().toISOString(),
      };
      writeCheckpoint(root, cp);
      console.log(`OK ${r.bytes} bytes${r.skipped ? " (resume complete)" : ""}`);
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
  console.log("Done. Next: npm run bulk:download-fac  then  npm run bulk:load");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
