"use client";

import Link from "next/link";

// Catches any unexpected error on any screen, so the payment path never ends on a blank page.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="centered">
      <main className="card stack">
        <h1>Something went wrong on our side</h1>
        <p className="lede">
          If you were paying, do not pay again yet. Your billing page shows what actually happened once the payment
          provider has confirmed it.
        </p>
        <button type="button" onClick={reset}>
          Try again
        </button>
        <Link href="/billing">Go to billing</Link>
      </main>
    </div>
  );
}
