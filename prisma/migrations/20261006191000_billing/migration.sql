-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "PaymentEventType" AS ENUM ('INITIATION', 'VERIFICATION', 'FULFILMENT', 'FAILURE', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('CHECKOUT', 'RETURN', 'WEBHOOK', 'RENEWAL');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('SUBSCRIBE', 'UPGRADE', 'RENEWAL');

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "PaymentEventType" NOT NULL,
    "source" "PaymentSource" NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "creditMinor" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "userId" TEXT NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "pendingInterval" "BillingInterval",
    "providerAuthorization" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "PaymentEvent_userId_type_createdAt_idx" ON "PaymentEvent"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_reference_idx" ON "PaymentEvent"("reference");

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Everything below is written by hand: Prisma's schema language cannot
-- express partial unique indexes, check constraints, triggers or views.

-- Idempotency, keyed on the provider reference. A reference can be initiated
-- once, verified once and fulfilled once. A second webhook, a refreshed
-- return page or a retried job cannot insert a second row of these types.
CREATE UNIQUE INDEX "PaymentEvent_reference_initiation_key" ON "PaymentEvent"("reference") WHERE "type" = 'INITIATION';
CREATE UNIQUE INDEX "PaymentEvent_reference_verification_key" ON "PaymentEvent"("reference") WHERE "type" = 'VERIFICATION';
CREATE UNIQUE INDEX "PaymentEvent_reference_fulfilment_key" ON "PaymentEvent"("reference") WHERE "type" = 'FULFILMENT';

-- Money is whole minor units, never negative, with an ISO currency code beside it.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_amount_check" CHECK ("amountMinor" >= 0 AND "creditMinor" >= 0);
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- A fulfilment always states the period it bought, and nothing else does.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_period_check" CHECK (
  ("type" = 'FULFILMENT' AND "periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL AND "periodEnd" > "periodStart")
  OR ("type" <> 'FULFILMENT' AND "periodStart" IS NULL AND "periodEnd" IS NULL)
);

-- A cancellation always has a time, and a reason only exists for a cancellation.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_cancel_check" CHECK (
  ("cancelAtPeriodEnd" AND "cancelledAt" IS NOT NULL)
  OR (NOT "cancelAtPeriodEnd" AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
);

-- The payment log is append-only. History is what you show in a dispute, so
-- no code path, script or console session may rewrite it.
CREATE FUNCTION "payment_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PaymentEvent is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentEvent_append_only"
  BEFORE UPDATE OR DELETE ON "PaymentEvent"
  FOR EACH ROW EXECUTE FUNCTION "payment_event_append_only"();

-- The subscription as derived from the log, for reading in a database tool.
-- The application computes the same thing in src/lib/billing/entitlement.ts.
CREATE VIEW "CurrentSubscription" AS
SELECT DISTINCT ON (f."userId")
  f."userId",
  u."email",
  f."interval",
  f."periodStart",
  max(f."periodEnd") OVER (PARTITION BY f."userId") AS "periodEnd",
  f."reference" AS "lastReference",
  COALESCE(s."cancelAtPeriodEnd", false) AS "cancelAtPeriodEnd",
  s."pendingInterval",
  s."cancellationReason"
FROM "PaymentEvent" f
JOIN "User" u ON u."id" = f."userId"
LEFT JOIN "Subscription" s ON s."userId" = f."userId"
WHERE f."type" = 'FULFILMENT'
ORDER BY f."userId", f."createdAt" DESC;
