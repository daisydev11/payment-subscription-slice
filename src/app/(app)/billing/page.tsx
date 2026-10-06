import Link from "next/link";
import { redirect } from "next/navigation";
import { CancelControl } from "@/components/billing/CancelControl";
import { config } from "@/lib/config";
import { getSessionUser } from "@/lib/auth/session";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";
import { formatDate, formatMoney } from "@/lib/billing/money";

const STATUS_LABEL = { free: "No subscription", active: "Active", cancelling: "Cancelled, access continues", expired: "Ended" } as const;

export default async function BillingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  const { state } = await loadSubscription(user.id, now());
  const { plans, currency } = config.billing;
  const end = state.periodEnd ? formatDate(state.periodEnd) : null;
  const nextInterval = state.pendingInterval ?? state.interval;

  return (
    <div className="stack">
      <h1>Billing</h1>
      <dl className="facts">
        <div>
          <dt>Plan</dt>
          <dd>{state.entitled && state.interval ? `Paid, ${plans[state.interval].label.toLowerCase()}` : "Free"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABEL[state.status]}</dd>
        </div>
        {state.status === "active" && end && nextInterval && (
          <div>
            <dt>Renews on</dt>
            <dd>
              {end}, at {formatMoney(plans[nextInterval].priceMinor, currency)}
              {state.pendingInterval && ` (switching to ${plans[state.pendingInterval].label.toLowerCase()})`}
            </dd>
          </div>
        )}
        {state.status === "cancelling" && end && (
          <div>
            <dt>Access until</dt>
            <dd>{end}. You will not be charged again.</dd>
          </div>
        )}
        {state.status === "expired" && end && (
          <div>
            <dt>Ended on</dt>
            <dd>{end}</dd>
          </div>
        )}
      </dl>

      {state.entitled ? (
        <CancelControl cancelled={state.cancelAtPeriodEnd} accessUntil={end ?? ""} hasReason={Boolean(state.cancellationReason)} />
      ) : (
        <Link className="button" href="/plans">
          See plans
        </Link>
      )}
    </div>
  );
}
