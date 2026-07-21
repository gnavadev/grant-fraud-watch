/**
 * Quick health check for bulk DuckDB load.
 *   npm run bulk:verify
 */
import path from "node:path";
import fs from "node:fs";
import { bulkDir, loadConfig, ROOT } from "./lib.mjs";

async function main() {
  const cfg = loadConfig();
  const root = bulkDir(cfg);
  const dbPath = path.join(root, "duckdb", "gfw.duckdb");

  console.log("=== Bulk data verify ===\n");

  // Files on disk
  const checks = [
    ["USA zips", path.join(root, "raw", "usa")],
    ["USA extracted CSVs", path.join(root, "raw", "usa_extracted")],
    ["FAC CSVs", path.join(root, "raw", "fac")],
    ["DuckDB", dbPath],
  ];
  for (const [label, p] of checks) {
    if (!fs.existsSync(p)) {
      console.log(`✗ ${label}: missing (${p})`);
      continue;
    }
    if (fs.statSync(p).isDirectory()) {
      const n = fs.readdirSync(p).length;
      console.log(`✓ ${label}: ${n} item(s) in ${p}`);
    } else {
      const mb = (fs.statSync(p).size / (1024 * 1024)).toFixed(1);
      console.log(`✓ ${label}: ${mb} MB`);
    }
  }

  let Database;
  try {
    const mod = await import("duckdb");
    Database = mod.Database ?? mod.default?.Database;
  } catch {
    console.log("\n✗ duckdb package not installed (npm i duckdb)");
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.log("\n✗ No DuckDB file — run npm run bulk:load first");
    process.exit(1);
  }

  // Open explicitly (async) — sync connect() is flaky with this native binding
  const db = await new Promise((resolve, reject) => {
    const d = new Database(dbPath, (err) => (err ? reject(err) : resolve(d)));
  });
  const q = (sql) =>
    new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  console.log("\n--- DuckDB tables ---");
  try {
    const tables = await q("SHOW TABLES");
    const names = tables.map((t) => t.name ?? Object.values(t)[0]);
    console.log(names.length ? names.join(", ") : "(none)");
  } catch (e) {
    console.log("Could not list tables:", e.message);
  }

  async function count(table) {
    try {
      const r = await q(`SELECT COUNT(*) AS c FROM ${table}`);
      return Number(r[0].c);
    } catch {
      return null;
    }
  }

  console.log("\n--- Row counts ---");
  for (const t of [
    "fac_general",
    "fac_latest",
    "awards_raw",
    "awards_grants",
  ]) {
    const c = await count(t);
    if (c == null) console.log(`✗ ${t}: not loaded`);
    else console.log(`✓ ${t}: ${c.toLocaleString()} rows`);
  }

  // Sample FAC
  const facN = await count("fac_latest");
  if (facN != null && facN > 0) {
    console.log("\n--- FAC sample (3 UEIs) ---");
    const rows = await q(`
      SELECT auditee_uei, audit_year,
             is_going_concern_included,
             is_internal_control_material_weakness_disclosed,
             is_low_risk_auditee
      FROM fac_latest
      WHERE auditee_uei IS NOT NULL
      LIMIT 3
    `);
    console.table(rows);
  }

  // Sample awards
  const awN = await count("awards_grants");
  if (awN != null && awN > 0) {
    console.log("\n--- Awards sample (5 grant rows, types 02–05) ---");
    const rows = await q(`
      SELECT uei, recipient_name, state_code, amount, cfda_number, assistance_type_code, fy
      FROM awards_grants
      LIMIT 5
    `);
    console.table(rows);

    console.log("\n--- Awards by state (top 10) ---");
    const byState = await q(`
      SELECT state_code, COUNT(*) AS rows, COUNT(DISTINCT uei) AS recipients
      FROM awards_grants
      WHERE state_code IS NOT NULL AND state_code <> ''
      GROUP BY 1
      ORDER BY recipients DESC
      LIMIT 10
    `);
    console.table(byState);

    // Join FAC ∩ awards (how many grant recipients have a Single Audit)
    console.log("\n--- FAC ∩ awards (UEI overlap) ---");
    try {
      const join = await q(`
        SELECT
          COUNT(DISTINCT a.uei) AS award_ueis,
          COUNT(DISTINCT CASE WHEN f.auditee_uei IS NOT NULL THEN a.uei END) AS with_fac
        FROM awards_grants a
        LEFT JOIN fac_latest f ON UPPER(TRIM(CAST(a.uei AS VARCHAR)))
          = UPPER(TRIM(CAST(f.auditee_uei AS VARCHAR)))
        WHERE a.uei IS NOT NULL AND CAST(a.uei AS VARCHAR) <> ''
      `);
      console.table(join);
    } catch (e) {
      console.log("Join skipped:", e.message);
    }
  } else {
    console.log(`
⚠ awards_grants empty or missing.

To load USA awards:
  1) npm run bulk:download-usa -- --fy 2024 --agency 025
  2) Expand-Archive data\\bulk\\raw\\usa\\*.zip → data\\bulk\\raw\\usa_extracted\\
  3) npm run bulk:load
  4) npm run bulk:verify
`);
  }

  console.log("\n=== Summary ===");
  const facOk = (await count("fac_latest")) > 0;
  const awOk = (await count("awards_grants")) > 0;
  if (facOk && awOk) {
    console.log("✓ FAC + awards both loaded — bulk foundation works.");
  } else if (facOk) {
    console.log("✓ FAC OK · ✗ awards still needed for full offline scoring.");
  } else if (awOk) {
    console.log("✓ awards OK · ✗ FAC missing (npm run bulk:download-fac && bulk:load).");
  } else {
    console.log("✗ Neither FAC nor awards loaded yet.");
  }

  await new Promise((resolve) => db.close(resolve));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
