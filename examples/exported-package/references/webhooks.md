# Webhooks

> Excerpt from source "Meridian Payments API" (lines 98–104). Verbatim except for this header.

Webhooks notify your server when payment or refund statuses change. Register
an HTTPS endpoint in the dashboard, then verify each delivery by checking the
`Meridian-Signature` header against your signing secret (`MERIDIAN_WEBHOOK_SECRET`).
Respond with any 2xx status within 10 seconds; deliveries that fail are
retried for up to 24 hours.

_Source: Meridian Payments API, lines 98–104._
