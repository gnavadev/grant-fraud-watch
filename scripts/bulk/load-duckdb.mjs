/**
 * Load downloaded USA zips + FAC CSVs into DuckDB / parquet.
 * Requires optional dependency: npm i duckdb
 *
 *   npm run bulk:load
 *
 * If duckdb is not installed, prints SQL you can run manually.
 */
import fs from "node:fs";
import path from "node:path";
import { bulkDir, loadConfig, ensureDir, ROOT } from "./lib.mjs";

const SQL_SCHEMA = `
-- Awards: load CSVs extracted from archive zips (user extracts or future auto-unzip)
CREATE TABLE IF NOT EXISTS awards_raw AS
  SELECT * FROM read_csv_auto('data/bulk/raw/usa_extracted/**/*.csv',
    union_by_name=true, filename=true, ignore_errors=true)
  WHERE 1=0;

-- Example after extract:
-- COPY (SELECT * FROM read_csv_auto('...')) TO 'data/bulk/parquet/awards/fy2024.parquet' (FORMAT PARQUET);

CREATE OR REPLACE VIEW awards_grants AS
SELECT
  recipient_uei AS uei,
  COALESCE(NULLIF(recipient_name, ''), recipient_name_raw) AS recipient_name,
  TRY_CAST(federal_action_obligation AS DOUBLE) AS amount,
  recipient_state_code AS state_code,
  recipient_city_name AS city,
  recipient_county_name AS county,
  cfda_number,
  assistance_type_code,
  assistance_award_unique_key,
  action_date,
  action_date_fiscal_year AS fy,
  correction_delete_indicator_code AS correction_delete
FROM awards_raw
WHERE assistance_type_code IN ('02','03','04','05')
  AND (correction_delete IS NULL OR correction_delete = '' OR correction_delete = 'C');

CREATE OR REPLACE VIEW fac_general AS
SELECT * FROM read_csv_auto('data/bulk/raw/fac/general.csv', header=true, ignore_errors=true);

CREATE OR REPLACE VIEW fac_latest AS
SELECT * EXCLUDE (rn) FROM (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY auditee_uei ORDER BY audit_year DESC NULLS LAST) AS rn
  FROM fac_general
  WHERE auditee_uei IS NOT NULL AND auditee_uei <> ''
) t WHERE rn = 1;
`;

async function main() {
  const cfg = loadConfig();
  const root = bulkDir(cfg);
  ensureDir(path.join(root, "parquet"));
  ensureDir(path.join(root, "duckdb"));

  const schemaPath = path.join(ROOT, "bulk", "schema.sql");
  fs.writeFileSync(schemaPath, SQL_SCHEMA.trim() + "\n", "utf8");
  console.log(`Wrote ${schemaPath}`);

  let Database;
  try {
    const mod = await import("duckdb");
    // CJS package under ESM: constructors live on .default
    Database = mod.Database ?? mod.default?.Database;
    if (typeof Database !== "function") {
      throw new Error("duckdb.Database export not found");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Cannot find package|MODULE_NOT_FOUND|duckdb/i.test(msg) && !/export not found/i.test(msg)) {
      console.log(`
duckdb package not installed. Install with:

  npm i duckdb

Then re-run: npm run bulk:load

Or open DuckDB CLI and run bulk/schema.sql after extracting USA CSVs into
data/bulk/raw/usa_extracted/
`);
      process.exit(0);
    }
    throw err;
  }

  const dbPath = path.join(root, "duckdb", "gfw.duckdb");
  const db = await new Promise((resolve, reject) => {
    const d = new Database(dbPath, (err) => (err ? reject(err) : resolve(d)));
  });

  const run = (sql) =>
    new Promise((resolve, reject) => {
      db.run(sql, (err) => (err ? reject(err) : resolve()));
    });
  const all = (sql) =>
    new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  // FAC if present (general + optional findings counts by report_id)
  const facGeneral = path.join(root, "raw", "fac", "general.csv");
  const facFindings = path.join(root, "raw", "fac", "findings.csv");
  if (fs.existsSync(facGeneral)) {
    console.log("Loading FAC general.csv …");
    await run(`
      CREATE OR REPLACE TABLE fac_general AS
      SELECT * FROM read_csv_auto('${facGeneral.replace(/\\/g, "/")}',
        header=true, ignore_errors=true, sample_size=-1);
    `);

    if (fs.existsSync(facFindings)) {
      console.log("Loading FAC findings.csv (counts by report_id) …");
      await run(`
        CREATE OR REPLACE TABLE fac_findings AS
        SELECT * FROM read_csv_auto('${facFindings.replace(/\\/g, "/")}',
          header=true, ignore_errors=true, sample_size=-1);
      `);
      // Column name is typically report_id (same as API / general)
      await run(`
        CREATE OR REPLACE TABLE fac_findings_by_report AS
        SELECT
          CAST(report_id AS VARCHAR) AS report_id,
          COUNT(*)::BIGINT AS findings_count
        FROM fac_findings
        WHERE report_id IS NOT NULL
        GROUP BY 1;
      `);
      const nf = (await all("SELECT COUNT(*) AS c FROM fac_findings_by_report"))[0]
        .c;
      console.log(`  fac_findings_by_report rows: ${nf}`);
    } else {
      console.log("No findings.csv — findings_count will default to 0");
      await run(`
        CREATE OR REPLACE TABLE fac_findings_by_report AS
        SELECT CAST(NULL AS VARCHAR) AS report_id, 0::BIGINT AS findings_count
        WHERE 1=0;
      `);
    }

    await run(`
      CREATE OR REPLACE TABLE fac_latest AS
      SELECT * EXCLUDE (rn) FROM (
        SELECT
          g.*,
          COALESCE(fc.findings_count, 0) AS findings_count,
          ROW_NUMBER() OVER (
            PARTITION BY g.auditee_uei
            ORDER BY TRY_CAST(g.audit_year AS INTEGER) DESC NULLS LAST
          ) AS rn
        FROM fac_general g
        LEFT JOIN fac_findings_by_report fc
          ON CAST(g.report_id AS VARCHAR) = fc.report_id
        WHERE g.auditee_uei IS NOT NULL AND CAST(g.auditee_uei AS VARCHAR) <> ''
      ) t WHERE rn = 1;
    `);
    const n = (await all("SELECT COUNT(*) AS c FROM fac_latest"))[0].c;
    const withF = (
      await all(
        "SELECT COUNT(*) AS c FROM fac_latest WHERE findings_count > 0",
      )
    )[0].c;
    console.log(`  fac_latest rows: ${n} (with findings_count>0: ${withF})`);
  } else {
    console.log("No FAC general.csv yet — run npm run bulk:download-fac");
  }

  // USA: look for extracted CSVs
  const extracted = path.join(root, "raw", "usa_extracted");
  if (fs.existsSync(extracted)) {
    const glob = path.join(extracted, "**", "*.csv").replace(/\\/g, "/");
    console.log(`Loading USA CSVs from ${extracted} …`);
    await run(`
      CREATE OR REPLACE TABLE awards_raw AS
      SELECT * FROM read_csv_auto('${glob}',
        union_by_name=true, filename=true, ignore_errors=true, sample_size=50000);
    `);
    await run(`
      CREATE OR REPLACE TABLE awards_grants AS
      SELECT
        recipient_uei AS uei,
        COALESCE(NULLIF(recipient_name, ''), recipient_name_raw) AS recipient_name,
        TRY_CAST(federal_action_obligation AS DOUBLE) AS amount,
        recipient_state_code AS state_code,
        recipient_city_name AS city,
        recipient_county_name AS county,
        cfda_number,
        assistance_type_code,
        assistance_award_unique_key,
        action_date,
        TRY_CAST(action_date_fiscal_year AS INTEGER) AS fy,
        correction_delete_indicator_code AS correction_delete
      FROM awards_raw
      WHERE CAST(assistance_type_code AS VARCHAR) IN ('02','03','04','05')
        AND (
          correction_delete IS NULL
          OR CAST(correction_delete AS VARCHAR) IN ('', 'C')
        );
    `);
    const n = (await all("SELECT COUNT(*) AS c FROM awards_grants"))[0].c;
    console.log(`  awards_grants rows: ${n}`);
  } else {
    console.log(
      `No extracted USA CSVs at ${extracted}\n` +
        `  1) npm run bulk:download-usa -- --fy 2024 --agency 025\n` +
        `  2) Unzip into data/bulk/raw/usa_extracted/\n` +
        `  3) npm run bulk:load`,
    );
  }

  console.log(`DuckDB file: ${dbPath}`);
  await new Promise((resolve) => db.close(resolve));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
