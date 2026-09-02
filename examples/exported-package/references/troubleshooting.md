# Troubleshooting

> Excerpt from source "Meridian Payments API" (lines 114–124). Verbatim except for this header.

- `401 unauthorized` usually means the environment variable is unset in the
  shell running the request; verify with `echo $MERIDIAN_API_KEY`.
- `409 idempotency_conflict` happens when the same `Idempotency-Key` is sent
  with a different payload; generate a fresh key per logical operation.
- `404 not_found` for a real payment id typically means you are mixing
  sandbox and production environments.
- Webhook signature failures are almost always caused by using the sandbox
  signing secret against production events, or by body-parsing middleware
  re-serializing the JSON before verification.

_Source: Meridian Payments API, lines 114–124._
