/**
 * 07_LivestreamDraw.gs — Run by the livestream operator on the draw date.
 * Picks N random winners from each wave's pending entries, assigns grand prizes,
 * marks remaining entries as not_drawn, queues physical dispatch.
 */

/** Public entry — operator calls this on 17 Jun for wave1, 12 Jul for wave2. */
function drawWave(waveId) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(60000);
  } catch (e) {
    throw new Error('Cannot acquire lock');
  }
  try {
    const wave = findRow(SHEET.DRAW_WAVES, 'wave_id', waveId);
    if (!wave) throw new Error('Wave not found: ' + waveId);
    if (wave.status === STATUS.WAVE_DRAWN) {
      Logger.log('drawWave: ' + waveId + ' already drawn');
      return { ok: false, error: 'already_drawn' };
    }

    const allEntries = readAllRows(SHEET.DRAW_ENTRIES);
    const pending = allEntries.filter(e =>
      e.wave_id === waveId && e.result === STATUS.DRAW_PENDING
    );

    const grandPrizes = readAllRows(SHEET.GRAND_PRIZES);
    const prizeSlots = expandGrandPrizes(grandPrizes, waveId);
    const totalPrizes = prizeSlots.length;

    Logger.log('drawWave: ' + waveId + ' has ' + pending.length + ' pending, ' +
               totalPrizes + ' prizes to award');

    if (pending.length === 0) {
      updateRow(SHEET.DRAW_WAVES, wave._rowNum, { status: STATUS.WAVE_DRAWN });
      return { ok: true, winners: [], note: 'No pending entries to draw' };
    }

    const shuffled = shuffleArray(pending.slice());
    const winners = shuffled.slice(0, Math.min(totalPrizes, shuffled.length));
    const losers = shuffled.slice(winners.length);

    const now = fmtTs(nowJkt());
    const winnerResults = [];
    winners.forEach((entry, i) => {
      const prize = prizeSlots[i];
      updateRow(SHEET.DRAW_ENTRIES, entry._rowNum, {
        grand_prize_id: prize.grand_prize_id,
        result: STATUS.DRAW_WON,
        drawn_at: now,
      });
      appendRow(SHEET.PHYSICAL_DISPATCH, {
        dispatch_id: genId('disp'),
        entry_id: entry.entry_id,
        courier: '',
        tracking_number: '',
        status: STATUS.DISB_QUEUED,
        queued_at: now,
        shipped_at: '',
      });
      winnerResults.push({
        entry_id: entry.entry_id,
        redemption_id: entry.redemption_id,
        grand_prize: prize,
      });
    });

    losers.forEach(entry => {
      updateRow(SHEET.DRAW_ENTRIES, entry._rowNum, {
        result: STATUS.DRAW_NOT_DRAWN,
        drawn_at: now,
      });
    });

    updateRow(SHEET.DRAW_WAVES, wave._rowNum, { status: STATUS.WAVE_DRAWN });

    return { ok: true, winners: winnerResults, not_drawn: losers.length };
  } finally {
    lock.releaseLock();
  }
}

/** Expands the grand_prizes table into one slot per individual prize. */
function expandGrandPrizes(grandPrizes, waveId) {
  const slots = [];
  grandPrizes.forEach(gp => {
    const alloc = gp.wave_allocation;
    let countForWave = 0;
    if (alloc === 'split') {
      countForWave = Math.floor(Number(gp.total_qty) / 2);
      if (waveId === 'wave2' && Number(gp.total_qty) % 2 === 1) countForWave++;
    } else if (alloc === waveId) {
      countForWave = Number(gp.total_qty);
    }
    for (let i = 0; i < countForWave; i++) {
      slots.push({
        grand_prize_id: gp.grand_prize_id,
        tier: gp.tier,
        label: gp.label,
        value_idr: Number(gp.value_idr),
      });
    }
  });
  return slots;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}