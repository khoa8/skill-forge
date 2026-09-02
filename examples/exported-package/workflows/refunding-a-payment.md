# Refunding a payment

> Documented procedure from source "Meridian Payments API" (lines 62–65). Steps are verbatim from the source.

1. Look up the original payment id (the `pay_` prefixed identifier). _(source line 62)_
2. Confirm the payment status is `succeeded` before attempting a refund. _(source line 63)_
3. POST to `/v1/refunds` with the `payment_id` and an optional `amount`. _(source line 64)_
4. Verify the refund object's `status` reaches `succeeded`. _(source line 65)_
