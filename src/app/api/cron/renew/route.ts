import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runRenewals } from "@/lib/billing/renewals";

/**
 * Renewal job. Meant to be called once a day by a scheduler:
 *   curl -X POST $APP_URL/api/cron/renew -H "Authorization: Bearer $CRON_SECRET"
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing or wrong job secret." } }, { status: 401 });
  }
  return NextResponse.json({ ok: true, renewals: await runRenewals() });
}
