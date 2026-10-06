"use client";

import { useEffect, useState } from "react";

export function PayButton({ interval }: { interval: "MONTHLY" | "YEARLY" }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryIn, setRetryIn] = useState(0);

  useEffect(() => {
    if (retryIn <= 0) return;
    const timer = setTimeout(() => setRetryIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryIn]);

  async function pay() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.authorizationUrl) {
        window.location.assign(data.authorizationUrl); // hand off to the provider; stay "pending" until we leave
        return;
      }
      if (data?.error?.retryAfterSeconds) setRetryIn(data.error.retryAfterSeconds);
      setError(data?.error?.message ?? "Could not start the payment. You have not been charged.");
    } catch {
      setError("Could not reach the server. You have not been charged. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <button type="button" onClick={pay} disabled={pending || retryIn > 0}>
        {pending ? "Opening Paystack…" : retryIn > 0 ? `Try again in ${retryIn}s` : "Pay with Paystack"}
      </button>
    </>
  );
}
