import { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";
import { paystack, ProviderError, type Provider } from "@/lib/billing/paystack";
import { DAY_MS } from "@/lib/billing/periods";
import { settlePayment } from "@/lib/billing/settle";

const STALE_AFTER_DAYS = 7;

/**
 * Charges every subscription whose paid period has ended, using the
 * provider's stored token. This is also where a scheduled downgrade takes
 * effect: the renewal is charged at the pending interval's price.
 * Cancelled subscriptions are skipped and simply run out.
 */
export async function runRenewals(provider: Provider = paystack) {
  const at = now();
  const results: { userId: string; reference: string; outcome: string }[] = [];
  const candidates = await db.subscription.findMany({
    where: { cancelAtPeriodEnd: false, providerAuthorization: { not: null } },
    include: { user: { select: { email: true } } },
  });

  for (const settings of candidates) {
    const { state } = await loadSubscription(settings.userId, at);
    if (!state.periodEnd || !state.interval || state.periodEnd > at) continue; // not due
    if (at.getTime() - state.periodEnd.getTime() > STALE_AFTER_DAYS * DAY_MS) continue; // lapsed long ago

    const interval = settings.pendingInterval ?? state.interval;
    const amountMinor = config.billing.plans[interval].priceMinor;
    // Deterministic reference: one renewal attempt per user per period end.
    // If two runs overlap, the unique index lets only one create the row.
    const reference = `rnw-${settings.userId}-${state.periodEnd.toISOString().slice(0, 10).replaceAll("-", "")}`;
    const row = { userId: settings.userId, reference, source: "RENEWAL" as const, kind: "RENEWAL" as const, interval, amountMinor, currency: config.billing.currency };
    try {
      await db.paymentEvent.create({ data: { ...row, type: "INITIATION", createdAt: at, detail: { listPriceMinor: amountMinor } } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue; // already attempted
      throw error;
    }

    try {
      await provider.chargeAuthorization({ email: settings.user.email, amountMinor, currency: row.currency, reference, authorizationCode: settings.providerAuthorization! });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      await db.paymentEvent.create({ data: { ...row, type: "FAILURE", createdAt: now(), detail: { reason: "provider_unreachable", message: error.message } } });
      results.push({ userId: settings.userId, reference, outcome: "failed" });
      continue;
    }
    // Same path as every other payment: verify with the provider, then fulfil.
    const settled = await settlePayment(reference, "RENEWAL", provider);
    results.push({ userId: settings.userId, reference, outcome: settled.outcome });
  }
  return results;
}
