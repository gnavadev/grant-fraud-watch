import type { TransactionRow } from "./types.js";

export interface TemporalRisk {
  recipientKey: string;
  txnCount: number;
  fyq4Share: number;
  modChurn: number;
  deobligationShare: number;
  /** 0–100 */
  riskScore: number;
}

function fiscalQuarter(d: Date): number {
  // Federal FY: Oct–Sep; Q4 = Jul–Sep
  const m = d.getUTCMonth(); // 0–11
  if (m >= 9) return 1; // Oct–Dec
  if (m <= 2) return 2; // Jan–Mar
  if (m <= 5) return 3; // Apr–Jun
  return 4; // Jul–Sep
}

/**
 * Temporal risk from transaction action dates for one recipient.
 * End-of-FY clustering + de-obligation / modification churn.
 */
export function temporalRiskFromTransactions(
  recipientKey: string,
  txns: TransactionRow[],
): TemporalRisk {
  const dates: Date[] = [];
  let neg = 0;
  let mods = 0;
  let n = 0;

  for (const t of txns) {
    const amt = t["Transaction Amount"];
    if (typeof amt === "number" && Number.isFinite(amt) && amt !== 0) {
      n += 1;
      if (amt < 0) neg += 1;
    }
    if (t.Mod && String(t.Mod) !== "0" && String(t.Mod) !== "") mods += 1;
    const ad = t["Action Date"];
    if (ad) {
      const d = new Date(ad);
      if (!Number.isNaN(d.getTime())) dates.push(d);
    }
  }

  let q4 = 0;
  for (const d of dates) {
    if (fiscalQuarter(d) === 4) q4 += 1;
  }
  const fyq4Share = dates.length > 0 ? q4 / dates.length : 0;
  const deobligationShare = n > 0 ? neg / n : 0;
  const modChurn = n > 0 ? mods / n : 0;

  let risk = 0;
  // Heavy end-of-FY obligation bunching
  if (dates.length >= 5 && fyq4Share >= 0.55) risk = Math.max(risk, 45);
  if (dates.length >= 5 && fyq4Share >= 0.7) risk = Math.max(risk, 65);

  // De-obligation churn
  if (n >= 5 && deobligationShare >= 0.25) risk = Math.max(risk, 40);
  if (n >= 5 && deobligationShare >= 0.4) risk = Math.max(risk, 60);

  // Many modifications
  if (n >= 5 && modChurn >= 0.5) risk = Math.max(risk, 35);
  if (n >= 8 && modChurn >= 0.7) risk = Math.max(risk, 50);

  return {
    recipientKey,
    txnCount: n,
    fyq4Share,
    modChurn,
    deobligationShare,
    riskScore: Math.min(100, risk),
  };
}

export function groupTransactionsByRecipient(
  txns: TransactionRow[],
): Map<string, TransactionRow[]> {
  const map = new Map<string, TransactionRow[]>();
  for (const t of txns) {
    const id = t.recipient_id;
    if (!id) continue;
    const list = map.get(id) ?? [];
    list.push(t);
    map.set(id, list);
  }
  return map;
}
