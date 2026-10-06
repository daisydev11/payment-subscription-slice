import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { loadSubscription } from "@/lib/billing/entitlement";
import type { Provider, ProviderPayment } from "@/lib/billing/paystack";
import { settlePayment } from "@/lib/billing/settle";

// Runs against the database in DATABASE_URL, with a fake provider.
// Payment rows cannot be deleted (the log is append-only), so each run uses fresh users.
const run = Date.now();
let counter = 0;

async function newUser() {
  return db.user.create({ data: { email: `settle-${run}-${++counter}@test.local`, name: "Test", passwordHash: "x", emailVerifiedAt: new Date() } });
}

async function initiate(userId: string, kind: "SUBSCRIBE" | "UPGRADE" = "SUBSCRIBE") {
  const reference = `pay-test${run}${++counter}`;
  await db.paymentEvent.create({
    data: { userId, reference, type: "INITIATION", source: "CHECKOUT", kind, interval: "YEARLY", amountMinor: 5_000_000, currency: "NGN", createdAt: new Date() },
  });
  return reference;
}

function providerSaying(payment: Partial<ProviderPayment>): Provider {
  const full: ProviderPayment = { status: "success", providerStatus: "success", amountMinor: 5_000_000, currency: "NGN", paidAt: new Date().toISOString(), channel: "card", gatewayResponse: "Successful", authorizationCode: "AUTH_test", ...payment };
  return { verify: async () => full, initialize: async () => ({ authorizationUrl: "" }), chargeAuthorization: async () => full };
}

const typesFor = async (reference: string) =>
  (await db.paymentEvent.findMany({ where: { reference }, select: { type: true } })).map((e) => e.type).sort();

afterAll(() => db.$disconnect());

describe("settlePayment", () => {
  it("fulfils a verified payment and records each stage as its own row", async () => {
    const user = await newUser();
    const reference = await initiate(user.id);
    expect((await settlePayment(reference, "RETURN", providerSaying({}))).outcome).toBe("fulfilled");
    expect(await typesFor(reference)).toEqual(["FULFILMENT", "INITIATION", "VERIFICATION"]);
    expect((await loadSubscription(user.id, new Date())).state).toMatchObject({ entitled: true, interval: "YEARLY" });
  });

  it("is idempotent: ten simultaneous webhooks fulfil once and record nine duplicates", async () => {
    const user = await newUser();
    const reference = await initiate(user.id);
    const results = await Promise.all(Array.from({ length: 10 }, () => settlePayment(reference, "WEBHOOK", providerSaying({}))));
    expect(results.filter((r) => r.outcome === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_fulfilled")).toHaveLength(9);
    const types = await typesFor(reference);
    expect(types.filter((t) => t === "FULFILMENT")).toHaveLength(1);
    expect(types.filter((t) => t === "VERIFICATION")).toHaveLength(1);
    expect(types.filter((t) => t === "DUPLICATE")).toHaveLength(9);
  });

  it("grants nothing for an unpaid checkout, and does not call it a failure", async () => {
    const user = await newUser();
    const reference = await initiate(user.id);
    const abandoned = providerSaying({ status: "abandoned", providerStatus: "abandoned" });
    expect(await settlePayment(reference, "RETURN", abandoned)).toMatchObject({ outcome: "failed", reason: "abandoned" });
    expect(await typesFor(reference)).toEqual(["INITIATION"]);
    // ...and the same reference can still be paid afterwards.
    expect((await settlePayment(reference, "WEBHOOK", providerSaying({}))).outcome).toBe("fulfilled");
  });

  it("records a declined payment once, however often we are told, and grants nothing", async () => {
    const user = await newUser();
    const reference = await initiate(user.id);
    const declined = providerSaying({ status: "failed", providerStatus: "failed", gatewayResponse: "Declined" });
    expect(await settlePayment(reference, "RETURN", declined)).toMatchObject({ outcome: "failed", reason: "failed" });
    await settlePayment(reference, "WEBHOOK", declined);
    expect(await typesFor(reference)).toEqual(["FAILURE", "INITIATION"]);
    expect((await loadSubscription(user.id, new Date())).state.entitled).toBe(false);
  });

  it("refuses a payment of the wrong amount, and keeps the evidence", async () => {
    const user = await newUser();
    const reference = await initiate(user.id);
    expect(await settlePayment(reference, "WEBHOOK", providerSaying({ amountMinor: 100 }))).toMatchObject({ outcome: "failed", reason: "amount_mismatch" });
    expect(await typesFor(reference)).toEqual(["FAILURE", "INITIATION", "VERIFICATION"]);
    expect((await loadSubscription(user.id, new Date())).state.entitled).toBe(false);
  });

  it("knows nothing about a reference we never initiated", async () => {
    expect((await settlePayment("pay-made-up-in-a-browser", "RETURN", providerSaying({}))).outcome).toBe("unknown");
  });

  it("paying for yearly twice at once gives two years, not one", async () => {
    const user = await newUser();
    const [a, b] = [await initiate(user.id), await initiate(user.id)];
    const outcomes = await Promise.all([settlePayment(a, "WEBHOOK", providerSaying({})), settlePayment(b, "WEBHOOK", providerSaying({}))]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["fulfilled", "fulfilled"]);
    const { state, fulfilments } = await loadSubscription(user.id, new Date());
    expect(fulfilments).toHaveLength(2);
    const [first, second] = fulfilments.sort((x, y) => x.periodStart.getTime() - y.periodStart.getTime());
    expect(second.periodStart).toEqual(first.periodEnd); // back to back, no overlap
    expect(state.periodEnd!.getUTCFullYear() - first.periodStart.getUTCFullYear()).toBe(2);
  });
});

describe("paying for the same upgrade twice", () => {
  it("starts the year once and extends it with the second payment", async () => {
    const user = await newUser();
    const start = new Date();
    await db.paymentEvent.create({
      data: { userId: user.id, reference: `pay-m${run}`, type: "FULFILMENT", source: "WEBHOOK", kind: "SUBSCRIBE", interval: "MONTHLY", amountMinor: 500_000, currency: "NGN", periodStart: start, periodEnd: new Date(start.getTime() + 30 * 86_400_000), createdAt: start },
    });
    const [a, b] = [await initiate(user.id, "UPGRADE"), await initiate(user.id, "UPGRADE")];
    await settlePayment(a, "WEBHOOK", providerSaying({}));
    await settlePayment(b, "WEBHOOK", providerSaying({}));
    const yearly = (await loadSubscription(user.id, new Date())).fulfilments.filter((f) => f.interval === "YEARLY");
    expect(yearly).toHaveLength(2);
    expect(yearly[1].periodStart).toEqual(yearly[0].periodEnd); // not the same year bought twice
  });
});

describe("payment log", () => {
  it("is append-only: the database refuses UPDATE and DELETE", async () => {
    const user = await newUser();
    const reference = await initiate(user.id);
    await expect(db.paymentEvent.updateMany({ where: { reference }, data: { amountMinor: 1 } })).rejects.toThrow(/append-only/);
    await expect(db.paymentEvent.deleteMany({ where: { reference } })).rejects.toThrow(/append-only/);
  });

  it("cannot hold two fulfilments for one reference", async () => {
    const user = await newUser();
    const reference = await initiate(user.id);
    const row = { userId: user.id, reference, type: "FULFILMENT" as const, source: "WEBHOOK" as const, kind: "SUBSCRIBE" as const, interval: "YEARLY" as const, amountMinor: 5_000_000, currency: "NGN", periodStart: new Date(), periodEnd: new Date(Date.now() + 1000), createdAt: new Date() };
    await db.paymentEvent.create({ data: row });
    await expect(db.paymentEvent.create({ data: row })).rejects.toMatchObject({ code: "P2002" });
  });

  it("cannot hold a negative amount, a bad currency or a fulfilment with no period", async () => {
    const user = await newUser();
    const base = { userId: user.id, reference: `pay-bad${run}`, type: "INITIATION" as const, source: "CHECKOUT" as const, kind: "SUBSCRIBE" as const, interval: "MONTHLY" as const, currency: "NGN", createdAt: new Date() };
    await expect(db.paymentEvent.create({ data: { ...base, amountMinor: -1 } })).rejects.toThrow();
    await expect(db.paymentEvent.create({ data: { ...base, amountMinor: 1, currency: "naira" } })).rejects.toThrow();
    await expect(db.paymentEvent.create({ data: { ...base, amountMinor: 1, type: "FULFILMENT" } })).rejects.toThrow();
  });
});
