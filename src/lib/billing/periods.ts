import type { BillingInterval } from "@prisma/client";

export const DAY_MS = 86_400_000;

/**
 * One calendar month or year later, in UTC. A start on the 31st clamps to the
 * last day of a shorter month (31 Jan -> 28/29 Feb) instead of spilling over.
 */
export function addInterval(start: Date, interval: BillingInterval): Date {
  const months = interval === "YEARLY" ? 12 : 1;
  const target = new Date(start);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target;
}

/** Length of a paid span in whole days. */
export function spanDays(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

/**
 * Days of a span not yet used at `at`. A day that has started counts as used
 * only once it is complete: on day 12 of 30, 11 full days have passed and 19
 * remain.
 */
export function unusedDays(start: Date, end: Date, at: Date): number {
  const total = spanDays(start, end);
  if (at <= start) return total;
  if (at >= end) return 0;
  return total - Math.floor((at.getTime() - start.getTime()) / DAY_MS);
}
