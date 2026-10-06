import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";
import { formatDate } from "@/lib/billing/money";
import { settlePayment, type SettleResult } from "@/lib/billing/settle";

type Props = { searchParams: Promise<{ reference?: string; trxref?: string }> };

/**
 * Where the provider sends the user back. Arriving here proves nothing:
 * anyone can type this URL. The page takes the reference, checks it is this
 * user's own, and asks settlePayment to verify it with the provider.
 */
export default async function ReturnPage({ searchParams }: Props) {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  const params = await searchParams;
  const reference = params.reference ?? params.trxref;

  let result: SettleResult = { outcome: "unknown" };
  if (reference) {
    const mine = await db.paymentEvent.findFirst({ where: { reference, userId: user.id, type: "INITIATION" }, select: { id: true } });
    if (mine) result = await settlePayment(reference, "RETURN");
  }

  if (result.outcome === "fulfilled" || result.outcome === "already_fulfilled") {
    const { state } = await loadSubscription(user.id, now());
    return (
      <div className="stack">
        <h1>Payment confirmed</h1>
        <p className="lede">
          Your {state.interval?.toLowerCase()} plan is active{state.periodEnd ? ` until ${formatDate(state.periodEnd)}` : ""}.
        </p>
        <Link className="button" href="/billing">
          Go to billing
        </Link>
      </div>
    );
  }
  if (result.outcome === "pending") {
    return (
      <div className="stack">
        <h1>We are still confirming your payment</h1>
        <p className="lede">
          The payment provider has not confirmed it yet. Do not pay again. Your plan updates by itself as soon as it is
          confirmed.
        </p>
        <Link className="button" href={`/billing/return?reference=${encodeURIComponent(reference ?? "")}`}>
          Check again
        </Link>
        <Link href="/billing">Go to billing</Link>
      </div>
    );
  }
  if (result.outcome === "failed") {
    return (
      <div className="stack">
        <h1>The payment did not go through</h1>
        <p className="lede">
          {result.reason === "abandoned"
            ? "The checkout was closed before paying. You have not been charged."
            : result.reason === "amount_mismatch"
              ? "The amount received did not match the amount due, so the plan was not changed. Contact support with the reference below."
              : "The payment provider declined it. Your plan has not changed."}
        </p>
        <p className="hint">Reference: {reference}</p>
        <Link className="button" href="/plans">
          Try again
        </Link>
      </div>
    );
  }
  return (
    <div className="stack">
      <h1>We could not find that payment</h1>
      <p className="lede">There is no payment with that reference on your account. Your plan has not changed.</p>
      <Link className="button" href="/billing">
        Go to billing
      </Link>
    </div>
  );
}
