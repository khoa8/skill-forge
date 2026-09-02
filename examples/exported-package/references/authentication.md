# Authentication

> Excerpt from source "Meridian Payments API" (lines 8–21). Verbatim except for this header.

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

_Source: Meridian Payments API, lines 8–21._
