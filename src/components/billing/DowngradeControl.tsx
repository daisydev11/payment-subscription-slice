"use client";

import { useState } from "react";
import { useAction } from "@/components/billing/useAction";

/** Schedule (or undo) the switch from yearly to monthly at the end of the paid year. */
export function DowngradeControl({ pending, effectiveDate }: { pending: boolean; effectiveDate: string }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);

  const errorMessage = action.error && (
    <p className="alert" role="alert">
      {action.error}
    </p>
  );

  if (pending) {
    return (
      <div className="stack">
        <p className="badge">Starts {effectiveDate}</p>
        {errorMessage}
        <button type="button" className="secondary" disabled={action.pending} onClick={() => action.run("/api/billing/downgrade", undefined, "DELETE")}>
          Keep yearly
        </button>
      </div>
    );
  }
  if (confirming) {
    return (
      <div className="stack">
        <p className="hint">You stay on yearly until {effectiveDate}, then renew monthly. Nothing is charged today.</p>
        {errorMessage}
        <button
          type="button"
          disabled={action.pending}
          onClick={async () => {
            if (await action.run("/api/billing/downgrade")) setConfirming(false);
          }}
        >
          {action.pending ? "Saving…" : "Confirm switch"}
        </button>
        <button type="button" className="secondary" onClick={() => setConfirming(false)}>
          Not now
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="secondary" onClick={() => setConfirming(true)}>
      Switch to monthly
    </button>
  );
}
