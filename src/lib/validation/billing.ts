import { z } from "zod";
import { config } from "@/lib/config";

export const checkoutSchema = z.object({
  interval: z.enum(["MONTHLY", "YEARLY"], { errorMap: () => ({ message: "Choose monthly or yearly." }) }),
});

// Cancelling needs an explicit confirmation in the request itself, so the
// confirmation step cannot be skipped by calling the endpoint directly.
export const cancelSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: "Confirm that you want to cancel." }) }),
});

export const cancellationReasonSchema = z.object({
  reason: z
    .string({ required_error: "Enter a reason.", invalid_type_error: "Enter a reason." })
    .trim()
    .min(1, "Enter a reason.")
    .max(config.billing.cancellationReasonMaxLength, `Use at most ${config.billing.cancellationReasonMaxLength} characters.`),
});
