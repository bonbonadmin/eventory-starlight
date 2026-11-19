# Starlight Voting

Paid voting for Starlight 2026. Each vote costs IDR 5,000. Starlight issues a one-time
dynamic QRIS code through Xendit Payment Requests v3 and displays the QR code on its
own payment page. Checkout also supports direct ShopeePay, OVO and DANA payments.
Votes are credited after Xendit confirms that the full amount was captured.

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
   XENDIT_CHANNEL_CODE=QRIS
   XENDIT_PAYMENT_TTL_SECONDS=3600
   XENDIT_TEST_DB_PATH=/var/lib/eventory-starlight/starlight-test.db
   ```

3. Run `pm2 restart eventory-starlight` and check `/api/config` on the site.
   Expect `paymentMode: "test"` and `paymentsOpen: false`. If it says `"disabled"`,
   check that the key matches the mode, the token and business ID are filled in, the payment channel
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
   Authenticated dashboard samples with another business ID receive HTTP 200 and
   are ignored without being stored. Keep the profile's business ID in `.env`.
   A test callback with the configured business ID is accepted, but credits no order
   unless Xendit's Payment API returns a verified capture for a matching Starlight order.
5. To run UAT, set `XENDIT_ACCEPT_NEW_ORDERS=true`, restart PM2, and begin a payment on
   the Starlight site. Check the QR code, exact amount and expiry. In **Test Mode**,
   find that order's `pr-…` request in Xendit by `starlight-test-<order ID>` and
   [simulate payment](https://docs.xendit.co/apidocs/simulate-payment-test-mode) for the
   exact amount. Confirm the status page shows payment confirmed and votes count once even
   if the callback is resent. Test Mode labels appear on the order and payment pages.
6. For Live Mode, verify QRIS is active for this business, use a separate Live secret
   key and the Live webhook token, set `XENDIT_MODE=live`, pause new checkouts, and restart.
   Configure and verify the Live URL before opening checkout. Do not switch an active Live
   instance to Test Mode while it still has outstanding payment requests. Run a separately configured
   instance to test alongside a running Live deployment.

QRIS is the default channel and permits one IDR 5,000 vote. Its channel limit is
IDR 10,000,000, with the app's vote-count limit applied as well. Codes expire after
one hour by default. Ensure QRIS is active for this business in the Xendit Dashboard
before opening checkout. [QRIS documentation](https://docs.xendit.co/docs/qris)

`XENDIT_CHANNEL_CODE` selects the default channel; `XENDIT_CHANNEL_CODES` is the
comma-separated allowlist displayed at checkout. Each order records its selected
channel, so existing QRIS and bank orders continue to reconcile even when their
channel is removed from new checkout. Legacy
`XENDIT_VA_CHANNEL` and `XENDIT_VA_TTL_SECONDS` remain fallback settings for older
deployments; existing bank orders retain their instructions and reconciliation.
QR images are generated locally from the provider's `PRESENT_TO_CUSTOMER` /
`QR_STRING` action and returned only with the receipt's access key. The site never
sends payment QR strings to a third-party image service.

### Direct e-wallet checkout

Configure `XENDIT_CHANNEL_CODE=SHOPEEPAY` and
`XENDIT_CHANNEL_CODES=SHOPEEPAY,OVO,DANA` to offer the three wallets. Activate them
for the same business in the Xendit Dashboard / Master Account first. An API key
does not activate a payment channel. Add QRIS back to the allowlist only after
Xendit confirms the business has migrated away from the discontinued LinkAja route.

Wallet requests use `/v3/payment_requests`, `type: PAY`, `country: ID`, and `IDR`.
Following the official [channel property reference](https://doc-widget.xendit.co/reference-files/channel-properties.csv):

- ShopeePay and DANA send `channel_properties.success_return_url`. The receipt page
  presents the provider's web/app payment links and resumes checking payment after
  the customer returns to the same browser tab.
- OVO requires the customer's registered Indonesian phone number, normalized to
  E.164 and sent as `channel_properties.account_mobile_number`. It prompts the
  customer to approve in OVO; no redirect action is required for its pending push flow.
- These wallets do not accept custom expiry. The local receipt uses the documented
  channel lifetimes: [ShopeePay](https://docs.xendit.co/docs/shopeepay-e-wallets-id)
  30 minutes, [OVO](https://docs.xendit.co/docs/ovo) 15 minutes, and
  [DANA](https://docs.xendit.co/docs/dana) 24 hours, unless the provider returns an expiry.
- Payment links are available only with the receipt access key. Navigation back
  from a wallet never credits votes; verified capture and amount checks still apply.
- The receipt key stays in the URL fragment / browser session. An order-specific
  HttpOnly cookie also restores access when a wallet returns in a new tab in the
  same browser. Cookies use Secure on HTTPS, SameSite=Lax, an order-specific API
  path, and an eight-day lifetime. A different browser needs the original private receipt link.

`npm test` uses a fake Xendit HTTP API and isolated SQLite databases to verify QRIS
and all three wallet flows, private instructions, invalid methods/phone numbers,
unsafe link filtering and duplicate capture delivery. Complete a real authorized
wallet payment separately after activation to verify end-to-end account readiness.

## Operations

- Authorized vote removals are recorded separately in `vote_exclusions`, including
  the order, payment, excluded quantity, reason, operator and timestamp. Public and
  admin vote totals apply these exclusions. Payment receipts and captured revenue
  retain the original payment history.
- The receipt link carries a private browser access key in its fragment. The order ID
  alone cannot retrieve payment instructions. Keep the receipt link private.
- The worker processes a durable webhook inbox and periodically checks known Payment
  Requests, including expired ones for up to seven days. A verified late capture can
  credit the original expired order once. Additional payments, mismatches, and canceled
  orders with money movement go to review. Vote credit and its payment record commit in
  one transaction. There is no separate notification or fulfillment job in this app.
- A timed-out create can leave a payment request open. The app never retries that create. Search
  for the original reference in the matching Xendit dashboard or escalate to Xendit Support
  before suggesting another payment. If the webhook comes in later it can resolve the order.
- Use `GET /api/admin/payment-review` with `x-admin-key` for unmatched events, exhausted
  retries, and payments that need review. It omits QR strings, virtual account numbers and customer
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
