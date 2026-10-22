// Verifies the deployed integration without dumping credentials or contact data.
import { createHmac, randomBytes } from "node:crypto";
const required = [
  "PUBLIC_BASE_URL",
  "ADMIN_KEY",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Live verification blocked. Configure: " + missing.join(", "));
  process.exit(2);
}
let origin;
try {
  const u = new URL(process.env.PUBLIC_BASE_URL);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error();
  origin = u.origin;
} catch {
  console.error("PUBLIC_BASE_URL must be an HTTPS origin.");
  process.exit(2);
}
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  return response;
}
function check(condition, message) {
  if (!condition) throw Error(message);
  console.log("PASS " + message);
}
try {
  const health = await request(origin + "/api/health");
  check(
    health.ok && (await health.json()).ok === true,
    "HTTPS health endpoint",
  );
  const anonymous = await request(origin + "/api/deliveries");
  check(anonymous.status === 401, "Dispatcher data rejects anonymous access");
  const headers = { Authorization: "Bearer " + process.env.ADMIN_KEY };
  const authenticated = await request(origin + "/api/deliveries", { headers });
  check(authenticated.ok, "Dispatcher credential accepted");
  const challenge = randomBytes(16).toString("hex");
  const query = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN,
    "hub.challenge": challenge,
  });
  const handshake = await request(origin + "/webhooks/whatsapp?" + query);
  check(
    handshake.ok && (await handshake.text()) === challenge,
    "WhatsApp webhook verification",
  );
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [{ id: "asili-probe-" + challenge, status: "read" }],
            },
          },
        ],
      },
    ],
  });
  const receipt = await request(origin + "/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256":
        "sha256=" +
        createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
          .update(body)
          .digest("hex"),
    },
    body,
  });
  check(
    receipt.ok,
    "Signed webhook accepted (synthetic receipt, no customer changes)",
  );
  const rejected = await request(origin + "/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": "sha256=invalid",
    },
    body,
  });
  check(rejected.status === 403, "Invalid webhook signature rejected");
  const phone = await request(
    `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v23.0"}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=id`,
    {
      headers: { Authorization: "Bearer " + process.env.WHATSAPP_ACCESS_TOKEN },
    },
  );
  const phoneData = await phone.json();
  check(
    phone.ok && phoneData.id === process.env.WHATSAPP_PHONE_NUMBER_ID,
    "Meta phone-number access",
  );
  if (process.argv.includes("--send")) {
    if (
      process.env.ALLOW_LIVE_WHATSAPP_SEND !== "1" ||
      !/^\d+$/.test(process.env.WHATSAPP_LIVE_MESSAGE_ID || "") ||
      !/^\+[1-9]\d{7,14}$/.test(process.env.WHATSAPP_TEST_RECIPIENT || "")
    )
      throw Error(
        "Sending requires ALLOW_LIVE_WHATSAPP_SEND=1, WHATSAPP_LIVE_MESSAGE_ID, and opted-in WHATSAPP_TEST_RECIPIENT.",
      );
    const id = Number(process.env.WHATSAPP_LIVE_MESSAGE_ID),
      messages = await (
        await request(origin + "/api/messages", { headers })
      ).json();
    const message = messages.find((m) => m.id === id);
    if (
      !message ||
      message.state !== "pending" ||
      message.recipient !== process.env.WHATSAPP_TEST_RECIPIENT
    )
      throw Error(
        "Selected outbox message must be pending and match the authorized test recipient.",
      );
    const sent = await request(origin + "/api/messages/" + id + "/send", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });
    check(sent.ok, "Meta accepted the authorized test send");
    let delivered = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      const updates = await (
        await request(origin + "/api/messages", { headers })
      ).json();
      const m = updates.find((m) => m.id === id);
      if (["delivered", "read"].includes(m?.state)) {
        delivered = true;
        break;
      }
      if (m?.state === "failed") break;
    }
    check(
      delivered,
      "Real delivery/read receipt received through Meta webhook",
    );
  } else
    console.log(
      "NOT RUN: actual WhatsApp send/receipt. Use --send only with an opted-in test recipient and the documented safeguards.",
    );
} catch (error) {
  console.error(
    "FAIL " +
      (error instanceof TypeError
        ? "Network or TLS request failed; no secrets logged."
        : error.message),
  );
  process.exitCode = 1;
}
