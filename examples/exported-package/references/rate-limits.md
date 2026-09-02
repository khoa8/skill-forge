# Rate limits

> Excerpt from source "Meridian Payments API" (lines 92–96). Verbatim except for this header.

The API allows 100 requests per second per key. When you exceed the limit the
API returns `429 rate_limited`. Honor the `Retry-After` header, which is
always present on 429 responses, and use exponential backoff for retries.

_Source: Meridian Payments API, lines 92–96._
