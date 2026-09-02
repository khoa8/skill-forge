# Source: Meridian Payments API, lines 67–71 (under "Refunding a payment"). Verbatim code block.
curl -X POST https://api.meridian-sandbox.example.com/v1/refunds \
  -H "Authorization: Bearer $MERIDIAN_API_KEY" \
  -d '{"payment_id": "pay_9d81", "amount": 500}'
