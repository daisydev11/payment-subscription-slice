import Link from "next/link";
import { redirect } from "next/navigation";
import { DowngradeControl } from "@/components/billing/DowngradeControl";
import { config } from "@/lib/config";
import { getSessionUser } from "@/lib/auth/session";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";
import { formatDate, formatMoney } from "@/lib/billing/money";

export default async function PlansPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  const { state } = await loadSubscription(user.id, now());
  const { plans, currency } = config.billing;
  const current = state.entitled ? state.interval : "FREE";
  const until = state.periodEnd ? formatDate(state.periodEnd) : "";

  return (
    <>
      <h1>Plans</h1>
      <p className="lede">One paid plan, billed monthly or yearly.</p>
      <ul className="plans">
        <li className="plan" aria-current={current === "FREE" ? "true" : undefined}>
          <h2>Free</h2>
          <p className="price">{formatMoney(0, currency)}</p>
          {current === "FREE" ? <p className="badge">Current plan</p> : <p className="hint">You return to Free when a paid period ends without renewing.</p>}
        </li>

        <li className="plan" aria-current={current === "MONTHLY" ? "true" : undefined}>
          <h2>{plans.MONTHLY.label}</h2>
          <p className="price">
            {formatMoney(plans.MONTHLY.priceMinor, currency)} <span>per month</span>
          </p>
          {current === "MONTHLY" && <p className="badge">Current plan</p>}
          {current === "FREE" && (
            <Link className="button" href="/checkout?interval=MONTHLY">
              Choose monthly
            </Link>
          )}
          {current === "YEARLY" &&
            (state.cancelAtPeriodEnd ? (
              <p className="hint">Your subscription is set to end. Resume it in Billing to change plan.</p>
            ) : (
              <DowngradeControl pending={state.pendingInterval === "MONTHLY"} effectiveDate={until} />
            ))}
        </li>

        <li className="plan" aria-current={current === "YEARLY" ? "true" : undefined}>
          <h2>{plans.YEARLY.label}</h2>
          <p className="price">
            {formatMoney(plans.YEARLY.priceMinor, currency)} <span>per year</span>
          </p>
          {current === "YEARLY" && <p className="badge">Current plan</p>}
          {current === "FREE" && (
            <Link className="button" href="/checkout?interval=YEARLY">
              Choose yearly
            </Link>
          )}
          {current === "MONTHLY" && (
            <>
              <Link className="button" href="/checkout?interval=YEARLY">
                Upgrade to yearly
              </Link>
              <p className="hint">You pay the yearly price less a credit for the unused days of this month.</p>
            </>
          )}
        </li>
      </ul>
    </>
  );
}
