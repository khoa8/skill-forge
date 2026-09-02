# Creating a payment

> Excerpt from source "Meridian Payments API" (lines 23–48). Verbatim except for this header.

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

_Source: Meridian Payments API, lines 23–48._
