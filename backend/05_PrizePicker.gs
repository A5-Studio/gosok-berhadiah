/**
 * 05_PrizePicker.gs — Weighted random pick with daily quota smoothing.
 * Called from inside redeemCardInner under LockService — do not call elsewhere.
 */

/**
 * Decides the outcome of a scratch.
 * @param {Date} now - server time of the scratch
 * @return {{outcome_type: string, cash_prize_id?: string, value_idr?: number}}
 */
function pickPrize(now) {
  const cfg = getConfig();
  const drawRatio = Number(cfg.draw_pool_ratio) || 0.03;
  const today = fmtDate(now);

  const cashPrizes = readAllRows(SHEET.CASH_PRIZES);
  const quotas = readAllRows(SHEET.CASH_PRIZE_DAILY_QUOTAS).filter(q => q.date === today);
  const quotaMap = {};
  quotas.forEach(q => {
    const remaining = Number(q.daily_qty) - Number(q.given_out_today);
    quotaMap[q.cash_prize_id] = remaining;
  });

  const eligibleTiers = cashPrizes.filter(p => {
    const inv = Number(p.remaining_qty);
    const daily = quotaMap[p.cash_prize_id];
    return inv > 0 && (daily === undefined || daily > 0);
  });

  if (eligibleTiers.length === 0) {
    return { outcome_type: OUTCOME.DRAW };
  }

  const isDraw = Math.random() < drawRatio;
  if (isDraw) {
    return { outcome_type: OUTCOME.DRAW };
  }

  const totalWeight = eligibleTiers.reduce((sum, p) => {
    return sum + Number(p.remaining_qty) * Number(p.weight_multiplier || 1);
  }, 0);

  let roll = Math.random() * totalWeight;
  for (const p of eligibleTiers) {
    const w = Number(p.remaining_qty) * Number(p.weight_multiplier || 1);
    roll -= w;
    if (roll <= 0) {
      return {
        outcome_type: OUTCOME.CASH,
        cash_prize_id: p.cash_prize_id,
        value_idr: Number(p.value_idr),
      };
    }
  }
  const last = eligibleTiers[eligibleTiers.length - 1];
  return {
    outcome_type: OUTCOME.CASH,
    cash_prize_id: last.cash_prize_id,
    value_idr: Number(last.value_idr),
  };
}

/**
 * Re-distributes remaining inventory across remaining days.
 * Run manually after ops edits CASH_PRIZES (adds budget, new tier, etc).
 */
function regenerateDailyQuotas() {
  const cfg = getConfig();
  const today = fmtDate(nowJkt());
  const cutoff = fmtDate(new Date(cfg.scratch_cutoff + ' GMT+0700'));
  const daysRemaining = Math.max(1, dateDiff(today, cutoff) + 1);

  const cashPrizes = readAllRows(SHEET.CASH_PRIZES);
  const quotas = readAllRows(SHEET.CASH_PRIZE_DAILY_QUOTAS);

  cashPrizes.forEach(p => {
    const remainingInv = Number(p.remaining_qty);
    const perDay = Math.max(1, Math.ceil(remainingInv / daysRemaining));
    quotas.filter(q => q.cash_prize_id === p.cash_prize_id && q.date >= today)
      .forEach(q => {
        updateRow(SHEET.CASH_PRIZE_DAILY_QUOTAS, q._rowNum, { daily_qty: perDay });
      });
  });
  Logger.log('regenerateDailyQuotas: redistributed across ' + daysRemaining + ' days');
}

function dateDiff(d1Str, d2Str) {
  const d1 = new Date(d1Str + 'T00:00:00+07:00');
  const d2 = new Date(d2Str + 'T00:00:00+07:00');
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

/**
 * Records an audit row for a CASH_PRIZES edit and bumps remaining_qty when total_qty grows.
 * Call this from a sheet onEdit trigger, or invoke manually after ops edits.
 */
function logCashPrizeAudit(cashPrizeId, fieldChanged, oldValue, newValue, changedBy, reason) {
  appendRow(SHEET.CASH_PRIZE_AUDIT, {
    audit_id: genId('audit'),
    cash_prize_id: cashPrizeId,
    field_changed: fieldChanged,
    old_value: oldValue,
    new_value: newValue,
    changed_by: changedBy || 'unknown',
    changed_at: fmtTs(nowJkt()),
    reason: reason || '',
  });
  if (fieldChanged === 'total_qty' && Number(newValue) > Number(oldValue)) {
    const delta = Number(newValue) - Number(oldValue);
    incrementField(SHEET.CASH_PRIZES, 'cash_prize_id', cashPrizeId, 'remaining_qty', delta);
  }
}