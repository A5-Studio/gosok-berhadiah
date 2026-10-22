/**
 * 04_Redeem.gs — POST /redeem
 * The merchant taps "Gosok di sini" — this is the entry point that decides the prize.
 * Wrapped in LockService because it touches shared inventory.
 *
 * Changes vs. original:
 *   - CAMPAIGN_COL.ELIGIBLE used for eligibility check (not o.eligible)
 *   - merchantName fetched from order.name → written to KOMISI_DISBURSEMENTS + DRAW_ENTRIES
 *   - user_id written to KOMISI_DISBURSEMENTS and DRAW_ENTRIES
 *   - Dummy mode: redeemDummy() handles entirely within DUMMY_CARDS tab
 *   - generateDrawCode_ defined locally to avoid Apps Script load-order issues
 */

// Local copy — avoids load-order dependency on 00_Config.gs
function generateDrawCode_() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 5; i++) {
    suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return 'GOSOK-' + suffix;
}

function redeemCard(payload) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: 'system_busy', message: 'Sistem sibuk, coba lagi sebentar' };
  }
  try {
    return redeemCardInner(payload);
  } finally {
    lock.releaseLock();
  }
}

function redeemCardInner(payload) {
  const { card_id, uid, idempotency_key, user_agent, ip_address } = payload || {};
  if (!card_id || !uid) {
    return { ok: false, error: 'missing_params', message: 'card_id atau uid kosong' };
  }
  const cleanUid = String(uid).replace(/\D/g, '');
  const now = nowJkt();
  const cfg = getConfig();

  const cutoff = new Date(cfg.scratch_cutoff + ' GMT+0700');
  if (now > cutoff) {
    return { ok: false, error: 'campaign_ended', message: 'Periode gosok sudah berakhir tanggal 10 Juli' };
  }

  if (idempotency_key) {
    const prior = findRow(SHEET.REDEMPTIONS, 'idempotency_key', idempotency_key);
    if (prior) return buildRedeemResponse(prior, cfg, true);
  }

  // ── Dummy card intercept ────────────────────────────────────────────────────
  // If card_id belongs to DUMMY_CARDS, handle entirely within that sheet.
  // Zero reads or writes to any other tab.
  const dummySlot = findDummySlotByCardId(card_id, cleanUid);
  if (dummySlot === false) {
    return { ok: false, error: 'uid_card_mismatch', message: 'Kartu ini bukan milik UID kamu' };
  }
  if (dummySlot !== null) {
    return redeemDummy(dummySlot, cleanUid, now);
  }

  // ── Production path — real SCRATCH_CARDS + ORDERS ───────────────────────
  const card = findRow(SHEET.SCRATCH_CARDS, 'card_id', card_id);
  if (!card) {
    return { ok: false, error: 'card_not_found', message: 'Kartu tidak ditemukan' };
  }
  if (card.status === STATUS.CARD_SCRATCHED) {
    const prior = findRow(SHEET.REDEMPTIONS, 'card_id', card_id);
    if (prior) return buildRedeemResponse(prior, cfg, true);
  }
  if (card.status === STATUS.CARD_VOIDED) {
    return { ok: false, error: 'card_voided', message: 'Kartu ini sudah tidak berlaku' };
  }
  if (card.status === STATUS.CARD_EXPIRED) {
    return { ok: false, error: 'card_expired', message: 'Kartu ini sudah kedaluwarsa' };
  }

  const order = findRow(SHEET.ORDERS, 'order_id', card.order_id);
  if (!order || String(order.user_id) !== cleanUid) {
    return { ok: false, error: 'uid_card_mismatch', message: 'Kartu ini bukan milik UID kamu' };
  }
  // Check eligibility from MINT_LOG (not Raw Order Data columns)
  const mintLogRow = findRow(SHEET.MINT_LOG, MINT_LOG_COL.ORDER_ID, card.order_id);
  const isOrderEligible = mintLogRow &&
    (mintLogRow.eligible === true || mintLogRow.eligible === 'TRUE');
  if (!isOrderEligible) {
    return { ok: false, error: 'order_not_eligible', message: 'Pesanan belum dikonfirmasi ops' };
  }
  const merchantName = String(order.name || '');
  const pickResult   = pickPrize(now);
  const redemptionId = genId('red');
  const nowTs        = fmtTs(now);

  const redemption = {
    redemption_id:   redemptionId,
    card_id:         card_id,
    user_id:         cleanUid,
    outcome_type:    pickResult.outcome_type,
    cash_prize_id:   pickResult.outcome_type === OUTCOME.CASH ? pickResult.cash_prize_id : '',
    scratched_at:    nowTs,
    ip_address:      ip_address || '',
    user_agent:      user_agent || '',
    idempotency_key: idempotency_key || '',
  };
  appendRow(SHEET.REDEMPTIONS, redemption);
  updateRow(SHEET.SCRATCH_CARDS, card._rowNum, { status: STATUS.CARD_SCRATCHED, scratched_at: nowTs });

  if (pickResult.outcome_type === OUTCOME.CASH) {
    decrementField(SHEET.CASH_PRIZES, 'cash_prize_id', pickResult.cash_prize_id, 'remaining_qty', 1);
    incrementCompositeField(SHEET.CASH_PRIZE_DAILY_QUOTAS,
      'date', fmtDate(now),
      'cash_prize_id', pickResult.cash_prize_id,
      'given_out_today', 1);
    appendRow(SHEET.KOMISI_DISBURSEMENTS, {
      disbursement_id: genId('disb'),
      redemption_id:   redemptionId,
      user_id:         cleanUid,
      name:            merchantName,
      value_idr:       pickResult.value_idr,
      batch:           batchLabelForScratch(now),
      status:          STATUS.DISB_QUEUED,
      queued_at:       nowTs,
      processed_at:    '',
    });
  } else {
    appendRow(SHEET.DRAW_ENTRIES, {
      entry_id:       genId('dr'),
      redemption_id:  redemptionId,
      user_id:        cleanUid,
      wave_id:        waveForScratch(now),
      draw_code:      generateDrawCode_(),
      grand_prize_id: '',
      result:         STATUS.DRAW_PENDING,
      entered_at:     nowTs,
      drawn_at:       '',
    });
  }

  return buildRedeemResponse(redemption, cfg, false);
}

/**
 * redeemDummy — handles scratch for a dummy slot.
 * ONLY reads/writes DUMMY_CARDS. Zero contact with any other sheet.
 * Returns a response identical in shape to buildRedeemResponse.
 */
function redeemDummy(slot, cleanUid, now) {
  const nowTs     = fmtTs(now);
  const prizeTier = String(slot.prize_tier || '');
  const isDraw    = prizeTier === 'draw';

  // Mark scratched_at + batch in DUMMY_CARDS, keep active=TRUE (auto-reset = repeatable)
  updateRow(SHEET.DUMMY_CARDS, slot._rowNum, {
    scratched_at: nowTs,
    batch:        isDraw ? '' : batchLabelForScratch(now),
    active:       true,
  });

  const TIER_VALUES = {
    cash_5k: 5000, cash_10k: 10000, cash_20k: 20000,
    cash_50k: 50000, cash_100k: 100000, cash_200k: 200000,
  };
  const TIER_LABELS = {
    cash_5k:   'Komisi Agen Rp 5.000',   cash_10k:  'Komisi Agen Rp 10.000',
    cash_20k:  'Komisi Agen Rp 20.000',  cash_50k:  'Komisi Agen Rp 50.000',
    cash_100k: 'Komisi Agen Rp 100.000', cash_200k: 'Komisi Agen Rp 200.000',
  };

  const out = {
    ok:                   true,
    duplicate:            false,
    redemption_id:        'DUMMY-RED-' + slot.card_id,
    card_id:              String(slot.card_id),
    outcome_type:         isDraw ? OUTCOME.DRAW : OUTCOME.CASH,
    scratched_at_server:  nowTs,
    cash_prize:           null,
    disbursement:         null,
    draw_entry:           null,
  };

  if (isDraw) {
    const waveId = waveForScratch(now);
    // Read wave info (read-only)
    const waves  = readAllRows(SHEET.DRAW_WAVES);
    const wave   = waves.find(w => w.wave_id === waveId);
    out.draw_entry = {
      entry_id:        'DUMMY-ENTRY-' + slot.card_id,
      wave_id:         waveId,
      draw_code:       String(slot.draw_code || generateDrawCode_()),
      wave_label:      wave ? wave.label : waveId,
      livestream_date: wave ? fmtDate(wave.livestream_date) : null,
      livestream_url:  wave ? wave.livestream_url : LIVESTREAM_URL,
      result:          STATUS.DRAW_PENDING,
      message:         'Kamu masuk POOL HADIAH SPESIAL! Nonton Livestream Instagram BukuAgen ' +
                       (wave ? 'tanggal ' + fmtDate(wave.livestream_date) : '') + ' buat tau hadiah kamu!',
    };
  } else {
    const valueIdr = TIER_VALUES[prizeTier] || 0;
    const batch    = batchLabelForScratch(now);
    out.cash_prize = {
      cash_prize_id: prizeTier,
      tier:          prizeTier,
      value_idr:     valueIdr,
      label:         TIER_LABELS[prizeTier] || prizeTier,
    };
    out.disbursement = {
      status:  STATUS.DISB_QUEUED,
      batch:   batch,
      message: TIER_LABELS[prizeTier] + ' bakal masuk saldo BukuAgen hari Kamis sesuai batch ' + batch,
    };
  }

  Logger.log('redeemDummy: uid=' + cleanUid + ' tier=' + prizeTier + ' card=' + slot.card_id);
  return out;
}

function buildRedeemResponse(redemption, cfg, fromIdempotency) {
  const out = {
    ok: true,
    duplicate: !!fromIdempotency,
    redemption_id: redemption.redemption_id,
    card_id: redemption.card_id,
    outcome_type: redemption.outcome_type,
    scratched_at_server: redemption.scratched_at ? fmtTs(redemption.scratched_at) : null,
    cash_prize: null,
    disbursement: null,
    draw_entry: null,
  };

  if (redemption.outcome_type === OUTCOME.CASH) {
    const cp = findRow(SHEET.CASH_PRIZES, 'cash_prize_id', redemption.cash_prize_id);
    if (cp) {
      out.cash_prize = {
        cash_prize_id: cp.cash_prize_id,
        tier:          cp.tier,
        value_idr:     Number(cp.value_idr),
        label:         cp.label_id,
      };
    }
    const disb = findRow(SHEET.KOMISI_DISBURSEMENTS, 'redemption_id', redemption.redemption_id);
    if (disb) {
      out.disbursement = {
        status:  disb.status,
        batch:   disb.batch,
        message: 'Komisi ' + (cp ? cp.label_id : '') + ' bakal masuk saldo BukuAgen hari Kamis sesuai batch ' + disb.batch,
      };
    }
  } else if (redemption.outcome_type === OUTCOME.DRAW) {
    const entry = findRow(SHEET.DRAW_ENTRIES, 'redemption_id', redemption.redemption_id);
    if (entry) {
      const wave = findRow(SHEET.DRAW_WAVES, 'wave_id', entry.wave_id);
      out.draw_entry = {
        entry_id:        entry.entry_id,
        wave_id:         entry.wave_id,
        draw_code:       entry.draw_code || null,
        wave_label:      wave ? wave.label : entry.wave_id,
        livestream_date: wave ? fmtDate(wave.livestream_date) : null,
        livestream_url:  wave ? wave.livestream_url : null,
        result:          entry.result,
        message:         'Kamu masuk POOL HADIAH SPESIAL! Nonton Livestream Instagram BukuAgen tanggal ' +
          (wave ? fmtDate(wave.livestream_date) : '') + ' buat tau hadiah kamu!',
      };
    }
  }
  return out;
}

function backfillDrawCodes() {
  const entries = readAllRows(SHEET.DRAW_ENTRIES);
  let count = 0;
  entries.forEach(e => {
    if (!e.draw_code) {
      updateRow(SHEET.DRAW_ENTRIES, e._rowNum, { draw_code: generateDrawCode_() });
      count++;
    }
  });
  Logger.log('Backfilled ' + count + ' draw codes');
}