"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** POST/DELETE to a billing endpoint, surface its error message, refresh server data on success. */
export function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(endpoint: string, body?: unknown, method: "POST" | "DELETE" = "POST"): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        router.refresh();
        return true;
      }
      setError(data?.error?.fields?.reason ?? data?.error?.message ?? "That did not work. Nothing was changed.");
    } catch {
      setError("Could not reach the server. Nothing was changed.");
    } finally {
      setPending(false);
    }
    return false;
  }

  return { run, pending, error };
}
