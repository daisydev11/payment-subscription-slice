import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { crossSiteRequest, errorResponse, requireUser } from "@/lib/http";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";

/** Schedule yearly -> monthly for the end of the current period. Nothing is charged now. */
export async function POST(request: Request) {
  const blocked = crossSiteRequest(request);
  if (blocked) return blocked;
  const auth = await requireUser();
  if (auth.response) return auth.response;

  const { state } = await loadSubscription(auth.user.id, now());
  if (!state.entitled || state.interval !== "YEARLY") {
    return errorResponse(409, "NOT_ON_YEARLY", "Only an active yearly plan can be switched to monthly.");
  }
  if (state.cancelAtPeriodEnd) {
    return errorResponse(409, "CANCELLED", "This subscription is set to end. Resume it before changing plan.");
  }
  await db.subscription.upsert({
    where: { userId: auth.user.id },
    create: { userId: auth.user.id, pendingInterval: "MONTHLY" },
    update: { pendingInterval: "MONTHLY" },
  });
  return NextResponse.json({ ok: true, pendingInterval: "MONTHLY", effectiveAt: state.periodEnd });
}

/** Undo a scheduled downgrade. */
export async function DELETE(request: Request) {
  const blocked = crossSiteRequest(request);
  if (blocked) return blocked;
  const auth = await requireUser();
  if (auth.response) return auth.response;
  await db.subscription.updateMany({ where: { userId: auth.user.id }, data: { pendingInterval: null } });
  return NextResponse.json({ ok: true, pendingInterval: null });
}
