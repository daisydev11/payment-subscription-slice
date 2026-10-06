import type { BillingInterval, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type Fulfilment = {
  reference: string;
  interval: BillingInterval;
  amountMinor: number;
  creditMinor: number;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
};

export type Settings = {
  cancelAtPeriodEnd: boolean;
  cancellationReason: string | null;
  pendingInterval: BillingInterval | null;
  providerAuthorization: string | null;
};

export type SubscriptionState = {
  /** True when a paid period covers this moment. The only thing that grants access. */
  entitled: boolean;
  status: "free" | "active" | "cancelling" | "expired";
  interval: BillingInterval | null;
  periodStart: Date | null;
  /** The date paid access runs to. */
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancellationReason: string | null;
  pendingInterval: BillingInterval | null;
};

const NO_SETTINGS: Settings = {
  cancelAtPeriodEnd: false,
  cancellationReason: null,
  pendingInterval: null,
  providerAuthorization: null,
};

/**
 * Works out the subscription from the payment log. Nothing here is stored:
 * the interval is that of the newest fulfilment, and access runs to the
 * furthest period end any fulfilment bought. Pure, so it can be tested with
 * any date.
 */
export function deriveState(fulfilments: Fulfilment[], settings: Settings | null, at: Date): SubscriptionState {
  const s = settings ?? NO_SETTINGS;
  if (fulfilments.length === 0) {
    return { entitled: false, status: "free", interval: null, periodStart: null, periodEnd: null, cancelAtPeriodEnd: false, cancellationReason: null, pendingInterval: null };
  }
  const newest = fulfilments.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
  const periodEnd = new Date(Math.max(...fulfilments.map((f) => f.periodEnd.getTime())));
  const entitled = periodEnd > at;
  return {
    entitled,
    status: !entitled ? "expired" : s.cancelAtPeriodEnd ? "cancelling" : "active",
    interval: newest.interval,
    periodStart: newest.periodStart,
    periodEnd,
    cancelAtPeriodEnd: entitled && s.cancelAtPeriodEnd,
    cancellationReason: s.cancellationReason,
    pendingInterval: entitled ? s.pendingInterval : null,
  };
}

type Client = Prisma.TransactionClient | typeof db;

export async function loadFulfilments(userId: string, client: Client = db): Promise<Fulfilment[]> {
  const rows = await client.paymentEvent.findMany({
    where: { userId, type: "FULFILMENT" },
    orderBy: { createdAt: "asc" },
    select: { reference: true, interval: true, amountMinor: true, creditMinor: true, periodStart: true, periodEnd: true, createdAt: true },
  });
  // The database check constraint guarantees both dates exist on a FULFILMENT row.
  return rows.map((r) => ({ ...r, periodStart: r.periodStart!, periodEnd: r.periodEnd! }));
}

/** The current subscription for a user, derived from the log, plus the inputs it was derived from. */
export async function loadSubscription(userId: string, at: Date, client: Client = db) {
  const [fulfilments, settings] = await Promise.all([
    loadFulfilments(userId, client),
    client.subscription.findUnique({ where: { userId } }),
  ]);
  return { state: deriveState(fulfilments, settings, at), fulfilments, settings };
}
