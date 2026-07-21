# Bulk offline data (USAspending + FAC)

This is the foundation for replacing rate-limited API precalc with monthly downloads + DuckDB + Redis scores-only.

## FY window (frozen for v1)

| Setting | Value |
|---------|--------|
| Assistance FYs | **2021–2025** (5 fiscal years) |
| Award types | Assistance only (`Assistance` archive files) |
| Grant filter | `assistance_type_code` in **02, 03, 04, 05** (matches live API) |
| FAC | Current dissemination CSVs (2016–present tables) |

Override later via `bulk/config.json` → `fyStart` / `fyEnd`.

---

## USAspending Award Data Archive

- **UI:** https://www.usaspending.gov/download_center/award_data_archive  
- **S3:** `https://files.usaspending.gov/award_data_archive/`  
- **Pattern:** `FY{YYYY}_{AGENCY|All}_Assistance_Full_{YYYYMMDD}.zip`  
- **Example (all agencies, large ~1.3GB):**  
  `FY2024_All_Assistance_Full_20260706.zip`  
- **Probe (small agency 025, ~22KB):**  
  `FY2024_025_Assistance_Full_20260706.zip`

List with S3 API:

```text
GET https://files.usaspending.gov/award_data_archive/?list-type=2&prefix=FY2024_All_Assistance&max-keys=20
```

### Columns we need (from probe CSV)

| Archive column | Used for |
|----------------|----------|
| `recipient_uei` | Identity, FAC join, SAM |
| `recipient_name` / `recipient_name_raw` | Display |
| `federal_action_obligation` | Amounts / Benford |
| `total_obligated_amount` | Optional total |
| `recipient_state_code` | State grouping |
| `primary_place_of_performance_state_name` | Alt state |
| `recipient_city_name` / `recipient_county_name` | Location |
| `cfda_number` | Program signal |
| `assistance_type_code` | Filter 02–05 |
| `assistance_award_unique_key` | Dedupe |
| `action_date` / `action_date_fiscal_year` | Window |
| `correction_delete_indicator_code` | Deltas (D/C/empty) |
| `usaspending_permalink` | Deep links |

### Not in archive (API-only)

| Field | Notes |
|-------|--------|
| Live `recipient_id` hash | Archive uses FAIN/URI keys; group by **UEI** (preferred) or name |
| Nested location objects | Flattened columns instead — **better** for bulk |

---

## FAC dissemination CSVs

- **Index:** https://www.fac.gov/data/download/current/  
- **Full tables (same shape as API):**  
  - https://app.fac.gov/dissemination/public-data/gsa/full/general.csv  
  - https://app.fac.gov/dissemination/public-data/gsa/full/findings.csv  
  - https://app.fac.gov/dissemination/public-data/gsa/full/federal_awards.csv  

Redirects to short-lived S3 signed URLs — download with follow-redirects.

### Fields for scoring (general table, API parity)

See https://www.fac.gov/api/dictionary/#endpoint-general

Typical flags we already use in live FAC:

- `auditee_uei`
- `is_going_concern_included`
- `is_internal_control_material_weakness_disclosed`
- `is_internal_control_deficiency_disclosed`
- `is_material_noncompliance_disclosed`
- `is_low_risk_auditee`
- `agencies_with_prior_findings`
- `total_amount_expended`
- `report_id`, `audit_year`

Findings table: aggregate findings counts per `report_id` / UEI when needed.

---

## Local layout

```text
data/bulk/
  raw/usa/FY2024_….zip
  raw/fac/general.csv
  parquet/awards/…
  parquet/fac/…
  duckdb/gfw.duckdb          # optional single file
  checkpoint.json            # download resume
```

**Do not commit** large raw/parquet files (gitignored).

---

## Commands (as implemented)

```bash
npm run bulk:list-usa          # list archive keys for FY window
npm run bulk:download-usa -- --fy 2024 --agency 025   # small probe
npm run bulk:download-fac      # general + findings CSVs
npm run bulk:load              # zip/csv → parquet + DuckDB (when duckdb deps present)
```

---

## Sequencing (from plan)

1. USA bulk download + parquet  
2. FAC bulk download + join  
3. Universe SQL + pure scorer  
4. Read-only live API + Redis ZSET ranks  
5. Exclusion holdout validation  
