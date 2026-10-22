# Frontend

| File | What it is |
|---|---|
| `scratch_widget.html` | Merchant page. Pasted into a WordPress Elementor HTML widget. Phone lookup, canvas scratch card, celebration popup, share to WhatsApp, deep link `?uid={phone}#kartu-gosok` |
| `draw_operator.html` | Operator control panel for the Instagram Live draw. Preflight stats, one-by-one prize picks, winner reveal |

Both call the Apps Script Web App with plain `GET` requests. Set `API_URL` to your deployment before use.
To try them without a backend, open the [demo](../demo/).
