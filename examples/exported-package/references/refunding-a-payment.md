# Refunding a payment

> Excerpt from source "Meridian Payments API" (lines 57–71). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.

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

_Source: Meridian Payments API, lines 57–71._
