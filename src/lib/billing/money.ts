/** Formats minor units for display, e.g. 500000 NGN -> "NGN 5,000.00". Display only: maths stays in integers. */
export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency, currencyDisplay: "code" }).format(amountMinor / 100);
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
