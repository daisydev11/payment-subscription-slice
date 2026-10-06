import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { crossSiteRequest, errorResponse, getClientIp, limited, parseBody, requireUser } from "@/lib/http";
import { startCheckout } from "@/lib/billing/checkout";
import { checkoutSchema } from "@/lib/validation/billing";

export async function POST(request: Request) {
  const blocked = crossSiteRequest(request);
  if (blocked) return blocked;
  const auth = await requireUser();
  if (auth.response) return auth.response;

  // Each call creates a provider transaction, so it is limited per account and per address.
  const { checkoutByUser, checkoutByIp } = config.billing.rateLimits;
  const limitedResponse =
    (await limited("checkout-user", auth.user.id, checkoutByUser)) ?? (await limited("checkout-ip", getClientIp(request), checkoutByIp));
  if (limitedResponse) return limitedResponse;

  const body = await parseBody(request, checkoutSchema);
  if (body.response) return body.response;

  const result = await startCheckout(auth.user, body.data.interval);
  if (!result.ok) {
    return errorResponse(result.code === "PROVIDER_UNAVAILABLE" ? 502 : 409, result.code, result.message);
  }
  return NextResponse.json({ ok: true, authorizationUrl: result.authorizationUrl, reference: result.reference });
}
