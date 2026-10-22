/**
 * 06_Disbursement.gs — The Thursday cron that credits komisi to BukuAgen balances.
 * Schedule via a time-based trigger: every Thursday at 10:00 WIB.
 *
 * Changes vs. previous version:
 *   - Batch matching now uses Indonesian date strings ("5 Juni 2026") instead of
 *     the old slug format ("thu_jun4").  This aligns with KOMISI_DISBURSEMENTS.batch
 *     as written by 04_Redeem.gs via batchLabelForScratch().
 *   - The cron resolves "which batch is due today" by calling batchLabelForScratch()
 *     with today's date, then also queues any previously failed rows.
 */

function runThursdayDisbursementBatch() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); }
  catch (e) { Logger.log('disbursement: could not acquire lock'); return; }

  try {
    const now       = nowJkt();
    const todayBatch = batchLabelForScratch(now); // e.g. "5 Juni 2026"

    if (!todayBatch) {
      Logger.log('disbursement: today is outside all campaign windows — nothing to process');
      return;
    }

    Logger.log('disbursement: processing batch "' + todayBatch + '"');

    const all = readAllRows(SHEET.KOMISI_DISBURSEMENTS);

    // Process rows that are QUEUED and belong to today's batch, OR previously FAILED
    const eligible = all.filter(d =>
      (d.status === STATUS.DISB_QUEUED && d.batch === todayBatch) ||
      d.status === STATUS.DISB_FAILED
    );

    Logger.log('disbursement: ' + eligible.length + ' rows to process');
    eligible.forEach(d => {
      const ok    = callBalanceApi(d);
      const nowTs = fmtTs(nowJkt());
      updateRow(SHEET.KOMISI_DISBURSEMENTS, d._rowNum, {
        status:       ok ? STATUS.DISB_SENT : STATUS.DISB_FAILED,
        processed_at: nowTs,
      });
    });

    Logger.log('disbursement: done');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Calls the BukuAgen balance API to credit komisi.
 * Stub — replace with the real endpoint in production.
 * Must return true on success, false on failure.
 */
function callBalanceApi(disbursement) {
  Logger.log('callBalanceApi: STUB — would credit Rp ' +
    Number(disbursement.value_idr).toLocaleString('id-ID') +
    ' for redemption ' + disbursement.redemption_id +
    ' (batch: ' + disbursement.batch + ')');
  return true;
}

/**
 * Manual helper — preview what would be disbursed if run right now.
 * Call from the editor to verify before the actual Thursday cron fires.
 */
function previewTodaysDisbursement() {
  const now        = nowJkt();
  const todayBatch = batchLabelForScratch(now);
  const all        = readAllRows(SHEET.KOMISI_DISBURSEMENTS);
  const eligible   = all.filter(d =>
    (d.status === STATUS.DISB_QUEUED && d.batch === todayBatch) ||
    d.status === STATUS.DISB_FAILED
  );
  const total = eligible.reduce((sum, d) => sum + Number(d.value_idr), 0);
  Logger.log('Preview — batch: "' + todayBatch + '" | rows: ' + eligible.length +
             ' | total: Rp ' + total.toLocaleString('id-ID'));
  return { batch: todayBatch, count: eligible.length, total_idr: total };
}