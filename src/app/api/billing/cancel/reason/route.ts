import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { crossSiteRequest, errorResponse, parseBody, requireUser } from "@/lib/http";
import { cancellationReasonSchema } from "@/lib/validation/billing";

/** The optional "why are you leaving?" answer, saved after the cancellation itself. */
export async function POST(request: Request) {
  const blocked = crossSiteRequest(request);
  if (blocked) return blocked;
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const body = await parseBody(request, cancellationReasonSchema);
  if (body.response) return body.response;

  const saved = await db.subscription.updateMany({
    where: { userId: auth.user.id, cancelAtPeriodEnd: true },
    data: { cancellationReason: body.data.reason },
  });
  if (saved.count !== 1) return errorResponse(409, "NOT_CANCELLED", "There is no cancellation to attach a reason to.");
  return NextResponse.json({ ok: true });
}
