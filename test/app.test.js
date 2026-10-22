import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApp } from "../server.js";
async function fixture(t, options = {}) {
  const app = createApp({
      dbPath: ":memory:",
      adminKey: "test-key",
      ...options,
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.close();
    app.locals.db.close();
  });
  return async (path, body, auth = true, method, headers = {}) => {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method: method || (body ? "POST" : "GET"),
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "Bearer test-key" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    let data;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data };
  };
}
const order = {
  senderName: "Shop",
  senderPhone: "+250788000001",
  customerName: "Customer",
  customerPhone: "+250788000002",
  riderName: "Rider",
  riderPhone: "+250788000003",
  description: "Small parcel",
  pickup: { label: "Kigali centre", lat: -1.94, lng: 30.06 },
  dropoff: { label: "Kimironko", lat: -1.93, lng: 30.12 },
};
test("dispatcher authentication and validated order creation", async (t) => {
  const req = await fixture(t);
  assert.equal((await req("/api/deliveries", null, false)).status, 401);
  assert.equal(
    (await req("/api/deliveries", { ...order, customerPhone: "invalid" }))
      .status,
    400,
  );
  assert.equal(
    (
      await req("/api/deliveries", {
        ...order,
        pickup: { label: "x", lat: 100, lng: 20 },
      })
    ).status,
    400,
  );
  const d = await req("/api/deliveries", order);
  assert.equal(d.status, 201);
  assert.equal(d.data.status, "assigned");
  assert.equal((await req("/api/messages")).data.length, 2);
});
test("end-to-end pickup, GPS, transit and receipt with private customer tracking", async (t) => {
  const req = await fixture(t),
    { data: d } = await req("/api/deliveries", order),
    r = "/api/rider/" + d.riderToken;
  assert.equal((await req("/api/track/invalid", null, false)).status, 404);
  const tracked = (await req("/api/track/" + d.trackingToken, null, false))
    .data;
  for (const field of [
    "senderPhone",
    "customerPhone",
    "riderToken",
    "trackingToken",
  ])
    assert.equal(tracked[field], undefined);
  assert.equal(
    (await req(r + "/status", { status: "delivered" }, false)).status,
    409,
  );
  assert.equal(
    (await req(r + "/location", { lat: -1.941, lng: 30.08 }, false)).status,
    200,
  );
  assert.equal(
    (await req("/api/track/" + d.trackingToken, null, false)).data.location.lng,
    30.08,
  );
  for (const status of ["at_pickup", "picked_up", "in_transit"])
    assert.equal((await req(r + "/status", { status }, false)).status, 200);
  assert.equal(
    (await req(r + "/status", { status: "delivered" }, false)).status,
    400,
  );
  const delivered = await req(
    r + "/status",
    { status: "delivered", receivedBy: "Customer" },
    false,
  );
  assert.equal(delivered.data.proof.receivedBy, "Customer");
  assert.equal(
    (await req(r + "/location", { lat: 0, lng: 0 }, false)).status,
    409,
  );
  assert.equal(
    (
      await req(
        r + "/status",
        { status: "delivered", receivedBy: "Again" },
        false,
      )
    ).status,
    409,
  );
  assert.equal((await req("/api/messages")).data.length, 10);
  assert.equal((await req("/api/messages/1/send", {}, true)).status, 409);
});
test("cancelled deliveries stop rider updates", async (t) => {
  const req = await fixture(t),
    { data: d } = await req("/api/deliveries", order);
  assert.equal(
    (await req("/api/deliveries/" + d.id + "/cancel", {})).status,
    200,
  );
  assert.equal(
    (
      await req(
        "/api/rider/" + d.riderToken + "/status",
        { status: "at_pickup" },
        false,
      )
    ).status,
    409,
  );
});
test("WhatsApp signature verification", async (t) => {
  process.env.WHATSAPP_APP_SECRET = "test-secret";
  t.after(() => delete process.env.WHATSAPP_APP_SECRET);
  const req = await fixture(t);
  assert.equal(
    (await req("/webhooks/whatsapp", { entry: [] }, false)).status,
    403,
  );
});

function whatsappEnv(t) {
  const config = {
    WHATSAPP_ACCESS_TOKEN: "test-only-not-a-real-token",
    WHATSAPP_PHONE_NUMBER_ID: "12345",
    WHATSAPP_APP_SECRET: "test-secret",
    WHATSAPP_VERIFY_TOKEN: "verify-test",
    WHATSAPP_TEMPLATE_NAME: "asili_delivery_update",
  };
  const old = Object.fromEntries(
    Object.keys(config).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, config);
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
test("WhatsApp template send, duplicate protection and signed read receipt", async (t) => {
  whatsappEnv(t);
  let sent;
  const req = await fixture(t, {
    sendRequest: async (url, options) => {
      assert.match(url, /graph.facebook.com/);
      sent = JSON.parse(options.body);
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.test" }] }),
        { status: 200 },
      );
    },
  });
  const { data: d } = await req("/api/deliveries", order);
  assert.equal((await req("/api/messages/1/send", {})).status, 200);
  assert.equal(sent.type, "template");
  assert.equal(sent.to, "250788000001");
  assert.equal(sent.template.components[0].parameters[0].text, d.id);
  assert.equal(sent.template.components[0].parameters[1].text, "assigned");
  assert.ok(
    sent.template.components[0].parameters[2].text.endsWith(d.trackingToken),
  );
  assert.equal((await req("/api/messages/1/send", {})).status, 409);
  for (const status of ["read", "sent"]) {
    const body = {
      entry: [
        { changes: [{ value: { statuses: [{ id: "wamid.test", status }] } }] },
      ],
    };
    const signature =
      "sha256=" +
      createHmac("sha256", "test-secret")
        .update(JSON.stringify(body))
        .digest("hex");
    assert.equal(
      (
        await req("/webhooks/whatsapp", body, false, "POST", {
          "x-hub-signature-256": signature,
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (await req("/api/messages")).data.find((m) => m.id === 1).state,
    "read",
  );
  assert.equal(
    (
      await req(
        "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=test",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await req(
        "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test",
      )
    ).status,
    403,
  );
});
test("WhatsApp timeout remains unknown and is not blindly resent", async (t) => {
  whatsappEnv(t);
  const req = await fixture(t, {
    sendRequest: async () => {
      throw Error("timeout");
    },
  });
  await req("/api/deliveries", order);
  assert.equal((await req("/api/messages/1/send", {})).status, 502);
  assert.equal(
    (await req("/api/messages")).data.find((m) => m.id === 1).state,
    "unknown",
  );
  assert.equal((await req("/api/messages/1/send", {})).status, 409);
});
test("SQLite persists deliveries and queued messages across app restarts", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "asili-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "test.sqlite");
  const first = createApp({ dbPath, adminKey: "test-key" });
  const server = first.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/deliveries`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify(order),
    },
  );
  assert.equal(response.status, 201);
  const delivery = await response.json();
  await new Promise((r) => server.close(r));
  first.locals.db.close();
  const second = createApp({ dbPath, adminKey: "test-key" });
  try {
    assert.equal(
      JSON.parse(
        second.locals.db
          .prepare("SELECT data FROM deliveries WHERE id=?")
          .get(delivery.id).data,
      ).status,
      "assigned",
    );
    assert.equal(
      second.locals.db.prepare("SELECT COUNT(*) as count FROM messages").get()
        .count,
      2,
    );
  } finally {
    second.locals.db.close();
  }
});
