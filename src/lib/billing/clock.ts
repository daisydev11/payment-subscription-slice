/**
 * The billing clock. In development it can be moved forward with
 * CLOCK_OFFSET_DAYS so that "day 12 of a cycle" or "the period has ended" can
 * be demonstrated without waiting. It is ignored in production.
 */
export function now(): Date {
  const offsetDays = process.env.NODE_ENV === "production" ? 0 : Number(process.env.CLOCK_OFFSET_DAYS ?? 0);
  return new Date(Date.now() + (Number.isFinite(offsetDays) ? offsetDays : 0) * 86_400_000);
}
