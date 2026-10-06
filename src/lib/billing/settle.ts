import type { PaymentEvent, PaymentSource, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { now } from "@/lib/billing/clock";
import { deriveState, loadFulfilments } from "@/lib/billing/entitlement";
import { paystack, ProviderError, type Provider, type ProviderPayment } from "@/lib/billing/paystack";
import { addInterval } from "@/lib/billing/periods";

export type SettleResult =
  | { outcome: "fulfilled" | "already_fulfilled"; userId: string }
  | { outcome: "failed"; userId: string; reason: string }
  | { outcome: "pending"; userId: string; reason: string }
  | { outcome: "unknown" };

/** The fields every later row copies from the INITIATION row, so the log reads on its own. */
function carry(initiation: PaymentEvent, source: PaymentSource) {
  const { userId, reference, kind, interval, amountMinor, currency, creditMinor } = initiation;
  return { userId, reference, kind, interval, amountMinor, currency, creditMinor, source, createdAt: now() };
}

async function recordFailure(initiation: PaymentEvent, source: PaymentSource, reason: string, detail: Prisma.InputJsonObject = {}) {
  // One FAILURE row per distinct reason, however many times we are told.
  const seen = await db.paymentEvent.findFirst({
    where: { reference: initiation.reference, type: "FAILURE", detail: { path: ["reason"], equals: reason } },
    select: { id: true },
  });
  if (!seen) {
    await db.paymentEvent.create({ data: { ...carry(initiation, source), type: "FAILURE", detail: { reason, ...detail } } });
  }
}

/**
 * THE place a payment turns into access. Called by the return page, the
 * webhook and the renewal job, and safe to call any number of times for the
 * same reference.
 *
 *   1. Find our own INITIATION row. No row, no payment.
 *   2. Ask the provider, server to server, what happened to that reference.
 *   3. In one transaction: record the VERIFICATION, check the amount and
 *      currency against what we asked for, then record the FULFILMENT.
 *
 * Nothing the browser sends is trusted beyond the reference string itself.
 */
export async function settlePayment(reference: string, source: PaymentSource, provider: Provider = paystack): Promise<SettleResult> {
  const initiation = await db.paymentEvent.findFirst({ where: { reference, type: "INITIATION" } });
  if (!initiation) return { outcome: "unknown" };
  const { userId } = initiation;

  const already = await db.paymentEvent.findFirst({ where: { reference, type: "FULFILMENT" }, select: { id: true } });
  if (already) {
    await noteDuplicate(initiation, source);
    return { outcome: "already_fulfilled", userId };
  }

  let payment: ProviderPayment;
  try {
    payment = await provider.verify(reference);
  } catch (error) {
    if (error instanceof ProviderError) return { outcome: "pending", userId, reason: "provider_unreachable" };
    throw error;
  }
  if (payment.status === "pending") return { outcome: "pending", userId, reason: payment.providerStatus };
  if (payment.status === "abandoned") {
    // "Not paid yet" is not a failure. The provider reports an open checkout
    // as abandoned too, and that same reference may still be paid a minute
    // later. The INITIATION row with nothing after it already tells the story.
    return { outcome: "failed", userId, reason: "abandoned" };
  }
  if (payment.status !== "success") {
    await recordFailure(initiation, source, payment.providerStatus, { gatewayResponse: payment.gatewayResponse });
    return { outcome: "failed", userId, reason: payment.providerStatus };
  }

  return db.$transaction(async (tx) => {
    // One fulfilment at a time per user. Two payments landing together must
    // each see the period the other one bought.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

    const prior = await tx.paymentEvent.findMany({
      where: { reference, type: { in: ["VERIFICATION", "FULFILMENT"] } },
      select: { type: true },
    });
    if (prior.some((e) => e.type === "FULFILMENT")) {
      await noteDuplicate(initiation, source, tx);
      return { outcome: "already_fulfilled", userId } as const;
    }
    if (prior.length > 0) return { outcome: "failed", userId, reason: "amount_mismatch" } as const;

    await tx.paymentEvent.create({
      data: {
        ...carry(initiation, source),
        type: "VERIFICATION",
        amountMinor: payment.amountMinor, // what the provider says it collected
        currency: payment.currency,
        detail: { providerStatus: payment.providerStatus, channel: payment.channel, paidAt: payment.paidAt, gatewayResponse: payment.gatewayResponse },
      },
    });

    if (payment.amountMinor !== initiation.amountMinor || payment.currency !== initiation.currency) {
      await tx.paymentEvent.create({
        data: {
          ...carry(initiation, source),
          type: "FAILURE",
          detail: { reason: "amount_mismatch", expectedMinor: initiation.amountMinor, receivedMinor: payment.amountMinor, receivedCurrency: payment.currency },
        },
      });
      return { outcome: "failed", userId, reason: "amount_mismatch" } as const;
    }

    // What does this payment buy? An upgrade from monthly starts a fresh year
    // today. Anything else continues from the end of time already paid for:
    // a renewal, a second payment for the same plan, or a second payment for
    // the same upgrade. That is what makes paying twice extend access instead
    // of buying a period the user already owns.
    const at = now();
    const state = deriveState(await loadFulfilments(userId, tx), null, at);
    const replacesMonthly = initiation.kind === "UPGRADE" && state.interval !== "YEARLY";
    const paidAhead = state.periodEnd && (state.entitled || initiation.kind === "RENEWAL") && !replacesMonthly ? state.periodEnd : null;
    const periodStart = paidAhead ?? at;
    const periodEnd = addInterval(periodStart, initiation.interval);

    // ENTITLEMENT IS GRANTED HERE, and only here.
    await tx.paymentEvent.create({
      data: { ...carry(initiation, source), type: "FULFILMENT", periodStart, periodEnd, detail: { extendedExistingPeriod: Boolean(paidAhead) } },
    });

    const cleared = initiation.kind === "RENEWAL" ? {} : { cancelAtPeriodEnd: false, cancelledAt: null, cancellationReason: null };
    const token = payment.authorizationCode ? { providerAuthorization: payment.authorizationCode } : {};
    await tx.subscription.upsert({
      where: { userId },
      create: { userId, ...token },
      update: { pendingInterval: null, ...cleared, ...token },
    });
    return { outcome: "fulfilled", userId } as const;
  });
}

/** A repeat webhook or renewal for a finished payment: written down, then ignored. */
async function noteDuplicate(initiation: PaymentEvent, source: PaymentSource, client: Prisma.TransactionClient | typeof db = db) {
  if (source === "RETURN") return; // a user refreshing the return page is not an event
  await client.paymentEvent.create({ data: { ...carry(initiation, source), type: "DUPLICATE", detail: { note: "already fulfilled; no action taken" } } });
}
