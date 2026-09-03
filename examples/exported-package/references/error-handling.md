# Error handling

> Excerpt from source "Meridian Payments API" (lines 73–90). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.

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

_Source: Meridian Payments API, lines 73–90._
