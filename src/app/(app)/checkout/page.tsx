import Link from "next/link";
import { redirect } from "next/navigation";
import { PayButton } from "@/components/billing/PayButton";
import { config } from "@/lib/config";
import { getSessionUser } from "@/lib/auth/session";
import { now } from "@/lib/billing/clock";
import { loadSubscription } from "@/lib/billing/entitlement";
import { formatMoney } from "@/lib/billing/money";
import { quoteCheckout } from "@/lib/billing/proration";
import { checkoutSchema } from "@/lib/validation/billing";

type Props = { searchParams: Promise<{ interval?: string }> };

// Checkout initiation: shows exactly what will be charged, then hands off to the provider.
export default async function CheckoutPage({ searchParams }: Props) {
  const user = await getSessionUser();
  if (!user) redirect("/signin");

  const parsed = checkoutSchema.safeParse(await searchParams);
  if (!parsed.success) {
    return (
      <div className="stack">
        <h1>Choose a plan first</h1>
        <p className="lede">This page needs a plan to check out.</p>
        <Link href="/plans">See plans</Link>
      </div>
    );
  }
  const { interval } = parsed.data;
  const at = now();
  const { state, fulfilments } = await loadSubscription(user.id, at);
  const quote = quoteCheckout(state, fulfilments, interval, at);

  if (!quote.ok) {
    return (
      <div className="stack">
        <h1>Nothing to pay</h1>
        <p className="lede">{quote.message}</p>
        <Link href="/plans">Back to plans</Link>
      </div>
    );
  }

  const label = config.billing.plans[interval].label;
  const money = (minor: number) => formatMoney(minor, quote.currency);
  return (
    <div className="stack">
      <h1>{quote.kind === "UPGRADE" ? "Upgrade to yearly" : `Subscribe: ${label.toLowerCase()}`}</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">{label} plan</th>
            <td>{money(quote.listPriceMinor)}</td>
          </tr>
          {quote.proration.map((line) => (
            <tr key={line.reference}>
              <th scope="row">
                Credit for unused monthly time
                <span className="hint">
                  {line.unusedDays} of {line.spanDays} days unused: {money(line.valueMinor)} × {line.unusedDays} ÷ {line.spanDays}, rounded down
                </span>
              </th>
              <td>−{money(line.creditMinor)}</td>
            </tr>
          ))}
          <tr className="total">
            <th scope="row">Due today</th>
            <td>{money(quote.amountMinor)}</td>
          </tr>
        </tbody>
      </table>
      {quote.kind === "UPGRADE" && <p className="hint">Your yearly period starts today and replaces the rest of this month.</p>}
      <PayButton interval={interval} />
      <p className="hint">You pay on Paystack&apos;s page. Card details never touch this application.</p>
      <Link href="/plans">Back to plans</Link>
    </div>
  );
}
