# Starlight Voting

Paid voting for Starlight 2026. Each vote costs IDR 5,000. Starlight issues a one-time
Indonesian virtual account through Xendit Payment Requests v3 and displays bank
transfer instructions on its own payment page. Votes are credited after Xendit
confirms that the full amount was captured.

Requires Node.js 22.13+ and persistent disk for SQLite.

## Run locally

```bash
npm ci
cp .env.example .env
npm start
```

Checkout starts disabled. For local development without Xendit, set `XENDIT_MODE=mock`
in `.env`. Historical mock votes are excluded from real checkout totals. A real Xendit
Test Mode run uses a separate SQLite file and a different callback path.

Edit `data/performances.json` and restart to update performers. Entries are upserted
by ID. Set `active: false` to hide an entry and preserve its order history. Performer
images are served from `public/assets/`.

## Configure Xendit on crystalgeneral

1. Open the existing Crystal business in the Xendit Dashboard and switch to **Test Mode**.
   Go to **Settings → Developers → API Keys**, make a new secret key for Starlight with
   **Money-in: Write** (which includes read), then copy the business ID and the webhook
   verification token for that account and mode from its settings. Keep Crystal's keys in use.
2. SSH to `crystalgeneral` and edit the existing `/opt/eventory-starlight/.env` in place.
   Preserve the other settings and the file's `root:starlight` ownership and `640` permissions.
   Replace the placeholders below. Put the raw secret key on the server only.

   ```dotenv
   XENDIT_MODE=test
   XENDIT_ACCEPT_NEW_ORDERS=false
   XENDIT_API_KEY=<test secret API key>
   XENDIT_WEBHOOK_TOKEN=<webhook verification token>
   XENDIT_BUSINESS_ID=<business ID>
   XENDIT_VA_CHANNEL=BNI_VIRTUAL_ACCOUNT
   XENDIT_VA_TTL_SECONDS=3600
   XENDIT_TEST_DB_PATH=/var/lib/eventory-starlight/starlight-test.db
   ```

3. Run `pm2 restart eventory-starlight` and check `/api/config` on the site.
   Expect `paymentMode: "test"` and `paymentsOpen: false`. If it says `"disabled"`,
   check that the key matches the mode, the token and business ID are filled in, the bank
   is supported, and the expiry is an integer between 300 and 86,400 seconds.
4. In the Xendit Dashboard, go to **Settings → Webhooks** in the same mode. Set both
   **Payment Requests v3 – Payment Status** and **Payment Requests v3 – Payment Request Status**
   to the corresponding URL and click **Test & Save** for each.

   | Dashboard mode | Callback URL |
   | --- | --- |
   | Test | `https://starlight.eventory.co.id/api/xendit/v3/test` |
   | Live | `https://starlight.eventory.co.id/api/xendit/v3` |

   If either v3 topic already has a consumer, coordinate a shared receiver before changing
   its URL. Leave Crystal's legacy invoice and Fixed Virtual Account webhook URLs unchanged.
   A test callback with the configured business ID is accepted, but credits no order
   unless Xendit's Payment API returns a verified capture for a matching Starlight order.
5. To run UAT, set `XENDIT_ACCEPT_NEW_ORDERS=true`, restart PM2, and begin a payment on
   the Starlight site. Check the bank, VA number, exact amount and expiry. In **Test Mode**,
   find that order's `pr-…` request in Xendit by `starlight-test-<order ID>` and
   [simulate payment](https://docs.xendit.co/apidocs/simulate-payment-test-mode) for the
   exact amount. Confirm the status page shows payment confirmed and votes count once even
   if the callback is resent. Test Mode labels appear on the order and payment pages.
6. For Live Mode, verify the bank is active for this business, use a separate Live secret
   key and the Live webhook token, set `XENDIT_MODE=live`, pause new checkouts, and restart.
   Configure and verify the Live URL before opening checkout. Do not switch an active Live
   instance to Test Mode while it still has outstanding VAs. Run a separately configured
   instance to test alongside a running Live deployment.

BNI is the default and permits one IDR 5,000 vote. BRI and Mandiri are also supported.
BCA requires at least IDR 10,000, so its checkout starts at two votes with the default
price. The default VA expires in one hour. Confirm channel availability and expiry for
this business in Dashboard before going live. [Xendit channel limits](https://docs.xendit.co/docs/available-payment-methods)

## Operations

- The receipt link carries a private browser access key in its fragment. The order ID
  alone cannot retrieve a v3 virtual account. Keep the receipt link private.
- The worker processes a durable webhook inbox and periodically checks known Payment
  Requests, including expired ones for up to seven days. A verified late capture can
  credit the original expired order once. Additional payments, mismatches, and canceled
  orders with money movement go to review. Vote credit and its payment record commit in
  one transaction. There is no separate notification or fulfillment job in this app.
- A timed-out create can leave a bank VA open. The app never retries that create. Search
  for the original reference in the matching Xendit dashboard or escalate to Xendit Support
  before suggesting another payment. If the webhook comes in later it can resolve the order.
- Use `GET /api/admin/payment-review` with `x-admin-key` for unmatched events, exhausted
  retries, and payments that need review. It omits virtual account numbers and customer
  details. `GET /api/admin/results` and `/api/admin/orders` use the same admin header.
- For an exhausted webhook, fix the cause, then requeue that event in the correct mode's
  SQLite database using its `event_key`:

  ```sql
  UPDATE xendit_inbox
  SET state = 'PENDING', retries = 0, next_check_at = 0, issue = NULL
  WHERE event_key = '<event_key>' AND issue = 'RETRIES_EXHAUSTED';
  ```

- Reconcile disputed or missing funds against Xendit's transaction report. Setting
  `XENDIT_ACCEPT_NEW_ORDERS=false` and restarting pauses sales while the worker and
  callbacks continue in the selected environment. Keep the existing key, callback, and
  database available until the outstanding payments are reconciled.

## Deployment

App `/opt/eventory-starlight`, PM2 process `eventory-starlight`, loopback port `3110`
behind Nginx. The live SQLite file is `/var/lib/eventory-starlight/starlight.db`.
Use SQLite's backup API or CLI `.backup` for a consistent snapshot while the app is running.
The server `.env` is separate from source control.

```bash
rsync -az --exclude=.git --exclude=node_modules --exclude=.env \
  --exclude='*.db' --exclude='*.db-*' ./ crystalgeneral:/opt/eventory-starlight/
ssh crystalgeneral 'cd /opt/eventory-starlight && npm ci --omit=dev && pm2 restart eventory-starlight'
```
