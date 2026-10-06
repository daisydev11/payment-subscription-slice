import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { crossSiteRequest, errorResponse, parseBody, requireUser } from "@/lib/http";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";
import { cancelSchema } from "@/lib/validation/billing";

export async function POST(request: Request) {
  const blocked = crossSiteRequest(request);
  if (blocked) return blocked;
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const body = await parseBody(request, cancelSchema);
  if (body.response) return body.response;

  const at = now();
  const { state } = await loadSubscription(auth.user.id, at);
  if (!state.entitled) return errorResponse(409, "NOT_SUBSCRIBED", "There is no active subscription to cancel.");
  if (state.cancelAtPeriodEnd) return errorResponse(409, "ALREADY_CANCELLED", "This subscription is already set to end.");

  // Cancelling only stops the next renewal. The payment log is untouched, so
  // the period already paid for stays exactly as it was.
  const flags = { cancelAtPeriodEnd: true, cancelledAt: at, pendingInterval: null };
  await db.subscription.upsert({ where: { userId: auth.user.id }, create: { userId: auth.user.id, ...flags }, update: flags });
  return NextResponse.json({ ok: true, accessUntil: state.periodEnd });
}
