# Starlight Voting

Paid voting site for Starlight 2026. Visitors pick a performance, choose how many votes to buy
(IDR 5,000 each), pay through a Xendit invoice, and the votes are counted once Xendit's callback
confirms the payment.

- **Backend:** Node.js (>= 22.13) + Express 5
- **Database:** SQLite file via Node's built-in `node:sqlite` (no native build step)
- **Payments:** Xendit Invoice API (`/v2/invoices`)

## Run locally

```bash
npm install
cp .env.example .env   # then edit
npm start              # http://localhost:3000
```

With `XENDIT_SECRET_KEY` left empty the app runs in **mock mode**: "Continue to payment" opens a
local mock checkout where you can simulate a paid or expired payment. Nothing is sent to Xendit.

## Pages

| Path | Purpose |
| --- | --- |
| `/` | Landing page + grid of performances (live totals if `SHOW_RESULTS=true`) |
| `/vote?id=<performance>` | Choose number of votes, optional name/email, go to payment |
| `/status?order=<id>` | Xendit redirects here after checkout; polls until the order is confirmed |
| `/mock-pay` | Mock checkout, only available in mock mode |

## Editing performances

Edit `data/performances.json` and restart. Entries are upserted by `id` on startup and never deleted
(so paid votes keep their reference). To hide one, set `"active": false`. `image` is optional: put
files in `public/assets/` and use e.g. `"/assets/band-a.jpg"`. Without an image a coloured glowing
star is shown.

## Xendit setup

1. Dashboard > Settings > API Keys: create a secret key with **Money-in write** permission and set
   `XENDIT_SECRET_KEY`.
2. Dashboard > Settings > Webhooks: copy the **verification token** into `XENDIT_CALLBACK_TOKEN`, and
   set the **Invoices paid** URL to `https://<your-domain>/api/xendit/callback`.
3. Set `BASE_URL` to the public URL of the site (used for the success/failure redirect).

Locally, expose the server with a tunnel (e.g. `ngrok http 3000`) and use that URL for both
`BASE_URL` and the webhook so Xendit can reach the callback. Use test-mode keys while developing.

### How a vote is confirmed

1. `POST /api/orders` validates the request, stores a `PENDING` order and creates a Xendit invoice
   with `external_id` = order id. The browser is redirected to the invoice URL.
2. Xendit calls `POST /api/xendit/callback`. The server:
   - rejects the call unless `x-callback-token` matches `XENDIT_CALLBACK_TOKEN`;
   - re-fetches the invoice from Xendit's API (the callback body is never trusted on its own) and
     checks that its `external_id` and invoice id match the order;
   - for `PAID`/`SETTLED` with `paid_amount >= amount`, marks the order `PAID`; for `EXPIRED`,
     marks it `EXPIRED`.

   Updates only apply to `PENDING` orders, so repeated callbacks are harmless. Verification errors
   return 500 so Xendit retries.
3. Vote totals are `SUM(votes)` over `PAID` orders only.

## Admin endpoints

Send the header `x-admin-key: <ADMIN_KEY>`.

- `GET /api/admin/results`: votes and revenue per performance
- `GET /api/admin/orders?limit=200`: most recent orders

```bash
curl -H "x-admin-key: $ADMIN_KEY" http://localhost:3000/api/admin/results
```

## Deploying

Any Node host with a persistent disk works (VPS, Railway/Render with a volume, etc.). Keep `DB_PATH`
on persistent storage and back up the `.db` file. If running behind a reverse proxy, set
`TRUST_PROXY=1` so the rate limiter sees real client IPs.
