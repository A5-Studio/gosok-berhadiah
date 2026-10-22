/**
 * 09_DisbursementExport.gs — CSV-based disbursement workflow.
 *
 * Replaces the auto-disbursement stub in 06_Disbursement.gs.
 *
 * Flow (intended schedule: Thursdays at 09:00 WIB, day before each Friday batch):
 *   1. generateThursdayDisbursementCSV() is invoked by time-based trigger.
 *   2. It resolves tomorrow's batch label (e.g. "5 Juni 2026").
 *   3. Aggregates KOMISI_DISBURSEMENTS for that batch where status=queued,
 *      grouping by user_id and summing value_idr.
 *   4. Writes a CSV file to a Google Drive folder.
 *   5. Upserts a row in DISBURSEMENT_PROGRESS with status REQUESTED.
 *   6. Finance team processes the CSV externally, then manually flips
 *      DISBURSEMENT_PROGRESS.status → DONE in the sheet.
 *   7. onDisbursementProgressEdit (installable onEdit trigger) detects the
 *      DONE flip, backfills processed_at + status=sent on the matching
 *      KOMISI_DISBURSEMENTS rows.
 *
 * Setup required:
 *   - CONFIG.disbursement_drive_folder_id  ← Drive folder UUID to upload into
 *   - CONFIG.disbursement_expiry_date     ← e.g. "2026-12-31"
 *   - Time-based trigger:  generateThursdayDisbursementCSV  (weekly, Thu 09:00)
 *   - Installable onEdit:  onDisbursementProgressEdit       (on the spreadsheet)
 *
 * Note: when this module is used, the trigger for runThursdayDisbursementBatch
 * (in 06_Disbursement.gs) should be DISABLED to avoid two flows touching the
 * same rows.
 */

const DISBURSEMENT_STATUS = {
  DATA_COMPLETE: 'DATA_COMPLETE',  // rows aggregated but file not uploaded
  REQUESTED:     'REQUESTED',      // CSV uploaded to Drive, awaiting finance
  DONE:          'DONE',           // finance has processed
};

// ─── Public entry: time-based trigger ──────────────────────────────────────────

/**
 * Resolves which batch is due tomorrow (Friday) and generates the CSV.
 * Schedule this on a time-based trigger every Thursday morning.
 */
function generateThursdayDisbursementCSV() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); }
  catch (e) { Logger.log('disbursement CSV: could not acquire lock'); return; }

  try {
    const now = nowJkt();
    const tomorrow = new Date(now.getTime() + 86400000);
    const tomorrowYmd = fmtDate(tomorrow);

    // Find the disbursement schedule entry whose disb date == tomorrow
    let batchLabel = null;
    for (const slot of DISBURSEMENT_SCHEDULE) {
      const disbDate = new Date(slot.disb.y, slot.disb.m - 1, slot.disb.d);
      if (fmtDate(disbDate) === tomorrowYmd) {
        batchLabel = fmtDateId(disbDate);  // "5 Juni 2026"
        break;
      }
    }

    if (!batchLabel) {
      Logger.log('disbursement CSV: tomorrow (' + tomorrowYmd +
                 ') is not a scheduled disbursement date — skipping');
      return { ok: false, reason: 'not_disbursement_day', tomorrow: tomorrowYmd };
    }

    return generateDisbursementCSVForBatch(batchLabel);
  } finally {
    lock.releaseLock();
  }
}

// ─── Public entry: manual ──────────────────────────────────────────────────────

/**
 * Build & upload the CSV for a specific batch.
 * Safe to call manually for testing or retries.
 * @param {string} batchLabel  e.g. "5 Juni 2026"
 */
function generateDisbursementCSVForBatch(batchLabel) {
  Logger.log('disbursement CSV: starting for batch "' + batchLabel + '"');

  // ── 1. Aggregate rows ─────────────────────────────────────────────
  const all = readAllRows(SHEET.KOMISI_DISBURSEMENTS);
  const eligible = all.filter(d =>
    d.batch === batchLabel && d.status === STATUS.DISB_QUEUED
  );

  if (eligible.length === 0) {
    Logger.log('disbursement CSV: no queued rows for batch ' + batchLabel);
    return { ok: false, reason: 'no_rows', batch: batchLabel };
  }

  // Group by NORMALIZED uid (strip non-digits and leading zeros).
  // This catches cases where the same merchant entered "08xxx" once and
  // "8xxx" another time — they get merged into a single row.
  const userTotals = {};
  let skipped = 0;
  eligible.forEach(d => {
    const uid = normalizeUidForDisbursement_(d.user_id);
    if (!uid) { skipped++; return; }
    userTotals[uid] = (userTotals[uid] || 0) + Number(d.value_idr || 0);
  });

  const uniqueUsers = Object.keys(userTotals).length;
  const totalAmount = Object.values(userTotals).reduce((s, v) => s + v, 0);

  // ── 2. Write DATA_COMPLETE marker first (in case upload fails) ────
  const nowTs = fmtTs(nowJkt());
  upsertRow(SHEET.DISBURSEMENT_PROGRESS, 'batch', {
    batch:                     batchLabel,
    total_disbursement_needed: totalAmount,
    unique_users:              uniqueUsers,
    file_url:                  '',
    file_id:                   '',
    status:                    DISBURSEMENT_STATUS.DATA_COMPLETE,
    generated_at:              nowTs,
    processed_at:              '',
  });

  // ── 3. Build CSV ──────────────────────────────────────────────────
  const cfg = getConfig();
  // CONFIG cells can come back as either string ("2026-12-31") or a Date
  // (Sheets auto-parses ISO-looking strings). Normalize to yyyy-MM-dd so
  // the CSV column always matches the spec.
  const rawExpiry = cfg.disbursement_expiry_date || '2026-12-31';
  const expiryDate = (rawExpiry instanceof Date) ? fmtDate(rawExpiry) : String(rawExpiry);
  const description = 'Hadiah Promo Gosok Berhadiah | Periode ' + batchLabel;

  const lines = ['userId,amount,expiryDate,description'];
  Object.keys(userTotals).sort().forEach(uid => {
    lines.push([uid, userTotals[uid], expiryDate, description].join(','));
  });
  const csvContent = lines.join('\n');

  // ── 4. Upload to Drive ────────────────────────────────────────────
  const folderId = cfg.disbursement_drive_folder_id;
  if (!folderId) {
    Logger.log('disbursement CSV: CONFIG.disbursement_drive_folder_id missing');
    return { ok: false, reason: 'no_folder_id', batch: batchLabel };
  }

  // Trash the previous file for this batch, if any, to keep Drive clean
  const existing = findRow(SHEET.DISBURSEMENT_PROGRESS, 'batch', batchLabel);
  if (existing && existing.file_id) {
    try { DriveApp.getFileById(existing.file_id).setTrashed(true); }
    catch (e) { Logger.log('  (could not trash previous file: ' + e.message + ')'); }
  }

  const fileName = 'Komisi_Disbursement_' + batchLabel.replace(/\s+/g, '_') + '.csv';
  let fileUrl, fileId;
  try {
    const folder = DriveApp.getFolderById(folderId);
    const blob = Utilities.newBlob(csvContent, 'text/csv', fileName);
    const file = folder.createFile(blob);
    fileUrl = file.getUrl();
    fileId  = file.getId();
  } catch (e) {
    Logger.log('disbursement CSV: Drive upload failed — ' + e.message);
    return { ok: false, reason: 'drive_upload_failed', batch: batchLabel, error: e.message };
  }

  // ── 5. Update progress row → REQUESTED ────────────────────────────
  upsertRow(SHEET.DISBURSEMENT_PROGRESS, 'batch', {
    batch:                     batchLabel,
    total_disbursement_needed: totalAmount,
    unique_users:              uniqueUsers,
    file_url:                  fileUrl,
    file_id:                   fileId,
    status:                    DISBURSEMENT_STATUS.REQUESTED,
    generated_at:              nowTs,
    processed_at:              '',
  });

  Logger.log('disbursement CSV: done.' +
    ' batch=' + batchLabel +
    ' users=' + uniqueUsers +
    ' total=Rp ' + totalAmount.toLocaleString('id-ID') +
    (skipped > 0 ? ' (skipped ' + skipped + ' rows with empty uid)' : '') +
    ' url=' + fileUrl);

  return {
    ok:           true,
    batch:        batchLabel,
    unique_users: uniqueUsers,
    total_idr:    totalAmount,
    skipped_rows: skipped,
    file_url:     fileUrl,
    file_id:      fileId,
  };
}

// ─── onEdit trigger: status → DONE backfill ────────────────────────────────────

/**
 * Installable onEdit trigger handler.
 * When DISBURSEMENT_PROGRESS.status changes to "DONE", backfills
 * processed_at on every KOMISI_DISBURSEMENTS row in that batch and
 * sets their status to "sent".
 */
function onDisbursementProgressEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET.DISBURSEMENT_PROGRESS) return;

    // Resolve column positions from header row
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusCol = headers.indexOf('status') + 1;
    const batchCol  = headers.indexOf('batch') + 1;
    const procCol   = headers.indexOf('processed_at') + 1;
    if (statusCol === 0 || batchCol === 0) return;

    // Was the status column edited?
    if (e.range.getColumn() !== statusCol) return;

    const newValue = String(e.value || '').trim().toUpperCase();
    if (newValue !== DISBURSEMENT_STATUS.DONE) return;

    const rowNum = e.range.getRow();
    const batchLabel = String(sheet.getRange(rowNum, batchCol).getValue());
    if (!batchLabel) return;

    Logger.log('onDisbursementProgressEdit: batch "' + batchLabel + '" marked DONE');

    // Backfill processed_at + status on KOMISI_DISBURSEMENTS rows
    const nowTs = fmtTs(nowJkt());
    const all = readAllRows(SHEET.KOMISI_DISBURSEMENTS);
    let count = 0;
    all.forEach(d => {
      if (d.batch === batchLabel && d.status === STATUS.DISB_QUEUED) {
        updateRow(SHEET.KOMISI_DISBURSEMENTS, d._rowNum, {
          status:       STATUS.DISB_SENT,
          processed_at: nowTs,
        });
        count++;
      }
    });

    // Record processed_at on the progress row itself
    if (procCol > 0) sheet.getRange(rowNum, procCol).setValue(nowTs);

    Logger.log('onDisbursementProgressEdit: marked ' + count +
               ' KOMISI_DISBURSEMENTS rows as sent');
  } catch (err) {
    Logger.log('onDisbursementProgressEdit error: ' + err.message);
  }
}

// ─── Manual helpers ────────────────────────────────────────────────────────────

/**
 * Dry-run: show what would be in the CSV for a given batch without
 * creating any files or sheet rows.
 */
function previewDisbursementCSVForBatch(batchLabel) {
  const all = readAllRows(SHEET.KOMISI_DISBURSEMENTS);
  const eligible = all.filter(d =>
    d.batch === batchLabel && d.status === STATUS.DISB_QUEUED
  );
  const userTotals = {};
  eligible.forEach(d => {
    const uid = normalizeUidForDisbursement_(d.user_id);
    if (!uid) return;
    userTotals[uid] = (userTotals[uid] || 0) + Number(d.value_idr || 0);
  });
  const total = Object.values(userTotals).reduce((s, v) => s + v, 0);
  const result = {
    batch: batchLabel,
    queued_rows: eligible.length,
    unique_users: Object.keys(userTotals).length,
    total_idr: total,
  };
  Logger.log('Preview: ' + JSON.stringify(result, null, 2));
  return result;
}

/**
 * Manually re-run the DONE backfill for a batch.
 * Use this if the onEdit trigger didn't fire (e.g. status was set
 * via a script rather than a manual edit).
 */
function manualMarkBatchDone(batchLabel) {
  const nowTs = fmtTs(nowJkt());
  const all = readAllRows(SHEET.KOMISI_DISBURSEMENTS);
  let count = 0;
  all.forEach(d => {
    if (d.batch === batchLabel && d.status === STATUS.DISB_QUEUED) {
      updateRow(SHEET.KOMISI_DISBURSEMENTS, d._rowNum, {
        status:       STATUS.DISB_SENT,
        processed_at: nowTs,
      });
      count++;
    }
  });

  // Update the progress row too
  const progRow = findRow(SHEET.DISBURSEMENT_PROGRESS, 'batch', batchLabel);
  if (progRow) {
    updateRow(SHEET.DISBURSEMENT_PROGRESS, progRow._rowNum, {
      status:       DISBURSEMENT_STATUS.DONE,
      processed_at: nowTs,
    });
  }

  Logger.log('manualMarkBatchDone: batch=' + batchLabel + ' updated=' + count);
  return { batch: batchLabel, updated: count };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a phone for the disbursement upload format:
 *   "08123456789"   → "8123456789"
 *   " 8123456789 "  → "8123456789"
 *   "+628123..."    → "628123..."  (leading 0 only stripped — not +62)
 *   ""              → ""           (caller should filter out empties)
 */
function normalizeUidForDisbursement_(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/\D/g, '').replace(/^0+/, '');
}