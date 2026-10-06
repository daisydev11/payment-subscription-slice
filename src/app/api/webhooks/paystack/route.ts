import { NextResponse } from "next/server";
import { isValidWebhookSignature } from "@/lib/billing/paystack";
import { settlePayment } from "@/lib/billing/settle";

export async function POST(request: Request) {
  // The signature covers the exact bytes sent, so the body is read as text
  // and verified BEFORE it is parsed or anything else happens.
  const rawBody = await request.text();
  if (!isValidWebhookSignature(rawBody, request.headers.get("x-paystack-signature"))) {
    return NextResponse.json({ error: { code: "INVALID_SIGNATURE", message: "Signature check failed." } }, { status: 401 });
  }

  let event: { event?: string; data?: { reference?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: { code: "INVALID_JSON", message: "Body is not JSON." } }, { status: 400 });
  }

  let outcome = "ignored";
  if (event.event === "charge.success" && typeof event.data?.reference === "string") {
    // Even a correctly signed payload is only a prompt: settlePayment asks the
    // provider for the facts and is idempotent on the reference.
    outcome = (await settlePayment(event.data.reference, "WEBHOOK")).outcome;
  }
  // 200 tells the provider to stop retrying, including for duplicates.
  return NextResponse.json({ received: true, outcome });
}
