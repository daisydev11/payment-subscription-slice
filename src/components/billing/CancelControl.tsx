"use client";

import { useId, useState } from "react";
import { useAction } from "@/components/billing/useAction";

type Props = { cancelled: boolean; accessUntil: string; hasReason: boolean };

/** Cancel with a confirmation step, then an optional "why?" prompt. Or resume, if already cancelled. */
export function CancelControl({ cancelled, accessUntil, hasReason }: Props) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const [askReason, setAskReason] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();

  const errorMessage = action.error && (
    <p className="alert" role="alert">
      {action.error}
    </p>
  );

  if (cancelled) {
    return (
      <div className="stack">
        {askReason && !hasReason && (
          <form
            className="panel"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await action.run("/api/billing/cancel/reason", { reason })) setAskReason(false);
            }}
          >
            <div className="field">
              <label htmlFor={reasonId}>What made you cancel? (optional)</label>
              <textarea id={reasonId} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="row">
              <button type="submit" disabled={action.pending || !reason.trim()}>
                {action.pending ? "Sending…" : "Send"}
              </button>
              <button type="button" className="secondary" onClick={() => setAskReason(false)}>
                Skip
              </button>
            </div>
          </form>
        )}
        {errorMessage}
        <button type="button" className="secondary" disabled={action.pending} onClick={() => action.run("/api/billing/resume")}>
          Resume subscription
        </button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="panel stack" role="group" aria-label="Confirm cancellation">
        <p>
          <strong>Cancel your subscription?</strong> You keep access until {accessUntil}, because that time is already
          paid for. You will not be charged again.
        </p>
        {errorMessage}
        <div className="row">
          <button
            type="button"
            className="danger"
            disabled={action.pending}
            onClick={async () => {
              if (await action.run("/api/billing/cancel", { confirm: true })) {
                setConfirming(false);
                setAskReason(true);
              }
            }}
          >
            {action.pending ? "Cancelling…" : "Yes, cancel"}
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(false)}>
            Keep subscription
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" className="secondary" onClick={() => setConfirming(true)}>
      Cancel subscription
    </button>
  );
}
