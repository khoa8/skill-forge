# Test cards

> Excerpt from source "Meridian Payments API" (lines 106–112). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.

The sandbox supports deterministic test payment methods:

- `pm_ok` — succeeds immediately.
- `pm_declined` — always declines with `card_declined`.
- `pm_3ds` — requires a follow-up 3-D Secure confirmation.

_Source: Meridian Payments API, lines 106–112._
