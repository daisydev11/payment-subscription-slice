import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveState, type Fulfilment } from "@/lib/billing/entitlement";
import { isValidWebhookSignature } from "@/lib/billing/paystack";
import { addInterval, spanDays, unusedDays } from "@/lib/billing/periods";
import { prorationCredit, quoteCheckout } from "@/lib/billing/proration";

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const monthly = (start: string, over: Partial<Fulfilment> = {}): Fulfilment => ({
  reference: `pay-${start}`,
  interval: "MONTHLY",
  amountMinor: 500_000,
  creditMinor: 0,
  periodStart: utc(start),
  periodEnd: addInterval(utc(start), "MONTHLY"),
  createdAt: utc(start),
  ...over,
});

describe("periods", () => {
  it("adds a calendar month or year", () => {
    expect(addInterval(utc("2026-04-01"), "MONTHLY")).toEqual(utc("2026-05-01"));
    expect(addInterval(utc("2026-10-06"), "YEARLY")).toEqual(utc("2027-10-06"));
  });

  it("clamps to the end of a shorter month instead of spilling over", () => {
    expect(addInterval(utc("2027-01-31"), "MONTHLY")).toEqual(utc("2027-02-28"));
    expect(addInterval(utc("2028-02-29"), "YEARLY")).toEqual(utc("2029-02-28"));
  });

  it("counts unused days to the day", () => {
    const start = utc("2026-04-01");
    const end = utc("2026-05-01");
    expect(spanDays(start, end)).toBe(30);
    expect(unusedDays(start, end, start)).toBe(30);
    // Day 12 of the cycle: 11 full days have passed.
    expect(unusedDays(start, end, new Date("2026-04-12T15:30:00Z"))).toBe(19);
    expect(unusedDays(start, end, end)).toBe(0);
  });
});

describe("proration", () => {
  it("upgrade on day 12 of a 30-day cycle", () => {
    const paid = [monthly("2026-04-01")];
    const at = new Date("2026-04-12T09:00:00Z");
    const state = deriveState(paid, null, at);
    const quote = quoteCheckout(state, paid, "YEARLY", at);
    expect(quote).toMatchObject({
      ok: true,
      kind: "UPGRADE",
      listPriceMinor: 5_000_000,
      creditMinor: 316_666, // floor(500000 * 19 / 30)
      amountMinor: 4_683_334,
    });
  });

  it("rounds the credit down and never credits more than was paid", () => {
    const [line] = prorationCredit([monthly("2026-04-01")], utc("2026-04-01"));
    expect(line.creditMinor).toBe(500_000);
    const [late] = prorationCredit([monthly("2026-04-01")], new Date("2026-04-30T23:59:00Z"));
    expect(late).toMatchObject({ unusedDays: 1, creditMinor: 16_666 });
  });

  it("credits every unused monthly period when two were paid for", () => {
    const paid = [monthly("2026-04-01"), monthly("2026-05-01", { createdAt: new Date("2026-04-01T00:01:00Z") })];
    const lines = prorationCredit(paid, new Date("2026-04-12T09:00:00Z"));
    expect(lines.map((l) => l.creditMinor)).toEqual([316_666, 500_000]);
  });

  it("a free user pays list price", () => {
    const quote = quoteCheckout(deriveState([], null, utc("2026-04-01")), [], "MONTHLY", utc("2026-04-01"));
    expect(quote).toMatchObject({ ok: true, kind: "SUBSCRIBE", amountMinor: 500_000, creditMinor: 0 });
  });

  it("refuses to sell the plan you already have, and routes downgrades away from checkout", () => {
    const paid = [monthly("2026-04-01")];
    const at = utc("2026-04-05");
    expect(quoteCheckout(deriveState(paid, null, at), paid, "MONTHLY", at)).toMatchObject({ ok: false, code: "ALREADY_ON_PLAN" });
    const yearly = [monthly("2026-04-01", { interval: "YEARLY", periodEnd: utc("2027-04-01") })];
    expect(quoteCheckout(deriveState(yearly, null, at), yearly, "MONTHLY", at)).toMatchObject({ ok: false, code: "USE_DOWNGRADE" });
  });
});

describe("deriveState", () => {
  const settings = { cancelAtPeriodEnd: true, cancellationReason: null, pendingInterval: null, providerAuthorization: null };

  it("is free with no fulfilments", () => {
    expect(deriveState([], null, utc("2026-04-01"))).toMatchObject({ entitled: false, status: "free" });
  });

  it("a cancelled subscription keeps access until the period it paid for ends", () => {
    const paid = [monthly("2026-04-01")];
    expect(deriveState(paid, settings, utc("2026-04-20"))).toMatchObject({ entitled: true, status: "cancelling", periodEnd: utc("2026-05-01") });
    expect(deriveState(paid, settings, utc("2026-05-01"))).toMatchObject({ entitled: false, status: "expired" });
  });

  it("paying twice extends access rather than losing a payment", () => {
    const first = monthly("2026-04-01", { interval: "YEARLY", periodEnd: utc("2027-04-01") });
    const second = { ...first, reference: "pay-2", periodStart: utc("2027-04-01"), periodEnd: utc("2028-04-01"), createdAt: new Date("2026-04-01T00:00:30Z") };
    expect(deriveState([first, second], null, utc("2026-04-02"))).toMatchObject({ entitled: true, interval: "YEARLY", periodEnd: utc("2028-04-01") });
  });
});

describe("webhook signature", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "pay-abc" } });
  const sign = (text: string, key: string) => createHmac("sha512", key).update(text).digest("hex");

  it("accepts a body signed with our secret key and nothing else", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
    expect(isValidWebhookSignature(body, sign(body, "sk_test_unit"))).toBe(true);
    expect(isValidWebhookSignature(body, sign(body, "wrong_key"))).toBe(false);
    expect(isValidWebhookSignature(body.replace("pay-abc", "pay-xyz"), sign(body, "sk_test_unit"))).toBe(false);
    expect(isValidWebhookSignature(body, null)).toBe(false);
    expect(isValidWebhookSignature(body, "")).toBe(false);
  });
});
