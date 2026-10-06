import { randomBytes } from "node:crypto";
import type { BillingInterval } from "@prisma/client";
import { db } from "@/lib/db";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";
import { paystack, ProviderError } from "@/lib/billing/paystack";
import { quoteCheckout } from "@/lib/billing/proration";

type CheckoutResult =
  | { ok: true; authorizationUrl: string; reference: string }
  | { ok: false; code: string; message: string };

/** Records the INITIATION and asks the provider for a hosted checkout page. */
export async function startCheckout(user: { id: string; email: string }, interval: BillingInterval): Promise<CheckoutResult> {
  const at = now();
  const { state, fulfilments } = await loadSubscription(user.id, at);
  const quote = quoteCheckout(state, fulfilments, interval, at);
  if (!quote.ok) return quote;

  // Our reference, created before the provider hears about the payment, so
  // there is never a provider transaction we have no record of.
  const reference = `pay-${randomBytes(12).toString("hex")}`;
  const row = {
    userId: user.id,
    reference,
    source: "CHECKOUT" as const,
    kind: quote.kind,
    interval,
    amountMinor: quote.amountMinor,
    currency: quote.currency,
    creditMinor: quote.creditMinor,
  };
  await db.paymentEvent.create({
    data: { ...row, type: "INITIATION", createdAt: at, detail: { listPriceMinor: quote.listPriceMinor, proration: quote.proration } },
  });

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  try {
    const { authorizationUrl } = await paystack.initialize({
      email: user.email,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      reference,
      callbackUrl: `${appUrl}/billing/return`,
      cancelUrl: `${appUrl}/billing/return?reference=${reference}`,
    });
    return { ok: true, authorizationUrl, reference };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    await db.paymentEvent.create({ data: { ...row, type: "FAILURE", createdAt: now(), detail: { reason: "provider_unreachable", message: error.message } } });
    return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "The payment provider is not responding. You have not been charged. Try again in a moment." };
  }
}
