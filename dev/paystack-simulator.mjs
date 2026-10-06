// Local stand-in for Paystack, for development and tests only.
// It implements the four Paystack behaviours this slice uses, with the same
// paths, payload shapes and webhook signature as the real API:
//   POST /transaction/initialize
//   GET  /transaction/verify/:reference
//   POST /transaction/charge_authorization
//   signed "charge.success" webhooks to APP_URL/api/webhooks/paystack
// plus a plain checkout page with Pay / Decline / Close buttons.
//
// Run:  node dev/paystack-simulator.mjs      (reads .env)
// Use:  set PAYSTACK_BASE_URL="http://localhost:4010" in .env
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

try {
  process.loadEnvFile(".env");
} catch {}
const PORT = Number(process.env.SIMULATOR_PORT ?? 4010);
const SECRET = process.env.PAYSTACK_SECRET_KEY ?? "";
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const SEND_WEBHOOKS = process.env.SIMULATOR_WEBHOOKS !== "off";

/** reference -> transaction */
const transactions = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
};
const publicData = (t) => ({
  status: t.status,
  reference: t.reference,
  amount: t.amount,
  currency: t.currency,
  paid_at: t.paid_at,
  channel: t.status === "success" ? "card" : null,
  gateway_response: t.status === "success" ? "Successful" : t.status === "failed" ? "Declined" : "The transaction was not completed",
  customer: { email: t.email },
  // Shaped like Paystack's authorization object, with made-up test values.
  authorization: t.status === "success" ? { authorization_code: `AUTH_sim${t.email.length}${t.email.charCodeAt(0)}`, reusable: true, last4: "4081", brand: "visa" } : null,
});

export async function sendWebhook(t) {
  const body = JSON.stringify({ event: "charge.success", data: publicData(t) });
  const signature = createHmac("sha512", SECRET).update(body).digest("hex");
  try {
    const r = await fetch(`${APP_URL}/api/webhooks/paystack`, { method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": signature }, body });
    console.log(`[simulator] webhook ${t.reference} -> ${r.status} ${await r.text()}`);
  } catch (e) {
    console.log(`[simulator] webhook ${t.reference} could not be delivered: ${e.message}`);
  }
}

const page = (t) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated Paystack checkout</title>
<body style="font:16px system-ui;max-width:420px;margin:60px auto;padding:0 16px">
<p style="color:#666">Paystack simulator (local development)</p>
<h1 style="font-size:1.4rem">${t.currency} ${(t.amount / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}</h1>
<p>${t.email}<br><small>${t.reference}</small></p>
<form method="post" style="display:grid;gap:10px">
<button name="action" value="pay" style="padding:12px;font:inherit">Pay</button>
<button name="action" value="decline" style="padding:12px;font:inherit">Decline card</button>
<button name="action" value="close" style="padding:12px;font:inherit">Close without paying</button>
</form></body>`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const isApi = url.pathname.startsWith("/transaction/");
  if (isApi && req.headers.authorization !== `Bearer ${SECRET}`) {
    return json(res, 401, { status: false, message: "Invalid key" });
  }

  if (req.method === "POST" && url.pathname === "/transaction/initialize") {
    const b = JSON.parse(await readBody(req));
    if (transactions.has(b.reference)) return json(res, 400, { status: false, message: "Duplicate Transaction Reference" });
    if (!Number.isInteger(Number(b.amount)) || Number(b.amount) <= 0) return json(res, 400, { status: false, message: "Invalid Amount Sent" });
    transactions.set(b.reference, { reference: b.reference, amount: Number(b.amount), currency: b.currency ?? "NGN", email: b.email, callback_url: b.callback_url, cancel_action: b.metadata?.cancel_action, status: "abandoned", paid_at: null });
    return json(res, 200, { status: true, message: "Authorization URL created", data: { authorization_url: `http://localhost:${PORT}/checkout/${b.reference}`, access_code: "sim", reference: b.reference } });
  }

  if (req.method === "GET" && url.pathname.startsWith("/transaction/verify/")) {
    const t = transactions.get(decodeURIComponent(url.pathname.split("/").pop()));
    if (!t) return json(res, 400, { status: false, message: "Transaction reference not found" });
    return json(res, 200, { status: true, message: "Verification successful", data: publicData(t) });
  }

  if (req.method === "POST" && url.pathname === "/transaction/charge_authorization") {
    const b = JSON.parse(await readBody(req));
    if (transactions.has(b.reference)) return json(res, 400, { status: false, message: "Duplicate Transaction Reference" });
    const ok = String(b.authorization_code).startsWith("AUTH_sim");
    const t = { reference: b.reference, amount: Number(b.amount), currency: b.currency ?? "NGN", email: b.email, status: ok ? "success" : "failed", paid_at: ok ? new Date().toISOString() : null };
    transactions.set(b.reference, t);
    if (ok && SEND_WEBHOOKS) setTimeout(() => sendWebhook(t), 300);
    return json(res, 200, { status: true, message: "Charge attempted", data: publicData(t) });
  }

  const checkout = url.pathname.match(/^\/checkout\/([^/]+)$/);
  if (checkout) {
    const t = transactions.get(checkout[1]);
    if (!t) return json(res, 404, { status: false, message: "Unknown transaction" });
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page(t));
    }
    const action = new URLSearchParams(await readBody(req)).get("action");
    if (action === "pay" && t.status !== "success") {
      t.status = "success";
      t.paid_at = new Date().toISOString();
      if (SEND_WEBHOOKS) sendWebhook(t);
    } else if (action === "decline") t.status = "failed";
    const back = action === "close" && t.cancel_action ? t.cancel_action : `${t.callback_url}?trxref=${t.reference}&reference=${t.reference}`;
    res.writeHead(302, { Location: back });
    return res.end();
  }

  // Test helper: deliver the webhook for a reference again, exactly as before.
  const resend = url.pathname.match(/^\/_simulator\/resend-webhook\/([^/]+)$/);
  if (req.method === "POST" && resend) {
    const t = transactions.get(resend[1]);
    if (!t || t.status !== "success") return json(res, 404, { status: false, message: "No successful transaction with that reference" });
    await sendWebhook(t);
    return json(res, 200, { status: true, message: "Webhook sent again" });
  }

  json(res, 404, { status: false, message: "Not found" });
}).listen(PORT, () => console.log(`[simulator] Paystack simulator on http://localhost:${PORT} -> webhooks to ${APP_URL}${SEND_WEBHOOKS ? "" : " (webhooks off)"}`));
