import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { crossSiteRequest, errorResponse, requireUser } from "@/lib/http";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";

/** Undo a cancellation while the paid period is still running. */
export async function POST(request: Request) {
  const blocked = crossSiteRequest(request);
  if (blocked) return blocked;
  const auth = await requireUser();
  if (auth.response) return auth.response;

  const { state } = await loadSubscription(auth.user.id, now());
  if (!state.entitled || !state.cancelAtPeriodEnd) {
    return errorResponse(409, "NOT_CANCELLED", "There is no pending cancellation to undo.");
  }
  await db.subscription.updateMany({
    where: { userId: auth.user.id },
    data: { cancelAtPeriodEnd: false, cancelledAt: null, cancellationReason: null },
  });
  return NextResponse.json({ ok: true });
}
