# Asili Logistics

A working first version of a delivery operations app: dispatcher board, private rider workspace, customer tracking, phone GPS updates, pickup-to-delivery history, and a WhatsApp notification outbox. Default map centre is Kigali; deliveries support coordinates worldwide.

## Run locally

Requires **Node.js 24+** (uses built-in SQLite).

```sh
cd /workspace/asililogistics
npm ci --cache /tmp/asili-npm-cache
npm test
npm start
```

The server listens on port 3000 on the loopback interface. Local demo mode needs no credentials and has no dispatcher authentication. Use fictitious contact details. SQLite data persists under ignored `data/`; restarting does not reset it. There is no separate frontend build, database service, or migration command.

Copy `.env.example` to `.env` if needed, preserving any existing `.env`. Never commit that file. Set `ADMIN_KEY` to a securely generated password before using real customer information or exposing the app. Use the **Dispatcher key** button to authenticate; the browser stores it only for the current tab. `HOST=0.0.0.0` requires a key. Production additionally requires `NODE_ENV=production` and an HTTPS `PUBLIC_BASE_URL`.

## Delivery workflow

1. Dispatcher creates an order with sender/customer contact details, parcel description, rider, and exact pickup/dropoff coordinates. Obtain consent for contact and delivery tracking.
2. Copy the private rider link and give it only to the assigned rider. Copy the customer link for the sender/customer. Keep these links private: possession grants access to that delivery. The rider link grants progress updates and GPS publishing; the customer link is read-only and excludes phone numbers.
3. Rider opens their link on a phone and selects **Share live GPS**, granting location permission. Keep the page open. GPS needs HTTPS outside localhost; browser background suspension can pause updates. The map displays the most recent GPS timestamp rather than claiming continuous background tracking.
4. Rider moves through **At pickup → Collected → In transit → Delivered**. Delivery requires the name of the person receiving the parcel, recorded with a timestamp. This is rider-reported confirmation, not an independently verified OTP or signature.
5. Sender/customer can follow the private tracking link. The screen refreshes every five seconds. GPS updates are throttled to at most one every five seconds in the rider client. Completing or cancelling a delivery stops further updates.
6. Each status change queues a WhatsApp message to the sender and customer (deduplicated if they share a number). Dispatcher reviews the outbox and clicks **Send** after live WhatsApp is configured. No messages are sent by installation or tests.

The dashed line between stops is a visual connection, **not a road route or calculated ETA**. Riders can open turn-by-turn navigation in their maps app. Address search and routing services are not required; coordinates are entered explicitly.

## Connect WhatsApp Cloud API

Use a Meta business account, WhatsApp Business phone number, and a token authorized to send messages for that number. Configure these securely in your deployment environment (never in chat or source):

- `WHATSAPP_ACCESS_TOKEN`: server-side bearer token.
- `WHATSAPP_PHONE_NUMBER_ID`: Meta phone-number ID, not the phone number itself.
- `WHATSAPP_APP_SECRET`: local signing secret used to verify webhook signatures.
- `WHATSAPP_VERIFY_TOKEN`: a private value you choose for webhook verification.
- `PUBLIC_BASE_URL`: this app's externally reachable HTTPS origin, used in all newly queued tracking links.
- `WHATSAPP_API_VERSION`: defaults to `v23.0`; select a version supported by your Meta app.

Configure Meta's webhook callback as `https://YOUR_DOMAIN/webhooks/whatsapp`, set the same verification token, and subscribe to message status updates. Callback verification checks the token; POST callbacks must carry a valid HMAC signature from the Meta app secret. Delivery/read/failure receipts update the matching outbox message. Unrelated incoming messages are acknowledged but do not create orders or execute commands. This version is not a WhatsApp chatbot.

For business-initiated updates, get Meta approval for a utility template such as `asili_delivery_update`. Its body must contain three text parameters in this order:

```text
Asili delivery {{1}}: {{2}}. Track your delivery: {{3}}
```

Set `WHATSAPP_TEMPLATE_NAME` to the approved name and `WHATSAPP_TEMPLATE_LANGUAGE` to its approved language code (default `en`). Without a template, the app sends a plain text update, which Meta generally allows only inside the recipient's active 24-hour customer-service window. Obtain recipient opt-in and follow Meta's template/category requirements. Confirm with Meta before using a real number; this environment has not sent live messages.

Failed sends remain visible. A timeout is marked `unknown` because the provider may already have accepted the message. This version intentionally does not automatically retry failed/unknown sends, avoiding accidental duplicates. Check Meta before any manual reconciliation. Restarting after interruption can leave a `sending` message needing operator reconciliation.

## Map and network

Leaflet JavaScript/CSS is served locally from the locked npm dependency. Background tiles come from `tile.openstreetmap.org`; attribution is included. Browsers need access to that host. The app shows a tile error while keeping coordinates and controls usable if the network blocks it. Respect the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/); select a commercial or self-hosted provider before significant traffic. The current UI does not offer offline maps.

The backend requires outbound HTTPS to `graph.facebook.com` for live WhatsApp, and installation needs `registry.npmjs.org`. Navigation opens `www.google.com` in the rider browser. Meta requires inbound access to the public HTTPS webhook. An outbound allowlist alone does not expose a webhook.

## Validation

`npm test` exercises dispatcher authorization, validation, private tracking, GPS publishing, sequential state transitions, required delivery confirmation, cancellation, WhatsApp delivery payloads, webhook verification, and persisted state. Tests use an in-memory database or temporary files and fake provider responses; they do not contact customers. `npm start` starts the actual app; `/api/health` reports basic service and integration mode. `configured` indicates a token is present, not that Meta access has been proven.

## Deployment boundary

This is an initial single-server application, not a finished public delivery platform. Before operating with real customers:

- Put it behind a trusted HTTPS reverse proxy, set the dispatcher key, configure public origin and WhatsApp settings, and validate real phones/receipts. Do not log authorization headers or private tracking URL tokens.
- Back up SQLite using a consistent SQLite backup mechanism, including WAL state, and test restoration. Use persistent storage owned by the app, with restricted permissions. Use one Node process per database; do not deploy multiple replicas with independent SQLite files.
- Define privacy notices, consent, data retention/deletion and operator access policies. Tracking links currently have no expiry; restrict sharing and add expiry/revocation before broad deployment. Add per-user roles, credential rotation, rate limits, and audit logging for a multi-dispatcher service.
- Background GPS while the phone is locked, verified delivery OTP/signatures/photos, payments, automated dispatch, pricing, route optimization and customer booking through WhatsApp are follow-up features. Current dispatch is manual and GPS requires the page to remain active.

See [deploy/README.md](deploy/README.md) for the Render account connection guide, generated production credentials, Meta setup, real integration checks, and optional Docker/Caddy hosting. Run `npm run setup:secrets` to generate local dispatcher and webhook verification keys without exposing them. These keys stay in ignored `.env`.

The Render Blueprint provides managed HTTPS and persistent storage after you connect your account and deploy it. Repository files alone do not provision hosting or publish the Codex development environment.
