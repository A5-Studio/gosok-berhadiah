/**
 * 00_Config.gs — Sheet names, constants, helpers shared across modules.
 * Read once, used everywhere. Change the spreadsheet ID below before deploying.
 *
 * Changes vs. previous version:
 *   - generateDrawCode()  : prefix changed from "GSK-" to "GOSOK-" (5-char suffix)
 *   - batchLabelForScratch(): explicit date-range mapping → Indonesian date string
 *     "5 Juni 2026" format (used directly in KOMISI_DISBURSEMENTS.batch + frontend)
 *   - waveForScratch()    : updated wave boundaries per campaign spec
 *   - LIVESTREAM_URL      : updated to https://instagram.com/bukuwarung_
 *   - SOURCE_SHEET_NAME   : points to "Raw Order Data" (production sheet)
 *   - ORDERS_APPEND_START_COL : campaign columns start at AA (col 27), never touches A–Z
 */

const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';

// ─── The production raw data sheet ────────────────────────────────────────────
const SOURCE_SHEET_NAME = 'Raw Order Data';
// Raw Order Data columns A–Z (1–26) are NEVER touched by any script.
// Sync state is stored in MINT_LOG sheet instead of AA-AC columns.

// ─── MINT_LOG field names ──────────────────────────────────────────────────────
const MINT_LOG_COL = {
  ORDER_ID:     'order_id',
  USER_ID:      'user_id',
  ELIGIBLE:     'eligible',
  CARDS_MINTED: 'cards_minted',
  LAST_SYNC:    'last_sync',
  PRODUCT_NAME: 'product_name',
  PAID_AT:      'paid_at_jkt',
};

// ─── All supporting/output sheet names ────────────────────────────────────────
const SHEET = {
  ORDERS:                  'Raw Order Data',
  CASH_PRIZES:             'CASH_PRIZES',
  CASH_PRIZE_DAILY_QUOTAS: 'CASH_PRIZE_DAILY_QUOTAS',
  GRAND_PRIZES:            'GRAND_PRIZES',
  DRAW_WAVES:              'DRAW_WAVES',
  SCRATCH_CARDS:           'SCRATCH_CARDS',
  REDEMPTIONS:             'REDEMPTIONS',
  DRAW_ENTRIES:            'DRAW_ENTRIES',
  KOMISI_DISBURSEMENTS:    'KOMISI_DISBURSEMENTS',
  PHYSICAL_DISPATCH:       'PHYSICAL_DISPATCH',
  CASH_PRIZE_AUDIT:        'CASH_PRIZE_AUDIT',
  CONFIG:                  'CONFIG',
  DUMMY_CARDS:             'DUMMY_CARDS',   // test harness — no production side effects
  MINT_LOG:                'MINT_LOG',       // sync state — replaces AA-AC cols in Raw Order Data
  DISBURSEMENT_PROGRESS:   'DISBURSEMENT_PROGRESS', // per-batch CSV export + finance handoff state
};

const STATUS = {
  CARD_BOUND:      'bound',
  CARD_SCRATCHED:  'scratched',
  CARD_VOIDED:     'voided',
  CARD_EXPIRED:    'expired',
  DISB_QUEUED:     'queued',
  DISB_SENT:       'sent',
  DISB_FAILED:     'failed',
  DRAW_PENDING:    'pending',
  DRAW_WON:        'won',
  DRAW_NOT_DRAWN:  'not_drawn',
  WAVE_PENDING:    'pending',
  WAVE_DRAWN:      'drawn',
};

const OUTCOME = {
  CASH: 'cash',
  DRAW: 'draw',
};

// ─── Livestream URL ────────────────────────────────────────────────────────────
const LIVESTREAM_URL = 'https://instagram.com/bukuwarung_';

// ─── Indonesian month names ────────────────────────────────────────────────────
const ID_MONTHS = [
  '', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

// ─── Disbursement schedule ─────────────────────────────────────────────────────
// Each entry: [scratchFrom, scratchTo (inclusive), disbursementDate]
// Dates are compared as 'yyyy-MM-dd' strings (JKT).
// Last batch has a time-of-day cutoff (8 Jul 11:59 WIB) — handled in batchLabelForScratch.
const DISBURSEMENT_SCHEDULE = [
  { from: '2026-06-01', to: '2026-06-03', disb: { d:  5, m: 6,  y: 2026 } },
  { from: '2026-06-04', to: '2026-06-10', disb: { d: 12, m: 6,  y: 2026 } },
  { from: '2026-06-11', to: '2026-06-17', disb: { d: 19, m: 6,  y: 2026 } },
  { from: '2026-06-18', to: '2026-06-25', disb: { d: 26, m: 6,  y: 2026 } },
  { from: '2026-06-26', to: '2026-07-01', disb: { d:  3, m: 7,  y: 2026 } },
  { from: '2026-07-02', to: '2026-07-08', disb: { d: 10, m: 7,  y: 2026 } },
];

// ─── Wave / draw-wave schedule ────────────────────────────────────────────────
// Scratch 1 Jun – 16 Jun  → Wave 1, livestream 17 Jun 2026
// Scratch 17 Jun – 8 Jul 11:59 WIB → Wave 2, livestream 8 Jul 2026
const WAVE_SCHEDULE = [
  {
    wave_id:            'wave1',
    label:              'Wave 1',
    scratch_from:       '2026-06-01',
    scratch_to:         '2026-06-16',  // inclusive (no time cutoff for wave1)
    livestream_date:    '2026-06-17',
    livestream_url:     LIVESTREAM_URL,
    prizes_allocated:   8,
    status:             'pending',
  },
  {
    wave_id:            'wave2',
    label:              'Wave 2',
    scratch_from:       '2026-06-17',
    scratch_to:         '2026-07-08',  // cutoff 11:59 WIB enforced in waveForScratch()
    livestream_date:    '2026-07-08',
    livestream_url:     LIVESTREAM_URL,
    prizes_allocated:   9,
    status:             'pending',
  },
];

// ─── Core helpers ──────────────────────────────────────────────────────────────

/** Returns the spreadsheet bound to this script. Falls back to active sheet for testing. */
function ss() {
  if (SPREADSHEET_ID && SPREADSHEET_ID.indexOf('__') === -1) {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Reads all CONFIG key-value pairs into a single object. Cached per execution. */
let _configCache = null;
function getConfig() {
  if (_configCache) return _configCache;
  const rows = readAllRows(SHEET.CONFIG);
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  _configCache = out;
  return out;
}

/** Writes a CONFIG key, updating in place if present. */
function setConfig(key, value) {
  _configCache = null;
  upsertRow(SHEET.CONFIG, 'key', { key: key, value: String(value), description: '' });
}

/** Formats a Date to JKT timestamp string. */
function fmtTs(d) {
  if (!d) return '';
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss');
}

/** Formats a Date to JKT date-only string. */
function fmtDate(d) {
  if (!d) return '';
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, 'Asia/Jakarta', 'yyyy-MM-dd');
}

/** Formats a Date to Indonesian locale string, e.g. "5 Juni 2026". */
function fmtDateId(d) {
  if (!(d instanceof Date)) d = new Date(d);
  const day   = Number(Utilities.formatDate(d, 'Asia/Jakarta', 'd'));
  const month = Number(Utilities.formatDate(d, 'Asia/Jakarta', 'M'));
  const year  = Number(Utilities.formatDate(d, 'Asia/Jakarta', 'yyyy'));
  return day + ' ' + ID_MONTHS[month] + ' ' + year;
}

function nowJkt() {
  return new Date();
}

/** Generates a short, URL-safe id with a prefix. */
function genId(prefix) {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).substring(2, 8);
  return prefix + '_' + ts + rnd;
}

/**
 * Generates a human-readable card ID like "KARTUGOSOK-A3FX9B2K".
 * Uses unambiguous alphabet (no 0/O/1/I/L).
 * This is shown to merchants in the popup header and used as the card identifier.
 */
function generateCardId() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return 'KARTUGOSOK-' + suffix;
}

// ─── Batch label — Indonesian date string ─────────────────────────────────────
/**
 * Returns the disbursement batch label for a given scratch date/time.
 * Format: "5 Juni 2026" (Indonesian date, matches KOMISI_DISBURSEMENTS.batch + frontend).
 *
 * The last window has a 11:59 WIB cutoff on 8 Jul 2026.
 * Any scratch after that is out-of-campaign and returns null.
 *
 * @param  {Date} scratchDate
 * @return {string|null}
 */
function batchLabelForScratch(scratchDate) {
  const sd = fmtDate(scratchDate); // 'yyyy-MM-dd' in JKT

  for (let i = 0; i < DISBURSEMENT_SCHEDULE.length; i++) {
    const slot = DISBURSEMENT_SCHEDULE[i];

    // Special handling for the last slot: apply 11:59 WIB time cutoff
    if (i === DISBURSEMENT_SCHEDULE.length - 1) {
      const cutoffMs = new Date('2026-07-08T11:59:00+07:00').getTime();
      if (scratchDate.getTime() > cutoffMs) return null;
    }

    if (sd >= slot.from && sd <= slot.to) {
      const disb = slot.disb;
      const disbDate = new Date(disb.y, disb.m - 1, disb.d);
      return fmtDateId(disbDate);   // e.g. "5 Juni 2026"
    }
  }
  return null; // outside all windows
}

// ─── Wave assignment ───────────────────────────────────────────────────────────
/**
 * Returns 'wave1' or 'wave2' based on when the card was scratched.
 *
 * Wave 1: scratch_at on or before 16 Jun 2026 (any time)
 * Wave 2: scratch_at 17 Jun 2026 00:00 WIB up to 8 Jul 2026 11:59 WIB
 *
 * @param  {Date} scratchDate
 * @return {string}
 */
function waveForScratch(scratchDate) {
  const wave1Boundary = new Date('2026-06-16T23:59:59+07:00');
  return scratchDate <= wave1Boundary ? 'wave1' : 'wave2';
}

// ─── Dummy mode helpers ────────────────────────────────────────────────────────

/**
 * Finds a DUMMY_CARDS row by card_id and verifies uid matches.
 * Returns:
 *   - the row object if found and uid matches
 *   - false if card_id found but uid doesn't match
 *   - null if card_id not found in DUMMY_CARDS at all (production card)
 */
function findDummySlotByCardId(cardId, uid) {
  try {
    const rows = readAllRows(SHEET.DUMMY_CARDS);
    const slot = rows.find(r => String(r.card_id) === cardId);
    if (!slot) return null;                           // not a dummy card
    if (String(slot.uid) !== uid) return false;       // uid mismatch
    return slot;
  } catch (e) {
    Logger.log('findDummySlotByCardId error: ' + e.message);
    return null;
  }
}

/**
 * Returns the pickResult override for a dummy UID based on prize_tier column.
 * Called from redeemCardInner when _isDummyCard is true.
 */
function checkDummyMode(uid) {
  try {
    const rows = readAllRows(SHEET.DUMMY_CARDS);
    const slot = rows.find(r => String(r.uid) === uid);
    if (!slot) return null;

    const tier = String(slot.prize_tier || '').trim();
    if (tier === 'draw') return { outcome_type: OUTCOME.DRAW };

    const cashPrizes = readAllRows(SHEET.CASH_PRIZES);
    const cp = cashPrizes.find(p => p.cash_prize_id === tier);
    if (!cp) {
      Logger.log('DummyMode: unknown tier "' + tier + '" — falling back to real picker');
      return null;
    }
    return { outcome_type: OUTCOME.CASH, cash_prize_id: cp.cash_prize_id, value_idr: Number(cp.value_idr) };
  } catch (e) {
    Logger.log('checkDummyMode error: ' + e.message);
    return null;
  }
}

/**
 * Marks a dummy slot as scratched (active=FALSE) so lookupDummy shows scratched state.
 * In practice this is immediately followed by resetDummySlot, so the window is tiny.
 */
function markDummySlotScratched(uid) {
  try {
    const rows = readAllRows(SHEET.DUMMY_CARDS);
    rows.filter(r => String(r.uid) === uid).forEach(r => {
      updateRow(SHEET.DUMMY_CARDS, r._rowNum, { active: false });
    });
  } catch (e) {
    Logger.log('markDummySlotScratched error: ' + e.message);
  }
}

/**
 * Reactivates all dummy slots for a UID (active=TRUE) after a test scratch.
 */
function resetDummySlot(uid) {
  try {
    const rows = readAllRows(SHEET.DUMMY_CARDS);
    rows.filter(r => String(r.uid) === uid).forEach(r => {
      updateRow(SHEET.DUMMY_CARDS, r._rowNum, { active: true });
    });
  } catch (e) {
    Logger.log('resetDummySlot error: ' + e.message);
  }
}