# Backend — Google Apps Script

11 modules, deployed as one Apps Script project bound to a Google Sheets workbook.
Design: [../docs/02-technical-design.md](../docs/02-technical-design.md).

## Deploy your own copy

1. Create a Google Sheet. Add a tab `Raw Order Data` with the order columns listed in the technical design (§3).
2. Extensions → Apps Script. Paste every `.gs` file from this folder.
3. In `00_Config.gs`, set `SPREADSHEET_ID` to your sheet ID.
4. Run `setupSupportingSheets` once. It creates the 13 campaign tabs and seeds prizes, waves, config and dummy cards.
5. In `CONFIG`, set `disbursement_drive_folder_id` to a Drive folder ID.
6. Run `syncOrders` once by hand.
7. Add time triggers:
   - `syncOrders` — every 2 hours
   - `generateThursdayDisbursementCSV` — weekly, Thursday 09:00
8. Add an installable onEdit trigger: `onDisbursementProgressEdit`.
9. Deploy → Web App → Execute as *Me*, access *Anyone*.
10. Put the `/exec` URL into `API_URL` in `../frontend/scratch_widget.html`.
11. Smoke test: `<exec-url>?action=health`, then `?action=lookup&uid=8000000001`.

Updating later: Deploy → Manage deployments → Edit → **New version**. A new deployment changes the URL.

> `06_Disbursement.gs` is the legacy direct-API payout path. Do not enable its trigger together with `09_DisbursementExport.gs`.
