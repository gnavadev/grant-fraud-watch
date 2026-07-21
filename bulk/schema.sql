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
