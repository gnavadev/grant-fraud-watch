import { scoreFacilityFromAmounts } from "./aggregate.js";
import type { Facility } from "./types.js";
import {
  amountsFromAwards,
  amountsFromTransactions,
  fetchAwardsForRecipient,
  fetchTransactionsForRecipient,
} from "./usaspending.js";

/**
 * Deep score: pull more awards + transaction-level amounts for one facility,
 * then re-run Benford + XGBoost.
 */
export async function deepScoreFacility(
  facility: Pick<
    Facility,
    "id" | "name" | "city" | "county" | "state" | "features" | "benfordScore" | "confidence"
  >,
  peers: Facility[] = [],
): Promise<{ facility: Facility; amountsUsed: number }> {
  const [awards, txns] = await Promise.all([
    fetchAwardsForRecipient(facility.name, facility.state ?? undefined),
    fetchTransactionsForRecipient(facility.name, facility.state ?? undefined),
  ]);

  const awardAmounts = amountsFromAwards(awards);
  const txnAmounts = amountsFromTransactions(txns);

  // Prefer transactions (more samples); fall back to awards; merge uniques by value sequence
  const amounts =
    txnAmounts.length >= 5
      ? txnAmounts
      : txnAmounts.length > 0
        ? [...txnAmounts, ...awardAmounts]
        : awardAmounts;

  if (amounts.length === 0) {
    throw new Error(
      "No additional award or transaction amounts found for this facility.",
    );
  }

  const { facility: scored } = await scoreFacilityFromAmounts({
    id: facility.id,
    name: facility.name,
    city: facility.city,
    county: facility.county,
    state: facility.state,
    amounts,
    peers,
  });

  // Preserve better location from original if deep pull misses it
  if (!scored.city && facility.city) scored.city = facility.city;
  if (!scored.county && facility.county) scored.county = facility.county;
  if (!scored.state && facility.state) scored.state = facility.state;

  return { facility: scored, amountsUsed: amounts.length };
}
