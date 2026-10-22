/**
 * 10_LiveDrawAttendance.gs — Livestream draw gated by FORM_LIVE attendance.
 *
 * Flow:
 *   1. Merchant fills Google Form → submits to FORM_LIVE sheet
 *   2. Operator opens draw_operator.html before livestream
 *   3. Calls drawPreflightWithAttendance(waveId) → sees pool stats
 *   4. Calls drawWaveWithAttendance(waveId) → runs draw, only attendees eligible
 *   5. Winners revealed in draw_operator.html
 *
 * FORM_LIVE sheet columns (Google Form output — do NOT rename headers):
 *   A  Timestamp
 *   B  Nomor HP yang Digunakan Saat Pembelian EDC BukuAgen
 *   C  Tanggal Undian
 *   D  normalized_phone   ← add this formula column manually (see below)
 *   E  wave_id            ← add this formula column manually (see below)
 *
 * Formula for D2 (normalized_phone):
 *   =IF(B2="","",REGEXREPLACE(REGEXREPLACE(TO_TEXT(B2),"[^0-9]",""),"^(62|0)",""))
 *
 * Formula for E2 (wave_id):
 *   =IF(C2="17 Juni 2026","wave1",IF(C2="8 Juli 2026","wave2","unknown"))
 *
 * Drag both formulas down to cover all form response rows.
 * The .gs reads col B directly and normalizes in code — col D/E are for
 * human inspection only and do not need to exist for the scripts to work.
 *
 * Public API (called from 08_WebApp.gs):
 *   drawPreflightWithAttendance(waveId)  → stats, no side effects
 *   drawWaveWithAttendance(waveId)       → runs draw (one-time, locked)
 *   getDrawWinners(waveId)               → current winners for display
 */

// ─── Constants ─────────────────────────────────────────────────────────────────

const FORM_LIVE_SHEET = 'FORM_LIVE';

// Must match exactly how the Google Form dropdown option is worded
const WAVE_DATE_LABEL = {
  wave1: '17 Juni 2026',
  wave2: '8 Juli 2026',
};

// Google Form column headers — match exactly, spaces included
const FORM_COL_PHONE  = 'Nomor HP yang Digunakan Saat Pembelian EDC BukuAgen';
const FORM_COL_TANGGAL = 'Tanggal Undian';

// ─── Phone normalization ───────────────────────────────────────────────────────

/**
 * Strips non-digits and removes leading "62" or "0" prefix.
 * "081234567890"    → "81234567890"
 * "+6281234567890"  → "81234567890"
 * "6281234567890"   → "81234567890"
 * Already normalized "81234567890" → "81234567890"
 */
function normalizePhone_(raw) {
  if (!raw && raw !== 0) return '';
  let s = String(raw).replace(/[^0-9]/g, '');
  if (s.startsWith('62')) s = s.slice(2);
  else if (s.startsWith('0')) s = s.slice(1);
  return s;
}

/**
 * Maps a "Tanggal Undian" form value to a wave_id.
 * Returns null if value doesn't match any wave.
 */
function tanggalToWaveId_(tanggal) {
  const t = String(tanggal || '').trim();
  for (const [waveId, label] of Object.entries(WAVE_DATE_LABEL)) {
    if (t === label) return waveId;
  }
  return null;
}

/**
 * Masks middle digits of a phone for display.
 * "81234567890" → "812****7890"
 */
function maskPhone_(raw) {
  const s = normalizePhone_(raw);
  if (s.length < 7) return s;
  return s.slice(0, 3) + '****' + s.slice(-4);
}

// ─── Attendee set ──────────────────────────────────────────────────────────────

/**
 * Reads FORM_LIVE and returns a Set of normalized phone numbers
 * that registered for the given wave. Deduplicates automatically.
 * Returns an empty Set if FORM_LIVE doesn't exist yet.
 */
function getAttendeeSet_(waveId) {
  const set = new Set();
  try {
    const rows = readAllRows(FORM_LIVE_SHEET);
    rows.forEach(r => {
      const phone   = normalizePhone_(r[FORM_COL_PHONE]);
      const tanggal = String(r[FORM_COL_TANGGAL] || '').trim();
      if (!phone) return;
      if (tanggalToWaveId_(tanggal) === waveId) set.add(phone);
    });
  } catch (e) {
    Logger.log('getAttendeeSet_: ' + e.message + ' (FORM_LIVE may not exist yet)');
  }
  return set;
}

// ─── Preflight ─────────────────────────────────────────────────────────────────

/**
 * Returns pool statistics without running the draw.
 * Safe to call multiple times — no side effects.
 *
 * @param  {string} waveId  'wave1' or 'wave2'
 * @return {object}
 */
function drawPreflightWithAttendance(waveId) {
  const wave = findRow(SHEET.DRAW_WAVES, 'wave_id', waveId);
  if (!wave) return { ok: false, error: 'wave_not_found', wave_id: waveId };

  const grandPrizes = readAllRows(SHEET.GRAND_PRIZES);
  const prizeSlots  = expandGrandPrizes(grandPrizes, waveId);

  const allEntries    = readAllRows(SHEET.DRAW_ENTRIES);
  const pendingAll    = allEntries.filter(e =>
    e.wave_id === waveId && e.result === STATUS.DRAW_PENDING
  );

  const attendeeSet    = getAttendeeSet_(waveId);
  const eligiblePool   = pendingAll.filter(e =>
    attendeeSet.has(normalizePhone_(e.user_id))
  );
  const nonAttendeePool = pendingAll.filter(e =>
    !attendeeSet.has(normalizePhone_(e.user_id))
  );

  // Prize summary grouped by tier
  const prizeGroups = {};
  prizeSlots.forEach(p => {
    if (!prizeGroups[p.tier]) prizeGroups[p.tier] = { label: p.label, count: 0, value_idr: p.value_idr };
    prizeGroups[p.tier].count++;
  });

  return {
    ok:                    true,
    wave_id:               waveId,
    wave_label:            WAVE_DATE_LABEL[waveId] || waveId,
    already_drawn:         wave.status === STATUS.WAVE_DRAWN,
    total_draw_entries:    pendingAll.length,
    total_form_attendees:  attendeeSet.size,
    eligible_pool:         eligiblePool.length,
    non_attendee_entries:  nonAttendeePool.length,
    prizes_to_award:       prizeSlots.length,
    prize_summary:         Object.values(prizeGroups),
  };
}

// ─── Draw ──────────────────────────────────────────────────────────────────────

/**
 * Runs the attendance-gated draw for the given wave.
 *
 * Rules:
 *   - Only DRAW_ENTRIES whose user_id appears in FORM_LIVE for this wave
 *     are eligible to be picked as winners.
 *   - Non-attendees (in DRAW_ENTRIES but not in FORM_LIVE) are marked
 *     not_drawn — they missed their chance by not attending.
 *   - Wave is marked 'drawn' at the end; re-running returns already_drawn.
 *
 * @param  {string} waveId  'wave1' or 'wave2'
 * @return {object}
 */
function drawWaveWithAttendance(waveId) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); }
  catch (e) { return { ok: false, error: 'lock_timeout' }; }

  try {
    const wave = findRow(SHEET.DRAW_WAVES, 'wave_id', waveId);
    if (!wave) return { ok: false, error: 'wave_not_found' };
    if (wave.status === STATUS.WAVE_DRAWN) return { ok: false, error: 'already_drawn' };

    const grandPrizes = readAllRows(SHEET.GRAND_PRIZES);
    const prizeSlots  = expandGrandPrizes(grandPrizes, waveId);

    const allEntries  = readAllRows(SHEET.DRAW_ENTRIES);
    const pendingAll  = allEntries.filter(e =>
      e.wave_id === waveId && e.result === STATUS.DRAW_PENDING
    );

    const attendeeSet   = getAttendeeSet_(waveId);
    const eligible      = pendingAll.filter(e => attendeeSet.has(normalizePhone_(e.user_id)));
    const notAttended   = pendingAll.filter(e => !attendeeSet.has(normalizePhone_(e.user_id)));

    Logger.log('drawWaveWithAttendance: waveId=' + waveId +
               ' | pending=' + pendingAll.length +
               ' | attended=' + eligible.length +
               ' | absent=' + notAttended.length +
               ' | prizes=' + prizeSlots.length);

    const shuffled = shuffleArray(eligible.slice());
    const winners  = shuffled.slice(0, Math.min(prizeSlots.length, shuffled.length));
    const losers   = shuffled.slice(winners.length);

    const now = fmtTs(nowJkt());
    const winnerResults = [];

    // Process winners
    winners.forEach((entry, i) => {
      const prize = prizeSlots[i];
      updateRow(SHEET.DRAW_ENTRIES, entry._rowNum, {
        grand_prize_id: prize.grand_prize_id,
        result:         STATUS.DRAW_WON,
        drawn_at:       now,
      });
      appendRow(SHEET.PHYSICAL_DISPATCH, {
        dispatch_id:     genId('disp'),
        entry_id:        entry.entry_id,
        courier:         '',
        tracking_number: '',
        status:          STATUS.DISB_QUEUED,
        queued_at:       now,
        shipped_at:      '',
      });
      winnerResults.push({
        entry_id:    entry.entry_id,
        user_id:     maskPhone_(entry.user_id),
        draw_code:   entry.draw_code,
        prize_label: prize.label,
        prize_tier:  prize.tier,
        prize_value: prize.value_idr,
      });
    });

    // Attended but not picked
    losers.forEach(entry => {
      updateRow(SHEET.DRAW_ENTRIES, entry._rowNum, {
        result: STATUS.DRAW_NOT_DRAWN, drawn_at: now,
      });
    });

    // Absent — mark not_drawn too (wave is drawn once, they missed it)
    notAttended.forEach(entry => {
      updateRow(SHEET.DRAW_ENTRIES, entry._rowNum, {
        result: STATUS.DRAW_NOT_DRAWN, drawn_at: now,
      });
    });

    updateRow(SHEET.DRAW_WAVES, wave._rowNum, { status: STATUS.WAVE_DRAWN });

    Logger.log('drawWaveWithAttendance: done. winners=' + winners.length);
    return {
      ok:                 true,
      wave_id:            waveId,
      winners:            winnerResults,
      not_drawn_attended: losers.length,
      not_drawn_absent:   notAttended.length,
    };

  } finally {
    lock.releaseLock();
  }
}

// ─── Winners query ─────────────────────────────────────────────────────────────

/**
 * Returns all winners for a wave after the draw has run.
 * Used by draw_operator.html to reload winners without re-running.
 *
 * @param  {string} waveId  'wave1' or 'wave2'
 * @return {object}
 */
function getDrawWinners(waveId) {
  const allEntries  = readAllRows(SHEET.DRAW_ENTRIES);
  const grandPrizes = readAllRows(SHEET.GRAND_PRIZES);
  const prizeIndex  = {};
  grandPrizes.forEach(gp => { prizeIndex[gp.grand_prize_id] = gp; });

  const winners = allEntries
    .filter(e => e.wave_id === waveId && e.result === STATUS.DRAW_WON)
    .map(e => {
      const gp = prizeIndex[e.grand_prize_id] || {};
      return {
        entry_id:    e.entry_id,
        user_id:     maskPhone_(e.user_id),
        draw_code:   e.draw_code,
        prize_label: gp.label || e.grand_prize_id,
        prize_tier:  gp.tier  || '',
        prize_value: Number(gp.value_idr) || 0,
        drawn_at:    e.drawn_at,
      };
    });

  return { ok: true, wave_id: waveId, winners };
}

// ─── Pick one winner per prize slot ───────────────────────────────────────────

/**
 * drawPickOneWithAttendance — atomically picks one winner for a specific prize.
 * Stores to DRAW_ENTRIES (DRAW_WON) and creates a PHYSICAL_DISPATCH row immediately.
 * If this is the last prize slot, marks the wave WAVE_DRAWN and settles all
 * remaining DRAW_PENDING entries as DRAW_NOT_DRAWN.
 *
 * @param  {string} waveId
 * @param  {string} grandPrizeId  — from GRAND_PRIZES.grand_prize_id
 * @return {object}
 */
function drawPickOneWithAttendance(waveId, grandPrizeId) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); }
  catch (e) { return { ok: false, error: 'lock_timeout' }; }

  try {
    const wave = findRow(SHEET.DRAW_WAVES, 'wave_id', waveId);
    if (!wave) return { ok: false, error: 'wave_not_found' };
    if (wave.status === STATUS.WAVE_DRAWN) return { ok: false, error: 'already_drawn' };

    // Resolve the prize using expandGrandPrizes (schema uses wave_allocation, not wave_id per row)
    const grandPrizes = readAllRows(SHEET.GRAND_PRIZES);
    const allSlots    = expandGrandPrizes(grandPrizes, waveId);
    const thisSlots   = allSlots.filter(s => s.grand_prize_id === grandPrizeId);
    if (thisSlots.length === 0) {
      return { ok: false, error: 'prize_not_in_this_wave', grand_prize_id: grandPrizeId, wave_id: waveId };
    }
    const prize    = thisSlots[0];   // tier / label / value_idr from slot
    const quantity = thisSlots.length;

    // Count already-won slots for this specific prize
    const allEntries = readAllRows(SHEET.DRAW_ENTRIES);
    const alreadyWonThisPrize = allEntries.filter(e =>
      e.wave_id === waveId &&
      e.result  === STATUS.DRAW_WON &&
      e.grand_prize_id === grandPrizeId
    );
    if (alreadyWonThisPrize.length >= quantity) {
      return {
        ok:             false,
        error:          'no_prizes_left',
        grand_prize_id: grandPrizeId,
        drawn:          alreadyWonThisPrize.length,
        total:          quantity,
      };
    }

    // Eligible pool: attended + DRAW_PENDING + not already a winner this wave
    const attendeeSet = getAttendeeSet_(waveId);
    const wonPhones   = new Set(
      allEntries
        .filter(e => e.wave_id === waveId && e.result === STATUS.DRAW_WON)
        .map(e => normalizePhone_(e.user_id))
    );
    const eligible = allEntries.filter(e =>
      e.wave_id === waveId &&
      e.result  === STATUS.DRAW_PENDING &&
      attendeeSet.has(normalizePhone_(e.user_id)) &&
      !wonPhones.has(normalizePhone_(e.user_id))
    );

    if (eligible.length === 0) {
      return { ok: false, error: 'pool_empty' };
    }

    // Pick one
    const winner = shuffleArray(eligible.slice())[0];
    const now    = fmtTs(nowJkt());

    updateRow(SHEET.DRAW_ENTRIES, winner._rowNum, {
      grand_prize_id: grandPrizeId,
      result:         STATUS.DRAW_WON,
      drawn_at:       now,
    });
    appendRow(SHEET.PHYSICAL_DISPATCH, {
      dispatch_id:     genId('disp'),
      entry_id:        winner.entry_id,
      courier:         '',
      tracking_number: '',
      status:          STATUS.DISB_QUEUED,
      queued_at:       now,
      shipped_at:      '',
    });

    // Check if all prize slots across this wave are now filled
    // allSlots already computed above for this wave
    const totalWonNow = allEntries.filter(e =>
      e.wave_id === waveId && e.result === STATUS.DRAW_WON
    ).length + 1; // +1 because allEntries was read before the update

    const waveComplete = totalWonNow >= allSlots.length;
    if (waveComplete) {
      allEntries.forEach(e => {
        if (e.wave_id === waveId && e.result === STATUS.DRAW_PENDING) {
          updateRow(SHEET.DRAW_ENTRIES, e._rowNum, {
            result: STATUS.DRAW_NOT_DRAWN, drawn_at: now,
          });
        }
      });
      updateRow(SHEET.DRAW_WAVES, wave._rowNum, { status: STATUS.WAVE_DRAWN });
    }

    Logger.log('drawPickOneWithAttendance: wave=' + waveId +
               ' prize=' + grandPrizeId +
               ' winner=' + maskPhone_(winner.user_id) +
               ' slot=' + (alreadyWonThisPrize.length + 1) + '/' + quantity +
               ' waveComplete=' + waveComplete);

    return {
      ok:             true,
      wave_id:        waveId,
      grand_prize_id: grandPrizeId,
      prize_label:    prize.label,
      prize_tier:     prize.tier,
      prize_value:    Number(prize.value_idr) || 0,
      drawn:          alreadyWonThisPrize.length + 1,
      total:          quantity,
      wave_completed: waveComplete,
      winner: {
        entry_id:    winner.entry_id,
        user_id:     maskPhone_(winner.user_id),
        draw_code:   winner.draw_code,
        prize_label: prize.label,
        prize_tier:  prize.tier,
        prize_value: Number(prize.value_idr) || 0,
      },
    };

  } finally {
    lock.releaseLock();
  }
}

// ─── Per-prize draw progress ───────────────────────────────────────────────────

/**
 * getDrawProgress — returns per-prize draw status for the operator panel.
 * Used to render prize cards with real-time drawn/total counts.
 *
 * @param  {string} waveId
 * @return {object}
 */
function getDrawProgress(waveId) {
  const grandPrizes = readAllRows(SHEET.GRAND_PRIZES);
  const allEntries  = readAllRows(SHEET.DRAW_ENTRIES);

  // Build progress keyed by grand_prize_id using expandGrandPrizes
  // (schema uses wave_allocation + total_qty, not a wave_id column per row)
  const prizeSlots = expandGrandPrizes(grandPrizes, waveId);
  const progress   = {};
  prizeSlots.forEach(slot => {
    if (!progress[slot.grand_prize_id]) {
      progress[slot.grand_prize_id] = {
        grand_prize_id: slot.grand_prize_id,
        tier:           slot.tier,
        label:          slot.label,
        value_idr:      slot.value_idr,
        total:          0,
        drawn:          0,
        winners:        [],
      };
    }
    progress[slot.grand_prize_id].total++;
  });

  // Fill in drawn counts and winner details
  allEntries
    .filter(e => e.wave_id === waveId && e.result === STATUS.DRAW_WON)
    .forEach(e => {
      if (progress[e.grand_prize_id]) {
        progress[e.grand_prize_id].drawn++;
        progress[e.grand_prize_id].winners.push({
          entry_id:  e.entry_id,
          user_id:   maskPhone_(e.user_id),
          draw_code: e.draw_code,
          drawn_at:  e.drawn_at,
        });
      }
    });

  // Eligible pool size for display
  const attendeeSet  = getAttendeeSet_(waveId);
  const eligiblePool = allEntries.filter(e =>
    e.wave_id === waveId &&
    e.result  === STATUS.DRAW_PENDING &&
    attendeeSet.has(normalizePhone_(e.user_id))
  ).length;

  return {
    ok:            true,
    wave_id:       waveId,
    eligible_pool: eligiblePool,
    prizes:        Object.values(progress),
  };
}
