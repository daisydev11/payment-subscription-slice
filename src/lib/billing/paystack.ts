import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

// Paystack publishes no official Node SDK, so this is a small typed client
// over their documented REST API. Every call has a timeout.

export class ProviderError extends Error {}

export type ProviderPayment = {
  /** Normalised from Paystack's status values. */
  status: "success" | "failed" | "abandoned" | "pending";
  providerStatus: string;
  amountMinor: number;
  currency: string;
  paidAt: string | null;
  channel: string | null;
  gatewayResponse: string | null;
  /** Reusable token for charging this customer again. Not card data. */
  authorizationCode: string | null;
};

function secretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new ProviderError("PAYSTACK_SECRET_KEY is not set.");
  return key;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const base = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co";
  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${secretKey()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.billing.providerTimeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    throw new ProviderError(`Payment provider unreachable: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const json = (await response.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!response.ok || !json?.status || !json.data) {
    throw new ProviderError(`Payment provider refused the request: ${json?.message ?? `HTTP ${response.status}`}`);
  }
  return json.data;
}

type RawTransaction = {
  status: string;
  amount: number;
  currency: string;
  paid_at?: string | null;
  channel?: string | null;
  gateway_response?: string | null;
  authorization?: { authorization_code?: string; reusable?: boolean } | null;
};

function normalise(raw: RawTransaction): ProviderPayment {
  const status =
    raw.status === "success" ? "success" : raw.status === "failed" || raw.status === "reversed" ? "failed" : raw.status === "abandoned" ? "abandoned" : "pending";
  // Only the token is kept from the authorization object. The card's last
  // four digits, expiry, brand and bank are deliberately dropped here, so
  // they can never reach our database or logs.
  const reusable = raw.authorization?.reusable ? raw.authorization.authorization_code ?? null : null;
  return {
    status,
    providerStatus: raw.status,
    amountMinor: raw.amount,
    currency: raw.currency,
    paidAt: raw.paid_at ?? null,
    channel: raw.channel ?? null,
    gatewayResponse: raw.gateway_response ?? null,
    authorizationCode: reusable,
  };
}

export const paystack = {
  /** Asks Paystack to open a checkout. Returns the hosted page the user pays on. */
  async initialize(input: { email: string; amountMinor: number; currency: string; reference: string; callbackUrl: string; cancelUrl: string }) {
    const data = await call<{ authorization_url: string }>("POST", "/transaction/initialize", {
      email: input.email,
      amount: input.amountMinor,
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: { cancel_action: input.cancelUrl },
    });
    return { authorizationUrl: data.authorization_url };
  },

  /** Server-to-server check of what actually happened to a reference. */
  async verify(reference: string): Promise<ProviderPayment> {
    return normalise(await call<RawTransaction>("GET", `/transaction/verify/${encodeURIComponent(reference)}`));
  },

  /** Charges a returning customer using the stored token (renewals). */
  async chargeAuthorization(input: { email: string; amountMinor: number; currency: string; reference: string; authorizationCode: string }): Promise<ProviderPayment> {
    return normalise(
      await call<RawTransaction>("POST", "/transaction/charge_authorization", {
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        authorization_code: input.authorizationCode,
      }),
    );
  },
};

export type Provider = typeof paystack;

/**
 * Paystack signs each webhook: HMAC-SHA512 of the exact raw body, keyed with
 * our secret key, hex encoded in the x-paystack-signature header.
 */
export function isValidWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha512", secretKey()).update(rawBody).digest("hex"));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
