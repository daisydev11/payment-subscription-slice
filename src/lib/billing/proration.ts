import type { BillingInterval, PaymentKind } from "@prisma/client";
import { config } from "@/lib/config";
import type { Fulfilment, SubscriptionState } from "@/lib/billing/entitlement";
import { spanDays, unusedDays } from "@/lib/billing/periods";

export type ProrationLine = {
  reference: string;
  /** What that period was worth: the amount paid plus any credit used then. */
  valueMinor: number;
  spanDays: number;
  unusedDays: number;
  creditMinor: number;
};

export type Quote =
  | {
      ok: true;
      kind: PaymentKind;
      interval: BillingInterval;
      currency: string;
      listPriceMinor: number;
      creditMinor: number;
      /** What will actually be charged. */
      amountMinor: number;
      proration: ProrationLine[];
    }
  | { ok: false; code: "ALREADY_ON_PLAN" | "USE_DOWNGRADE"; message: string };

/**
 * Credit for the unused part of monthly periods already paid for.
 * Per period: value x unused days / days in the period, in integer minor
 * units, rounded DOWN so we never credit more than was paid.
 */
export function prorationCredit(fulfilments: Fulfilment[], at: Date): ProrationLine[] {
  return fulfilments
    .filter((f) => f.interval === "MONTHLY" && f.periodEnd > at)
    .map((f) => {
      const valueMinor = f.amountMinor + f.creditMinor;
      const total = spanDays(f.periodStart, f.periodEnd);
      const unused = unusedDays(f.periodStart, f.periodEnd, at);
      return {
        reference: f.reference,
        valueMinor,
        spanDays: total,
        unusedDays: unused,
        creditMinor: Math.floor((valueMinor * unused) / total),
      };
    });
}

/** Decides what a checkout for `interval` means for this user right now, and what it costs. */
export function quoteCheckout(state: SubscriptionState, fulfilments: Fulfilment[], interval: BillingInterval, at: Date): Quote {
  const { currency, plans } = config.billing;
  const listPriceMinor = plans[interval].priceMinor;
  const base = { ok: true as const, interval, currency, listPriceMinor };

  if (!state.entitled) {
    return { ...base, kind: "SUBSCRIBE", creditMinor: 0, amountMinor: listPriceMinor, proration: [] };
  }
  if (state.interval === interval) {
    return { ok: false, code: "ALREADY_ON_PLAN", message: `You are already on the ${plans[interval].label.toLowerCase()} plan.` };
  }
  if (interval === "MONTHLY") {
    return { ok: false, code: "USE_DOWNGRADE", message: "Switching to monthly happens at the end of your current period, with nothing to pay now." };
  }
  // Monthly -> yearly, mid-cycle: charge the yearly price less the unused monthly time.
  const proration = prorationCredit(fulfilments, at);
  const creditMinor = proration.reduce((sum, line) => sum + line.creditMinor, 0);
  return { ...base, kind: "UPGRADE", creditMinor, amountMinor: listPriceMinor - creditMinor, proration };
}
