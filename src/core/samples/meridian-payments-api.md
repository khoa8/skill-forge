# Meridian Payments API

A REST API for processing payments, refunds, and payouts. All requests are
made over HTTPS to `https://api.meridian-sandbox.example.com/v1`. The sandbox
environment is fully isolated from production and returns deterministic test
responses.

## Authentication

Every request must include your secret key as a bearer token. Keys are
environment-specific: sandbox keys start with `sk_sandbox_` and production
keys with `sk_live_`. Set the key as an environment variable before using any
client library:

```
export MERIDIAN_API_KEY=sk_sandbox_5f3examplekey9z
```

Requests without a valid key return `401 unauthorized`. Requests with a key
against the wrong environment return `403 forbidden`. Never embed secret keys
in client-side code or version control.

## Creating a payment

Create a payment by POSTing to `/v1/payments`. The minimum payload requires
`amount`, `currency`, and a `payment_method_id` obtained from the payment
methods flow.

```bash
curl -X POST https://api.meridian-sandbox.example.com/v1/payments \
  -H "Authorization: Bearer $MERIDIAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount": 1999, "currency": "usd", "payment_method_id": "pm_7g2"}'
```

A successful call returns `201 created` with a payment object. The `status`
field starts as `pending` and moves to `succeeded` asynchronously; poll the
payment resource or subscribe to webhooks rather than assuming success.

```json
{
  "id": "pay_9d81",
  "amount": 1999,
  "currency": "usd",
  "status": "pending",
  "created": 1735689600
}
```

### Payment statuses

- `pending` — the payment has been accepted and is processing.
- `succeeded` — funds are captured.
- `failed` — the issuer declined; inspect `failure_code`.
- `refunded` — the full amount was refunded.

## Refunding a payment

Refunds return funds to the payer. Refunds can be full or partial; issue a
partial refund by sending an `amount` smaller than the original.

1. Look up the original payment id (the `pay_` prefixed identifier).
2. Confirm the payment status is `succeeded` before attempting a refund.
3. POST to `/v1/refunds` with the `payment_id` and an optional `amount`.
4. Verify the refund object's `status` reaches `succeeded`.

```bash
curl -X POST https://api.meridian-sandbox.example.com/v1/refunds \
  -H "Authorization: Bearer $MERIDIAN_API_KEY" \
  -d '{"payment_id": "pay_9d81", "amount": 500}'
```

## Error handling

The API uses conventional HTTP status codes. The JSON body always includes a
machine-readable `error.code` and a human-readable `error.message`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed payload or missing required field. |
| 401 | `unauthorized` | Missing or malformed API key. |
| 403 | `forbidden` | Key lacks permission for the endpoint or environment. |
| 404 | `not_found` | The resource id does not exist in this environment. |
| 409 | `idempotency_conflict` | The same idempotency key was reused with a different payload. |
| 429 | `rate_limited` | Too many requests; back off using `Retry-After`. |
| 500 | `internal_error` | Meridian-side failure; safe to retry with backoff. |

Always pass an `Idempotency-Key` header (any unique string up to 64 chars)
when creating payments or refunds so retries after network failures cannot
double-charge.

## Rate limits

The API allows 100 requests per second per key. When you exceed the limit the
API returns `429 rate_limited`. Honor the `Retry-After` header, which is
always present on 429 responses, and use exponential backoff for retries.

## Webhooks

Webhooks notify your server when payment or refund statuses change. Register
an HTTPS endpoint in the dashboard, then verify each delivery by checking the
`Meridian-Signature` header against your signing secret (`MERIDIAN_WEBHOOK_SECRET`).
Respond with any 2xx status within 10 seconds; deliveries that fail are
retried for up to 24 hours.

## Test cards

The sandbox supports deterministic test payment methods:

- `pm_ok` — succeeds immediately.
- `pm_declined` — always declines with `card_declined`.
- `pm_3ds` — requires a follow-up 3-D Secure confirmation.

## Troubleshooting

- `401 unauthorized` usually means the environment variable is unset in the
  shell running the request; verify with `echo $MERIDIAN_API_KEY`.
- `409 idempotency_conflict` happens when the same `Idempotency-Key` is sent
  with a different payload; generate a fresh key per logical operation.
- `404 not_found` for a real payment id typically means you are mixing
  sandbox and production environments.
- Webhook signature failures are almost always caused by using the sandbox
  signing secret against production events, or by body-parsing middleware
  re-serializing the JSON before verification.
