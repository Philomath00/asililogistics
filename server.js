import express from "express";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const token = () => randomBytes(24).toString("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createApp({
  dbPath = process.env.DB_PATH || "data/asili.sqlite",
  adminKey = process.env.ADMIN_KEY,
  baseUrl = process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "http://localhost:3000",
  sendRequest = fetch,
} = {}) {
  if (
    process.env.NODE_ENV === "production" &&
    (!adminKey || !baseUrl.startsWith("https://"))
  )
    throw Error("Production requires ADMIN_KEY and HTTPS PUBLIC_BASE_URL");
  if (dbPath !== ":memory:")
    mkdirSync(resolve(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, delivery TEXT, recipient TEXT, body TEXT, state TEXT, provider TEXT, created TEXT);`,
  );
  if (
    !adminKey &&
    process.env.HOST &&
    !["127.0.0.1", "localhost", "::1"].includes(process.env.HOST)
  )
    throw Error("Set ADMIN_KEY before binding a public interface");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin");
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(
    express.json({
      limit: "32kb",
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  const get = (id) => {
    const r = db.prepare("SELECT data FROM deliveries WHERE id=?").get(id);
    return r ? JSON.parse(r.data) : null;
  };
  const save = (d) =>
    db
      .prepare("INSERT OR REPLACE INTO deliveries VALUES (?,?)")
      .run(d.id, JSON.stringify(d));
  const all = () =>
    db
      .prepare("SELECT data FROM deliveries ORDER BY rowid DESC")
      .all()
      .map((x) => JSON.parse(x.data));
  const now = () => new Date().toISOString();
  const enqueue = (d) => {
    for (const recipient of new Set([d.senderPhone, d.customerPhone]))
      db.prepare(
        "INSERT INTO messages(delivery,recipient,body,state,created) VALUES (?,?,?,?,?)",
      ).run(
        d.id,
        recipient,
        `Asili delivery ${d.id}: ${d.status.replaceAll("_", " ")}. Track: ${baseUrl}/?track=${d.trackingToken}`,
        "pending",
        now(),
      );
  };
  const saveWithUpdates = (d) => {
    db.exec("BEGIN");
    try {
      save(d);
      enqueue(d);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const auth = (req, res, next) => {
    if (!adminKey) {
      if (process.env.NODE_ENV === "production") return res.sendStatus(503);
      return next();
    }
    if (!equal(req.headers.authorization, `Bearer ${adminKey}`))
      return res.status(401).json({ error: "Dispatcher key required" });
    next();
  };
  const safe = (d) => ({
    id: d.id,
    status: d.status,
    pickup: d.pickup,
    dropoff: d.dropoff,
    riderName: d.riderName,
    location: d.location,
    history: d.history,
    createdAt: d.createdAt,
    proof: d.proof,
  });
  const coord = (v) =>
    v &&
    Number.isFinite(v.lat) &&
    Number.isFinite(v.lng) &&
    Math.abs(v.lat) <= 90 &&
    Math.abs(v.lng) <= 180;
  const text = (v, max = 180) =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const phone = (v) => typeof v === "string" && /^\+[1-9]\d{7,14}$/.test(v);
  app.get("/api/health", (req, res) =>
    res.json({
      ok: true,
      demo: !adminKey,
      whatsapp: process.env.WHATSAPP_ACCESS_TOKEN ? "configured" : "demo",
    }),
  );
  app.get("/api/deliveries", auth, (req, res) => res.json(all()));
  app.post("/api/deliveries", auth, (req, res) => {
    const b = req.body;
    if (
      ![
        "senderName",
        "customerName",
        "riderName",
        "riderPhone",
        "description",
      ].every((k) => text(b[k])) ||
      !phone(b.senderPhone) ||
      !phone(b.customerPhone) ||
      !phone(b.riderPhone) ||
      ![b.pickup, b.dropoff].every((p) => coord(p) && text(p.label))
    )
      return res.status(400).json({
        error:
          "Provide names, international phone numbers, parcel details and valid map coordinates.",
      });
    const d = {
      ...Object.fromEntries(
        [
          "senderName",
          "senderPhone",
          "customerName",
          "customerPhone",
          "riderName",
          "riderPhone",
          "description",
          "pickup",
          "dropoff",
        ].map((k) => [k, b[k]]),
      ),
      id: "AS-" + randomBytes(8).toString("hex").toUpperCase(),
      trackingToken: token(),
      riderToken: token(),
      status: "assigned",
      createdAt: now(),
      location: null,
      history: [{ status: "assigned", at: now() }],
      proof: null,
    };
    saveWithUpdates(d);
    res.status(201).json(d);
  });
  app.get("/api/track/:token", (req, res) => {
    const d = all().find((x) => equal(x.trackingToken, req.params.token));
    if (!d) return res.sendStatus(404);
    res.json(safe(d));
  });
  app.get("/api/rider/:token", (req, res) => {
    const d = all().find((x) => equal(x.riderToken, req.params.token));
    if (!d) return res.sendStatus(404);
    res.json({
      ...safe(d),
      description: d.description,
      customerName: d.customerName,
      customerPhone: d.customerPhone,
      senderName: d.senderName,
      senderPhone: d.senderPhone,
    });
  });
  function rider(req, res, next) {
    const d = all().find((x) => equal(x.riderToken, req.params.token));
    if (!d) return res.sendStatus(404);
    req.delivery = d;
    next();
  }
  app.post("/api/rider/:token/location", rider, (req, res) => {
    const d = req.delivery;
    if (["delivered", "cancelled"].includes(d.status))
      return res.status(409).json({ error: "Delivery is closed" });
    if (!coord(req.body))
      return res.status(400).json({ error: "Invalid coordinates" });
    d.location = { lat: req.body.lat, lng: req.body.lng, at: now() };
    save(d);
    res.json({ ok: true });
  });
  const nextStatus = {
    assigned: "at_pickup",
    at_pickup: "picked_up",
    picked_up: "in_transit",
    in_transit: "delivered",
  };
  app.post("/api/rider/:token/status", rider, (req, res) => {
    const d = req.delivery,
      b = req.body;
    if (nextStatus[d.status] !== b.status)
      return res.status(409).json({
        error: "Follow pickup → collected → in transit → delivered in order",
      });
    if (b.status === "delivered" && !text(b.receivedBy, 80))
      return res
        .status(400)
        .json({ error: "Recipient name is required as delivery confirmation" });
    d.status = b.status;
    d.history.push({ status: b.status, at: now() });
    if (b.status === "delivered")
      d.proof = { receivedBy: b.receivedBy.trim(), at: now() };
    saveWithUpdates(d);
    res.json(safe(d));
  });
  app.post("/api/deliveries/:id/cancel", auth, (req, res) => {
    const d = get(req.params.id);
    if (!d) return res.sendStatus(404);
    if (["delivered", "cancelled"].includes(d.status))
      return res.status(409).json({ error: "Delivery is closed" });
    d.status = "cancelled";
    d.history.push({ status: "cancelled", at: now() });
    saveWithUpdates(d);
    res.json(d);
  });
  app.get("/api/messages", auth, (req, res) =>
    res.json(
      db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 100").all(),
    ),
  );
  app.post("/api/messages/:id/send", auth, async (req, res) => {
    const m = db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(req.params.id);
    if (!m) return res.sendStatus(404);
    if (m.state !== "pending")
      return res.status(409).json({ error: "Message already processed" });
    if (
      !process.env.WHATSAPP_ACCESS_TOKEN ||
      !process.env.WHATSAPP_PHONE_NUMBER_ID
    )
      return res
        .status(409)
        .json({ error: "Demo outbox: connect WhatsApp Cloud API to send." });
    db.prepare(
      "UPDATE messages SET state='sending' WHERE id=? AND state='pending'",
    ).run(m.id);
    try {
      const response = await sendRequest(
        `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v23.0"}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            process.env.WHATSAPP_TEMPLATE_NAME
              ? {
                  messaging_product: "whatsapp",
                  to: m.recipient.replace("+", ""),
                  type: "template",
                  template: {
                    name: process.env.WHATSAPP_TEMPLATE_NAME,
                    language: {
                      code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
                    },
                    components: [
                      {
                        type: "body",
                        parameters: [
                          { type: "text", text: m.delivery },
                          {
                            type: "text",
                            text: m.body.slice(
                              m.body.indexOf(": ") + 2,
                              m.body.indexOf(". Track: "),
                            ),
                          },
                          { type: "text", text: m.body.split("Track: ")[1] },
                        ],
                      },
                    ],
                  },
                }
              : {
                  messaging_product: "whatsapp",
                  to: m.recipient.replace("+", ""),
                  type: "text",
                  text: { body: m.body },
                },
          ),
          signal: AbortSignal.timeout(15000),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        db.prepare("UPDATE messages SET state='failed' WHERE id=?").run(m.id);
        return res.status(502).json({
          error:
            "WhatsApp rejected the message. Check business permissions and the 24-hour conversation window.",
        });
      }
      db.prepare("UPDATE messages SET state='sent',provider=? WHERE id=?").run(
        result.messages?.[0]?.id || null,
        m.id,
      );
      res.json({ ok: true });
    } catch {
      db.prepare("UPDATE messages SET state='unknown' WHERE id=?").run(m.id);
      res
        .status(502)
        .json({ error: "Send outcome unknown; inspect Meta before retrying." });
    }
  });
  app.get("/webhooks/whatsapp", (req, res) => {
    if (
      process.env.WHATSAPP_VERIFY_TOKEN &&
      req.query["hub.mode"] === "subscribe" &&
      equal(req.query["hub.verify_token"], process.env.WHATSAPP_VERIFY_TOKEN)
    )
      return res.type("text").send(req.query["hub.challenge"]);
    res.sendStatus(403);
  });
  app.post("/webhooks/whatsapp", (req, res) => {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) return res.sendStatus(503);
    const signature =
      "sha256=" +
      createHmac("sha256", secret).update(req.rawBody).digest("hex");
    if (!equal(signature, req.headers["x-hub-signature-256"]))
      return res.sendStatus(403);
    for (const entry of req.body.entry || [])
      for (const change of entry.changes || [])
        for (const s of change.value?.statuses || []) {
          if (["sent", "delivered", "read", "failed"].includes(s.status))
            db.prepare(
              "UPDATE messages SET state=? WHERE provider=? AND state != 'read' AND NOT (state='delivered' AND ?='sent')",
            ).run(s.status, s.id, s.status);
        }
    res.sendStatus(200);
  });
  app.use(
    "/vendor/leaflet",
    express.static(resolve(root, "node_modules/leaflet/dist")),
  );
  app.use(express.static(resolve(root, "public")));
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.status === 400 ? "Invalid JSON request" : "Request failed",
    });
  });
  app.locals.db = db;
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || "127.0.0.1",
    () => console.log("Asili running on port " + (process.env.PORT || 3000)),
  );
}
