# Source: Meridian Payments API, lines 29–34 (under "Creating a payment"). Verbatim code block.
curl -X POST https://api.meridian-sandbox.example.com/v1/payments \
  -H "Authorization: Bearer $MERIDIAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount": 1999, "currency": "usd", "payment_method_id": "pm_7g2"}'
