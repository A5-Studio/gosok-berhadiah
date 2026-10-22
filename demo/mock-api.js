/**
 * mock-api.js — In-browser port of the Gosok Berhadiah Apps Script backend.
 *
 * Intercepts window.fetch for any URL containing "script.google.com/macros"
 * (or the "MOCK_API" sentinel) and answers it with a JS port of backend/*.gs:
 *
 *   00_Config.gs        → constants, JKT date helpers, card/draw code generators,
 *                          batch + wave assignment, dummy-card helpers
 *   01_SheetIO.gs       → readAllRows / findRow / appendRow / updateRow / ... over
 *                          an in-memory "tables" object keyed by sheet name
 *   02_Sync.gs          → isEligibleNow, syncOrders, mintCardsForOrder, sheet seeds
 *   03_Lookup.gs        → lookupByUid, lookupDummy, enrichCard, buildSummary
 *   04_Redeem.gs        → redeemCardInner, redeemDummy, buildRedeemResponse
 *   05_PrizePicker.gs   → pickPrize (weighted, daily-quota smoothed)
 *   08_WebApp.gs        → doGet router
 *   10_LiveDrawAttendance.gs → attendance-gated preflight / run / pick-one / progress
 *
 * All seed data is synthetic. State persists to localStorage when available.
 * Iframes on the same origin reuse the parent window's MockAPI, so the merchant
 * widget, the operator panel and the demo shell all see one shared "spreadsheet".
 */
(function (global) {
  'use strict';

  var MOCK_URL_RE = /script\.google\.com\/macros|MOCK_API/;

  // ───────────────────────────────────────────────────────────────────────────
  // Shared fetch shim (installed in every window that loads this file)
  // ───────────────────────────────────────────────────────────────────────────
  function installFetch(api) {
    if (global.__gosokFetchPatched) return;
    global.__gosokFetchPatched = true;
    var origFetch = global.fetch ? global.fetch.bind(global) : null;
    var source = (global.document && global.document.documentElement &&
      global.document.documentElement.getAttribute('data-mock-source')) ||
      (global.location ? String(global.location.pathname).split('/').pop().replace('.html', '') || 'shell' : 'shell');
    global.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (!MOCK_URL_RE.test(url)) {
        if (!origFetch) return Promise.reject(new Error('fetch unavailable'));
        return origFetch(input, init);
      }
      return new Promise(function (resolve, reject) {
        api.request(url, { source: source }).then(function (text) {
          resolve(new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }, function (err) { reject(err); });
      });
    };
  }

  // Reuse the parent's instance when embedded in the demo shell (same origin).
  var parentApi = null;
  try {
    if (global.parent && global.parent !== global && global.parent.MockAPI && global.parent.MockAPI.__core) {
      parentApi = global.parent.MockAPI;
    }
  } catch (e) { parentApi = null; } // cross-origin or file:// — fall back to a local instance

  if (parentApi) {
    global.MockAPI = parentApi;
    installFetch(parentApi);
    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 00_Config.gs
  // ───────────────────────────────────────────────────────────────────────────
  var STORAGE_KEY = 'gosokDemo.state.v1';
  var STATE_VERSION = 4;
  var DEFAULT_NOW = '2026-06-20T10:00:00+07:00';
  var JKT_OFFSET_MS = 7 * 3600 * 1000;

  var SHEET = {
    ORDERS: 'Raw Order Data',
    CASH_PRIZES: 'CASH_PRIZES',
    CASH_PRIZE_DAILY_QUOTAS: 'CASH_PRIZE_DAILY_QUOTAS',
    GRAND_PRIZES: 'GRAND_PRIZES',
    DRAW_WAVES: 'DRAW_WAVES',
    SCRATCH_CARDS: 'SCRATCH_CARDS',
    REDEMPTIONS: 'REDEMPTIONS',
    DRAW_ENTRIES: 'DRAW_ENTRIES',
    KOMISI_DISBURSEMENTS: 'KOMISI_DISBURSEMENTS',
    PHYSICAL_DISPATCH: 'PHYSICAL_DISPATCH',
    CASH_PRIZE_AUDIT: 'CASH_PRIZE_AUDIT',
    CONFIG: 'CONFIG',
    DUMMY_CARDS: 'DUMMY_CARDS',
    MINT_LOG: 'MINT_LOG',
    DISBURSEMENT_PROGRESS: 'DISBURSEMENT_PROGRESS',
  };
  var FORM_LIVE_SHEET = 'FORM_LIVE';

  var MINT_LOG_COL = {
    ORDER_ID: 'order_id', USER_ID: 'user_id', ELIGIBLE: 'eligible', CARDS_MINTED: 'cards_minted',
    LAST_SYNC: 'last_sync', PRODUCT_NAME: 'product_name', PAID_AT: 'paid_at_jkt',
  };

  var STATUS = {
    CARD_BOUND: 'bound', CARD_SCRATCHED: 'scratched', CARD_VOIDED: 'voided', CARD_EXPIRED: 'expired',
    DISB_QUEUED: 'queued', DISB_SENT: 'sent', DISB_FAILED: 'failed',
    DRAW_PENDING: 'pending', DRAW_WON: 'won', DRAW_NOT_DRAWN: 'not_drawn',
    WAVE_PENDING: 'pending', WAVE_DRAWN: 'drawn',
  };
  var OUTCOME = { CASH: 'cash', DRAW: 'draw' };
  var LIVESTREAM_URL = 'https://instagram.com/bukuwarung_';
  var ID_MONTHS = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
    'September', 'Oktober', 'November', 'Desember'];

  var DISBURSEMENT_SCHEDULE = [
    { from: '2026-06-01', to: '2026-06-03', disb: { d: 5, m: 6, y: 2026 } },
    { from: '2026-06-04', to: '2026-06-10', disb: { d: 12, m: 6, y: 2026 } },
    { from: '2026-06-11', to: '2026-06-17', disb: { d: 19, m: 6, y: 2026 } },
    { from: '2026-06-18', to: '2026-06-25', disb: { d: 26, m: 6, y: 2026 } },
    { from: '2026-06-26', to: '2026-07-01', disb: { d: 3, m: 7, y: 2026 } },
    { from: '2026-07-02', to: '2026-07-08', disb: { d: 10, m: 7, y: 2026 } },
  ];

  var WAVE_SCHEDULE = [
    { wave_id: 'wave1', label: 'Wave 1', scratch_from: '2026-06-01', scratch_to: '2026-06-16',
      livestream_date: '2026-06-17', livestream_url: LIVESTREAM_URL, prizes_allocated: 8, status: 'pending' },
    { wave_id: 'wave2', label: 'Wave 2', scratch_from: '2026-06-17', scratch_to: '2026-07-08',
      livestream_date: '2026-07-08', livestream_url: LIVESTREAM_URL, prizes_allocated: 9, status: 'pending' },
  ];

  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  // ── Date helpers (Asia/Jakarta, UTC+7, no DST) ──────────────────────────────
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

  /** Parses sheet-style values. 'yyyy-MM-dd' and 'yyyy-MM-dd HH:mm:ss' are read as WIB. */
  function toDate(v) {
    if (isDate(v)) return new Date(v.getTime());
    if (typeof v === 'number') return new Date(v);
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/);
    if (m) return new Date(m[1] + 'T' + (m[2] ? (m[2].length === 5 ? m[2] + ':00' : m[2]) : '00:00:00') + '+07:00');
    return new Date(s);
  }
  function jktParts(d) {
    var j = new Date(d.getTime() + JKT_OFFSET_MS);
    return { y: j.getUTCFullYear(), M: j.getUTCMonth() + 1, d: j.getUTCDate(),
      h: j.getUTCHours(), m: j.getUTCMinutes(), s: j.getUTCSeconds() };
  }
  function fmtTs(d) {
    if (!d && d !== 0) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d)) return d;
    d = toDate(d);
    if (isNaN(d.getTime())) return '';
    var p = jktParts(d);
    return p.y + '-' + pad(p.M) + '-' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.m) + ':' + pad(p.s);
  }
  function fmtDate(d) {
    if (!d && d !== 0) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    d = toDate(d);
    if (isNaN(d.getTime())) return '';
    var p = jktParts(d);
    return p.y + '-' + pad(p.M) + '-' + pad(p.d);
  }
  function fmtDateId(d) {
    d = toDate(d);
    var p = jktParts(d);
    return p.d + ' ' + ID_MONTHS[p.M] + ' ' + p.y;
  }

  // ── Random sources ──────────────────────────────────────────────────────────
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function rndStr(db, len) {
    var out = '';
    for (var i = 0; i < len; i++) out += CODE_ALPHABET.charAt(Math.floor(db.rand() * CODE_ALPHABET.length));
    return out;
  }
  function genId(db, prefix) {
    var ts = nowJkt(db).getTime().toString(36);
    var rnd = db.rand().toString(36).substring(2, 8);
    return prefix + '_' + ts + rnd;
  }
  /** "KARTUGOSOK-A3FX9B2K" — unambiguous alphabet (no 0/O/1/I/L). */
  function generateCardId(db) { return 'KARTUGOSOK-' + rndStr(db, 8); }
  /** "GOSOK-A7F2X" — 04_Redeem.gs generateDrawCode_(). */
  function generateDrawCode(db) { return 'GOSOK-' + rndStr(db, 5); }

  function nowJkt(db) { return new Date(db.clock()); }

  function batchLabelForScratch(scratchDate) {
    var sd = fmtDate(scratchDate);
    for (var i = 0; i < DISBURSEMENT_SCHEDULE.length; i++) {
      var slot = DISBURSEMENT_SCHEDULE[i];
      if (i === DISBURSEMENT_SCHEDULE.length - 1) {
        var cutoffMs = new Date('2026-07-08T11:59:00+07:00').getTime();
        if (toDate(scratchDate).getTime() > cutoffMs) return null;
      }
      if (sd >= slot.from && sd <= slot.to) {
        return slot.disb.d + ' ' + ID_MONTHS[slot.disb.m] + ' ' + slot.disb.y; // e.g. "5 Juni 2026"
      }
    }
    return null;
  }

  function waveForScratch(scratchDate) {
    var wave1Boundary = new Date('2026-06-16T23:59:59+07:00');
    return toDate(scratchDate) <= wave1Boundary ? 'wave1' : 'wave2';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 01_SheetIO.gs — in-memory "spreadsheet"
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * A db is { tables: {sheet: [rowObj]}, headers: {sheet: [h]}, clock(): ms, rand(): [0,1) }.
   * Row objects never carry _rowNum in storage; readAllRows returns copies with _rowNum
   * (header row = 1, so data starts at 2) exactly like the Apps Script helper.
   */
  function makeDb(opts) {
    opts = opts || {};
    return {
      tables: opts.tables || {},
      headers: opts.headers || {},
      clock: opts.clock || function () { return Date.now(); },
      rand: opts.rand || Math.random,
      _configCache: null,
    };
  }
  function ensureSheet(db, name, headers) {
    if (!db.tables[name]) db.tables[name] = [];
    if (headers) db.headers[name] = headers.slice();
    else if (!db.headers[name]) db.headers[name] = [];
  }
  function readAllRows(db, sheetName) {
    var rows = db.tables[sheetName];
    if (!rows) throw new Error('Sheet not found: ' + sheetName);
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var o = { _rowNum: i + 2 }, r = rows[i];
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
      out[i] = o;
    }
    return out;
  }
  function findRow(db, sheetName, keyField, keyValue) {
    var rows = readAllRows(db, sheetName);
    for (var i = 0; i < rows.length; i++) if (rows[i][keyField] === keyValue) return rows[i];
    return null;
  }
  function findRows(db, sheetName, keyField, keyValue) {
    return readAllRows(db, sheetName).filter(function (r) { return r[keyField] === keyValue; });
  }
  function appendRow(db, sheetName, rowObj) {
    var headers = db.headers[sheetName];
    if (!db.tables[sheetName]) throw new Error('Sheet not found: ' + sheetName);
    var row = {};
    headers.forEach(function (h) { row[h] = Object.prototype.hasOwnProperty.call(rowObj, h) ? rowObj[h] : ''; });
    db.tables[sheetName].push(row);
  }
  function updateRow(db, sheetName, rowNum, updates) {
    var row = db.tables[sheetName][rowNum - 2];
    if (!row) throw new Error('Row ' + rowNum + ' not found in ' + sheetName);
    db.headers[sheetName].forEach(function (h) {
      if (Object.prototype.hasOwnProperty.call(updates, h)) row[h] = updates[h];
    });
  }
  function upsertRow(db, sheetName, keyField, rowObj) {
    var existing = findRow(db, sheetName, keyField, rowObj[keyField]);
    if (existing) { updateRow(db, sheetName, existing._rowNum, rowObj); return { action: 'updated', rowNum: existing._rowNum }; }
    appendRow(db, sheetName, rowObj);
    return { action: 'inserted', rowNum: -1 };
  }
  function decrementField(db, sheetName, keyField, keyValue, field, delta) {
    var rows = db.tables[sheetName];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][keyField] === keyValue) {
        var next = Number(rows[i][field]) - delta;
        rows[i][field] = next;
        return next;
      }
    }
    return null;
  }
  function incrementField(db, sheetName, keyField, keyValue, field, delta) {
    return decrementField(db, sheetName, keyField, keyValue, field, -delta);
  }
  function incrementCompositeField(db, sheetName, k1, v1, k2, v2, field, delta) {
    var rows = db.tables[sheetName];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][k1] === v1 && rows[i][k2] === v2) {
        var next = Number(rows[i][field]) + delta;
        rows[i][field] = next;
        return next;
      }
    }
    return null;
  }

  function getConfig(db) {
    if (db._configCache) return db._configCache;
    var out = {};
    readAllRows(db, SHEET.CONFIG).forEach(function (r) { out[r.key] = r.value; });
    db._configCache = out;
    return out;
  }
  function setConfig(db, key, value) {
    db._configCache = null;
    upsertRow(db, SHEET.CONFIG, 'key', { key: key, value: String(value), description: '' });
  }

  // ── Dummy-mode helpers (00_Config.gs) ───────────────────────────────────────
  function findDummySlotByCardId(db, cardId, uid) {
    try {
      var rows = readAllRows(db, SHEET.DUMMY_CARDS);
      var slot = rows.find(function (r) { return String(r.card_id) === cardId; });
      if (!slot) return null;
      if (String(slot.uid) !== uid) return false;
      return slot;
    } catch (e) { return null; }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 02_Sync.gs — eligibility, minting, sheet setup
  // ───────────────────────────────────────────────────────────────────────────
  function isEligibleNow(order, cfg) {
    if (order.payment_status !== 'PAID') return false;
    if (!order.waiting_for_ops_at_ts) return false;
    if (['Cancelled', 'Rejected'].indexOf(order.status) !== -1) return false;
    var blocked = (cfg.blocked_tfcodes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (blocked.indexOf(String(order.tfcode)) !== -1) return false;
    var allowed = (cfg.allowed_products || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var productName = String(order.product_name || '');
    var productAllowed = allowed.some(function (ap) { return productName === ap || productName.indexOf(ap) === 0; });
    if (!productAllowed) return false;
    var paid = fmtDate(order.paid_at_jkt);
    if (paid < cfg.campaign_start || paid > cfg.campaign_end) return false;
    return true;
  }

  function mintCardsForOrder(db, order, cfg) {
    var productName = String(order.product_name || '');
    var isAndroid = productName.indexOf('Android') !== -1;
    var quota = isAndroid ? Number(cfg.android_card_quota || 2) : Number(cfg.saku_card_quota || 1);
    var now = fmtTs(nowJkt(db));
    for (var i = 1; i <= quota; i++) {
      appendRow(db, SHEET.SCRATCH_CARDS, {
        card_id: generateCardId(db), user_id: order.user_id, order_id: order.order_id,
        sequence_no: i, status: STATUS.CARD_BOUND, bound_at: now, scratched_at: '',
      });
    }
    return quota;
  }

  function voidCardsForOrder(db, cards) {
    cards.forEach(function (c) {
      if (c.status === STATUS.CARD_BOUND) updateRow(db, SHEET.SCRATCH_CARDS, c._rowNum, { status: STATUS.CARD_VOIDED });
    });
  }

  function syncOrders(db) {
    var cfg = getConfig(db);
    var allOrders = readAllRows(db, SHEET.ORDERS);
    var mintLog = readAllRows(db, SHEET.MINT_LOG);
    var mintLogMap = {};
    mintLog.forEach(function (r) { mintLogMap[r.order_id] = r; });
    var minted = 0, voided = 0;

    allOrders.forEach(function (o) {
      var eligible = isEligibleNow(o, cfg);
      var logRow = mintLogMap[o.order_id];
      var wasEligible = logRow ? (logRow.eligible === true || logRow.eligible === 'TRUE') : false;
      var alreadyMinted = logRow ? (logRow.cards_minted === true || logRow.cards_minted === 'TRUE') : false;
      var row;
      if (!logRow) {
        row = {};
        row[MINT_LOG_COL.ORDER_ID] = o.order_id; row[MINT_LOG_COL.USER_ID] = o.user_id;
        row[MINT_LOG_COL.ELIGIBLE] = eligible; row[MINT_LOG_COL.CARDS_MINTED] = false;
        row[MINT_LOG_COL.LAST_SYNC] = fmtTs(nowJkt(db)); row[MINT_LOG_COL.PRODUCT_NAME] = o.product_name;
        row[MINT_LOG_COL.PAID_AT] = fmtDate(o.paid_at_jkt);
        appendRow(db, SHEET.MINT_LOG, row);
        mintLogMap[o.order_id] = { eligible: eligible, cards_minted: false };
      } else if (eligible !== wasEligible) {
        updateRow(db, SHEET.MINT_LOG, logRow._rowNum, { eligible: eligible, last_sync: fmtTs(nowJkt(db)) });
        mintLogMap[o.order_id].eligible = eligible;
      }

      if (eligible && !alreadyMinted) {
        var count = mintCardsForOrder(db, o, cfg);
        if (count > 0) {
          var fresh = logRow || findRow(db, SHEET.MINT_LOG, MINT_LOG_COL.ORDER_ID, o.order_id);
          if (fresh) updateRow(db, SHEET.MINT_LOG, fresh._rowNum, { cards_minted: true, last_sync: fmtTs(nowJkt(db)) });
          minted++;
        }
      } else if (!eligible && alreadyMinted) {
        var cards = findRows(db, SHEET.SCRATCH_CARDS, 'order_id', o.order_id);
        var hasScratched = cards.some(function (c) { return c.status === STATUS.CARD_SCRATCHED; });
        if (!hasScratched) {
          voidCardsForOrder(db, cards);
          if (logRow) updateRow(db, SHEET.MINT_LOG, logRow._rowNum, { cards_minted: false, last_sync: fmtTs(nowJkt(db)) });
          voided++;
        }
      }
    });
    setConfig(db, 'last_sync_at', fmtTs(nowJkt(db)));
    return { ok: true, orders_scanned: allOrders.length, new_minted_this_run: minted, voided: voided };
  }

  var CASH_PRIZE_SEED = [
    { cash_prize_id: 'cash_5k', tier: 'komisi_5k', value_idr: 5000, label_id: 'Komisi Agen Rp 5.000', total_qty: 8666, remaining_qty: 8666, weight_multiplier: 1 },
    { cash_prize_id: 'cash_10k', tier: 'komisi_10k', value_idr: 10000, label_id: 'Komisi Agen Rp 10.000', total_qty: 2317, remaining_qty: 2317, weight_multiplier: 1 },
    { cash_prize_id: 'cash_20k', tier: 'komisi_20k', value_idr: 20000, label_id: 'Komisi Agen Rp 20.000', total_qty: 2000, remaining_qty: 2000, weight_multiplier: 1 },
    { cash_prize_id: 'cash_50k', tier: 'komisi_50k', value_idr: 50000, label_id: 'Komisi Agen Rp 50.000', total_qty: 500, remaining_qty: 500, weight_multiplier: 1 },
    { cash_prize_id: 'cash_100k', tier: 'komisi_100k', value_idr: 100000, label_id: 'Komisi Agen Rp 100.000', total_qty: 150, remaining_qty: 150, weight_multiplier: 1 },
    { cash_prize_id: 'cash_200k', tier: 'komisi_200k', value_idr: 200000, label_id: 'Komisi Agen Rp 200.000', total_qty: 50, remaining_qty: 50, weight_multiplier: 1 },
  ];
  var CASH_PRIZE_HEADERS = ['cash_prize_id', 'tier', 'value_idr', 'label_id', 'total_qty', 'remaining_qty', 'weight_multiplier'];
  var QUOTA_HEADERS = ['date', 'cash_prize_id', 'daily_qty', 'given_out_today'];

  function buildCashPrizeRows(seed) {
    return (seed || CASH_PRIZE_SEED).map(function (r) { var o = {}; for (var k in r) o[k] = r[k]; return o; });
  }
  /** Same math as setupSupportingSheets: daily_qty = max(1, ceil(total_qty / totalDays)). */
  function buildDailyQuotaRows(startDate, endDate, cashPrizeRows) {
    var start = toDate(startDate), end = toDate(endDate);
    var totalDays = Math.round((end - start) / 86400000) + 1;
    var rows = [];
    for (var t = start.getTime(); t <= end.getTime(); t += 86400000) {
      var dateStr = fmtDate(new Date(t));
      (cashPrizeRows || CASH_PRIZE_SEED).forEach(function (p) {
        rows.push({ date: dateStr, cash_prize_id: p.cash_prize_id,
          daily_qty: Math.max(1, Math.ceil(Number(p.total_qty) / totalDays)), given_out_today: 0 });
      });
    }
    return rows;
  }

  function setupSupportingSheets(db) {
    ensureSheet(db, SHEET.ORDERS, ['paid_at_jkt', 'order_id', 'status', 'payment_status', 'tfcode', 'channel',
      'user_id', 'name', 'product_name', 'price', 'waiting_for_ops_at_ts', 'last_updated_at']);
    ensureSheet(db, SHEET.CASH_PRIZES, CASH_PRIZE_HEADERS);
    db.tables[SHEET.CASH_PRIZES] = buildCashPrizeRows();
    ensureSheet(db, SHEET.CASH_PRIZE_DAILY_QUOTAS, QUOTA_HEADERS);
    db.tables[SHEET.CASH_PRIZE_DAILY_QUOTAS] = buildDailyQuotaRows('2026-06-01', '2026-07-08');
    ensureSheet(db, SHEET.GRAND_PRIZES, ['grand_prize_id', 'tier', 'label', 'value_idr', 'total_qty', 'wave_allocation']);
    db.tables[SHEET.GRAND_PRIZES] = [
      { grand_prize_id: 'gp_smartphone', tier: 'smartphone', label: 'Samsung S24 / equiv.', value_idr: 8000000, total_qty: 2, wave_allocation: 'split' },
      { grand_prize_id: 'gp_tablet', tier: 'tablet', label: 'iPad mini / equiv.', value_idr: 3500000, total_qty: 5, wave_allocation: 'split' },
      { grand_prize_id: 'gp_cctv', tier: 'cctv', label: 'Smart CCTV Camera', value_idr: 1000000, total_qty: 10, wave_allocation: 'split' },
    ];
    ensureSheet(db, SHEET.DRAW_WAVES, ['wave_id', 'label', 'scratch_window_start', 'scratch_window_end',
      'livestream_date', 'livestream_url', 'prizes_allocated', 'status']);
    db.tables[SHEET.DRAW_WAVES] = WAVE_SCHEDULE.map(function (w) {
      return { wave_id: w.wave_id, label: w.label, scratch_window_start: w.scratch_from, scratch_window_end: w.scratch_to,
        livestream_date: w.livestream_date, livestream_url: w.livestream_url, prizes_allocated: w.prizes_allocated, status: w.status };
    });
    var empty = {};
    empty[SHEET.SCRATCH_CARDS] = ['card_id', 'user_id', 'order_id', 'sequence_no', 'status', 'bound_at', 'scratched_at'];
    empty[SHEET.REDEMPTIONS] = ['redemption_id', 'card_id', 'user_id', 'outcome_type', 'cash_prize_id', 'scratched_at', 'ip_address', 'user_agent', 'idempotency_key'];
    empty[SHEET.DRAW_ENTRIES] = ['entry_id', 'redemption_id', 'user_id', 'wave_id', 'draw_code', 'grand_prize_id', 'result', 'entered_at', 'drawn_at'];
    empty[SHEET.KOMISI_DISBURSEMENTS] = ['disbursement_id', 'redemption_id', 'user_id', 'name', 'value_idr', 'batch', 'status', 'queued_at', 'processed_at'];
    empty[SHEET.PHYSICAL_DISPATCH] = ['dispatch_id', 'entry_id', 'courier', 'tracking_number', 'status', 'queued_at', 'shipped_at'];
    empty[SHEET.CASH_PRIZE_AUDIT] = ['audit_id', 'cash_prize_id', 'field_changed', 'old_value', 'new_value', 'changed_by', 'changed_at', 'reason'];
    empty[SHEET.MINT_LOG] = ['order_id', 'user_id', 'eligible', 'cards_minted', 'last_sync', 'product_name', 'paid_at_jkt'];
    empty[SHEET.DISBURSEMENT_PROGRESS] = ['batch', 'total_disbursement_needed', 'unique_users', 'file_url', 'file_id', 'status', 'generated_at', 'processed_at'];
    Object.keys(empty).forEach(function (n) { ensureSheet(db, n, empty[n]); db.tables[n] = []; });

    ensureSheet(db, SHEET.DUMMY_CARDS, ['uid', 'name', 'product_type', 'prize_tier', 'card_id', 'draw_code', 'active', 'scratched_at', 'batch', 'notes']);
    var slots = [
      { uid: '8000000001', name: 'Test Saku 5rb', product_type: 'saku', prize_tier: 'cash_5k', notes: 'Test: Komisi Rp 5.000' },
      { uid: '8000000002', name: 'Test Saku 10rb', product_type: 'saku', prize_tier: 'cash_10k', notes: 'Test: Komisi Rp 10.000' },
      { uid: '8000000003', name: 'Test Saku 20rb', product_type: 'saku', prize_tier: 'cash_20k', notes: 'Test: Komisi Rp 20.000' },
      { uid: '8000000004', name: 'Test Saku 50rb', product_type: 'saku', prize_tier: 'cash_50k', notes: 'Test: Komisi Rp 50.000' },
      { uid: '8000000005', name: 'Test Saku 100rb', product_type: 'saku', prize_tier: 'cash_100k', notes: 'Test: Komisi Rp 100.000' },
      { uid: '8000000006', name: 'Test Saku 200rb', product_type: 'saku', prize_tier: 'cash_200k', notes: 'Test: Komisi Rp 200.000' },
      { uid: '8000000007', name: 'Test Grand Prize', product_type: 'saku', prize_tier: 'draw', notes: 'Test: Grand Prize draw pool' },
      { uid: '8000000008', name: 'Test Android', product_type: 'android', prize_tier: 'cash_50k', notes: 'Test: Android kartu #1' },
      { uid: '8000000008', name: 'Test Android', product_type: 'android', prize_tier: 'cash_20k', notes: 'Test: Android kartu #2' },
    ];
    db.tables[SHEET.DUMMY_CARDS] = slots.map(function (s) {
      return { uid: s.uid, name: s.name, product_type: s.product_type, prize_tier: s.prize_tier,
        card_id: 'KARTUGOSOK-' + rndStr(db, 8), draw_code: s.prize_tier === 'draw' ? 'GOSOK-' + rndStr(db, 5) : '',
        active: true, scratched_at: '', batch: '', notes: s.notes };
    });

    ensureSheet(db, SHEET.CONFIG, ['key', 'value', 'description']);
    db.tables[SHEET.CONFIG] = [
      ['campaign_start', '2026-06-01', 'First eligible paid_at_jkt'],
      ['campaign_end', '2026-06-30', 'Last eligible paid_at_jkt'],
      ['scratch_cutoff', '2026-07-08 11:59:59', 'After this time (WIB), cards expire'],
      ['wave1_boundary', '2026-06-16 23:59:59', 'scratched_at on or before = wave1'],
      ['draw_pool_ratio', '0.03', 'Target % of scratches → draw outcome'],
      ['last_sync_at', '', 'Updated by syncOrders()'],
      ['allowed_products', 'Saku,Android - New,Saku - Insurance Bundle,Saku - Printer Bundle', ''],
      ['blocked_tfcodes', 'SHOPEE', ''],
      ['saku_card_quota', '1', ''],
      ['android_card_quota', '2', ''],
      ['disbursement_drive_folder_id', '', 'Google Drive folder UUID for disbursement CSVs'],
      ['disbursement_expiry_date', '2026-12-31', 'expiryDate column value in the disbursement CSV'],
    ].map(function (r) { return { key: r[0], value: r[1], description: r[2] }; });
    db._configCache = null;

    // FORM_LIVE: Google Form output (attendance). Headers must match the form exactly.
    ensureSheet(db, FORM_LIVE_SHEET, ['Timestamp', 'Nomor HP yang Digunakan Saat Pembelian EDC BukuAgen', 'Tanggal Undian']);
    db.tables[FORM_LIVE_SHEET] = [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 03_Lookup.gs
  // ───────────────────────────────────────────────────────────────────────────
  function emptySummary() {
    return { total_orders: 0, total_cards: 0, cards_scratched: 0, cards_unscratched: 0,
      total_komisi_won_idr: 0, komisi_disbursed_idr: 0, komisi_pending_idr: 0, draw_tickets_active: 0 };
  }
  function buildSummary(cards) {
    var s = emptySummary();
    s.total_cards = cards.length;
    cards.forEach(function (c) {
      if (c.status === STATUS.CARD_SCRATCHED) s.cards_scratched++;
      if (c.status === STATUS.CARD_BOUND) s.cards_unscratched++;
      if (c.cash_prize) {
        s.total_komisi_won_idr += c.cash_prize.value_idr;
        if (c.disbursement && c.disbursement.status === STATUS.DISB_SENT) s.komisi_disbursed_idr += c.cash_prize.value_idr;
        else if (c.disbursement && c.disbursement.status === STATUS.DISB_QUEUED) s.komisi_pending_idr += c.cash_prize.value_idr;
      }
      if (c.draw_entry && c.draw_entry.result === STATUS.DRAW_PENDING) s.draw_tickets_active++;
    });
    return s;
  }
  function orderToPublic(o, cards, mintLogMap) {
    var log = mintLogMap ? mintLogMap[o.order_id] : null;
    return {
      order_id: o.order_id, product_name: o.product_name, paid_at_jkt: fmtDate(o.paid_at_jkt),
      price_idr: o.price, channel: o.channel, order_status: o.status,
      eligible: !!(log && (log.eligible === true || log.eligible === 'TRUE')),
      card_quota: cards.length, cards: cards,
    };
  }
  function enrichCard(card, redemptions, disbursements, drawEntries, waves, cashPrizes, grandPrizes) {
    var base = {
      card_id: card.card_id, sequence_no: Number(card.sequence_no), status: card.status,
      bound_at: card.bound_at ? fmtTs(card.bound_at) : null,
      scratched_at: card.scratched_at ? fmtTs(card.scratched_at) : null,
      outcome_type: null, cash_prize: null, disbursement: null, draw_entry: null,
    };
    if (card.status !== STATUS.CARD_SCRATCHED) return base;
    var red = redemptions.find(function (r) { return r.card_id === card.card_id; });
    if (!red) return base;
    base.outcome_type = red.outcome_type;
    if (red.outcome_type === OUTCOME.CASH) {
      var cp = cashPrizes.find(function (p) { return p.cash_prize_id === red.cash_prize_id; });
      base.cash_prize = cp ? { cash_prize_id: cp.cash_prize_id, tier: cp.tier, value_idr: Number(cp.value_idr), label: cp.label_id } : null;
      var d = disbursements.find(function (x) { return x.redemption_id === red.redemption_id; });
      base.disbursement = d ? { status: d.status, batch: d.batch,
        queued_at: d.queued_at ? fmtTs(d.queued_at) : null, processed_at: d.processed_at ? fmtTs(d.processed_at) : null } : null;
    } else if (red.outcome_type === OUTCOME.DRAW) {
      var entry = drawEntries.find(function (e) { return e.redemption_id === red.redemption_id; });
      if (entry) {
        var wave = waves.find(function (w) { return w.wave_id === entry.wave_id; });
        var gp = entry.grand_prize_id ? grandPrizes.find(function (g) { return g.grand_prize_id === entry.grand_prize_id; }) : null;
        base.draw_entry = {
          entry_id: entry.entry_id, wave_id: entry.wave_id, draw_code: entry.draw_code || null,
          wave_label: wave ? wave.label : entry.wave_id,
          livestream_date: wave ? fmtDate(wave.livestream_date) : null,
          livestream_url: wave ? wave.livestream_url : null,
          result: entry.result,
          grand_prize: gp ? { tier: gp.tier, label: gp.label, value_idr: Number(gp.value_idr) } : null,
        };
      }
    }
    return base;
  }

  var TIER_VALUES = { cash_5k: 5000, cash_10k: 10000, cash_20k: 20000, cash_50k: 50000, cash_100k: 100000, cash_200k: 200000 };
  var TIER_LABELS = {
    cash_5k: 'Komisi Agen Rp 5.000', cash_10k: 'Komisi Agen Rp 10.000', cash_20k: 'Komisi Agen Rp 20.000',
    cash_50k: 'Komisi Agen Rp 50.000', cash_100k: 'Komisi Agen Rp 100.000', cash_200k: 'Komisi Agen Rp 200.000',
  };

  function lookupDummy(db, uid, now) {
    var rows = readAllRows(db, SHEET.DUMMY_CARDS);
    var slots = rows.filter(function (r) { return String(r.uid) === uid; });
    if (!slots.length) return null;
    var merchantName = String(slots[0].name || 'Dummy Merchant');
    var cards = slots.map(function (slot, idx) {
      var cardId = String(slot.card_id || '');
      var isScratched = slot.scratched_at && String(slot.scratched_at).trim() !== '';
      var prizeTier = String(slot.prize_tier || '');
      var isDraw = prizeTier === 'draw';
      var base = {
        card_id: cardId, sequence_no: idx + 1, status: isScratched ? STATUS.CARD_SCRATCHED : STATUS.CARD_BOUND,
        bound_at: fmtTs(now), scratched_at: isScratched ? String(slot.scratched_at) : null,
        outcome_type: null, cash_prize: null, disbursement: null, draw_entry: null,
      };
      if (!isScratched) return base;
      if (isDraw) {
        base.outcome_type = OUTCOME.DRAW;
        var scratchedDate = toDate(String(slot.scratched_at));
        var waveId = waveForScratch(isNaN(scratchedDate) ? now : scratchedDate);
        var wave = readAllRows(db, SHEET.DRAW_WAVES).find(function (w) { return w.wave_id === waveId; });
        base.draw_entry = {
          entry_id: 'DUMMY-ENTRY-' + cardId, wave_id: waveId, draw_code: String(slot.draw_code || ''),
          wave_label: wave ? wave.label : waveId,
          livestream_date: wave ? fmtDate(wave.livestream_date) : null,
          livestream_url: wave ? wave.livestream_url : LIVESTREAM_URL,
          result: STATUS.DRAW_PENDING, grand_prize: null,
        };
      } else {
        base.outcome_type = OUTCOME.CASH;
        base.cash_prize = { cash_prize_id: prizeTier, tier: prizeTier, value_idr: TIER_VALUES[prizeTier] || 0, label: TIER_LABELS[prizeTier] || prizeTier };
        base.disbursement = { status: STATUS.DISB_QUEUED, batch: slot.batch || batchLabelForScratch(now),
          queued_at: isScratched ? String(slot.scratched_at) : null, processed_at: null };
      }
      return base;
    });
    var productType = String(slots[0].product_type || 'saku');
    var syntheticOrder = {
      order_id: 'DUMMY-' + uid, product_name: productType === 'android' ? 'Android - New' : 'Saku',
      paid_at_jkt: fmtDate(now), price_idr: productType === 'android' ? 1899000 : 449000,
      channel: 'dummy', order_status: 'Completed', eligible: true, card_quota: cards.length, cards: cards,
    };
    var allScratched = cards.length > 0 && cards.every(function (c) { return c.status !== STATUS.CARD_BOUND; });
    return {
      ok: true, uid: uid, merchant_name: merchantName, lookup_at: fmtTs(now),
      state: allScratched ? 'all_scratched' : 'cards_ready', is_dummy: true,
      orders: [syntheticOrder], summary: buildSummary(cards),
    };
  }

  function lookupByUid(db, uid) {
    if (!uid || typeof uid !== 'string') return { ok: false, error: 'invalid_uid', message: 'UID kosong atau format salah' };
    uid = String(uid).replace(/\D/g, '');
    var now = nowJkt(db);
    var dummyResp = lookupDummy(db, uid, now);
    if (dummyResp) return dummyResp;

    var ordersForUid = readAllRows(db, SHEET.ORDERS).filter(function (o) { return String(o.user_id) === uid; });
    if (ordersForUid.length === 0) {
      return { ok: true, uid: uid, lookup_at: fmtTs(now), state: 'no_order',
        message: 'Nomor ini belum ada pesanan EDC BukuAgen di Juni 2026', orders: [], summary: emptySummary() };
    }
    var mintLogMap = {};
    readAllRows(db, SHEET.MINT_LOG).forEach(function (r) { mintLogMap[r.order_id] = r; });
    var isEligible = function (o) { var log = mintLogMap[o.order_id]; return log && (log.eligible === true || log.eligible === 'TRUE'); };
    var eligibleOrders = ordersForUid.filter(isEligible);
    var pendingOrders = ordersForUid.filter(function (o) { return !isEligible(o); });

    if (eligibleOrders.length === 0 && pendingOrders.length > 0) {
      return { ok: true, uid: uid, merchant_name: pendingOrders[0].name, lookup_at: fmtTs(now), state: 'order_pending',
        message: 'Pesanan kamu lagi diproses, kartu gosok bakal muncul setelah konfirmasi ops',
        orders: pendingOrders.map(function (o) { return orderToPublic(o, [], mintLogMap); }), summary: emptySummary() };
    }

    var allCards = readAllRows(db, SHEET.SCRATCH_CARDS), allRedemptions = readAllRows(db, SHEET.REDEMPTIONS);
    var allDisb = readAllRows(db, SHEET.KOMISI_DISBURSEMENTS), allDraw = readAllRows(db, SHEET.DRAW_ENTRIES);
    var allWaves = readAllRows(db, SHEET.DRAW_WAVES), allCash = readAllRows(db, SHEET.CASH_PRIZES);
    var allGrand = readAllRows(db, SHEET.GRAND_PRIZES);

    var ordersForResponse = eligibleOrders.map(function (o) {
      var cards = allCards.filter(function (c) { return c.order_id === o.order_id; });
      var enriched = cards.map(function (c) { return enrichCard(c, allRedemptions, allDisb, allDraw, allWaves, allCash, allGrand); });
      return orderToPublic(o, enriched, mintLogMap);
    });
    var allEnriched = ordersForResponse.reduce(function (acc, o) { return acc.concat(o.cards); }, []);
    var isActive = function (c) { return c.status !== STATUS.CARD_VOIDED && c.status !== STATUS.CARD_EXPIRED; };
    var activeCards = allEnriched.filter(isActive);
    if (activeCards.length === 0) {
      return { ok: true, uid: uid, lookup_at: fmtTs(now), state: 'no_order',
        message: 'Nomor ini belum ada pesanan EDC BukuAgen di Juni 2026', orders: [], summary: emptySummary() };
    }
    var activeOrders = ordersForResponse.map(function (o) {
      var copy = {}; for (var k in o) copy[k] = o[k];
      copy.cards = o.cards.filter(isActive);
      copy.card_quota = copy.cards.length;
      return copy;
    }).filter(function (o) { return o.cards.length > 0; });
    var allScratched = activeCards.every(function (c) { return c.status !== STATUS.CARD_BOUND; });
    return {
      ok: true, uid: uid, merchant_name: eligibleOrders[0].name, lookup_at: fmtTs(now),
      state: allScratched ? 'all_scratched' : 'cards_ready',
      orders: activeOrders.concat(pendingOrders.map(function (o) { return orderToPublic(o, [], mintLogMap); })),
      summary: buildSummary(activeCards),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 05_PrizePicker.gs
  // ───────────────────────────────────────────────────────────────────────────
  function pickPrize(db, now) {
    var cfg = getConfig(db);
    var drawRatio = Number(cfg.draw_pool_ratio) || 0.03;
    var today = fmtDate(now);
    var cashPrizes = readAllRows(db, SHEET.CASH_PRIZES);
    var quotas = readAllRows(db, SHEET.CASH_PRIZE_DAILY_QUOTAS).filter(function (q) { return q.date === today; });
    var quotaMap = {};
    quotas.forEach(function (q) { quotaMap[q.cash_prize_id] = Number(q.daily_qty) - Number(q.given_out_today); });
    var eligibleTiers = cashPrizes.filter(function (p) {
      var inv = Number(p.remaining_qty), daily = quotaMap[p.cash_prize_id];
      return inv > 0 && (daily === undefined || daily > 0);
    });
    if (eligibleTiers.length === 0) return { outcome_type: OUTCOME.DRAW };
    if (db.rand() < drawRatio) return { outcome_type: OUTCOME.DRAW };
    var totalWeight = eligibleTiers.reduce(function (sum, p) { return sum + Number(p.remaining_qty) * Number(p.weight_multiplier || 1); }, 0);
    var roll = db.rand() * totalWeight;
    for (var i = 0; i < eligibleTiers.length; i++) {
      var p = eligibleTiers[i];
      roll -= Number(p.remaining_qty) * Number(p.weight_multiplier || 1);
      if (roll <= 0) return { outcome_type: OUTCOME.CASH, cash_prize_id: p.cash_prize_id, value_idr: Number(p.value_idr) };
    }
    var last = eligibleTiers[eligibleTiers.length - 1];
    return { outcome_type: OUTCOME.CASH, cash_prize_id: last.cash_prize_id, value_idr: Number(last.value_idr) };
  }

  /** The two inventory writes redeemCardInner performs for a cash outcome. */
  function recordCashWin(db, cashPrizeId, now) {
    decrementField(db, SHEET.CASH_PRIZES, 'cash_prize_id', cashPrizeId, 'remaining_qty', 1);
    incrementCompositeField(db, SHEET.CASH_PRIZE_DAILY_QUOTAS, 'date', fmtDate(now), 'cash_prize_id', cashPrizeId, 'given_out_today', 1);
  }

  function regenerateDailyQuotas(db) {
    var cfg = getConfig(db);
    var today = fmtDate(nowJkt(db));
    var cutoff = fmtDate(toDate(cfg.scratch_cutoff));
    var daysRemaining = Math.max(1, Math.round((toDate(cutoff) - toDate(today)) / 86400000) + 1);
    var quotas = readAllRows(db, SHEET.CASH_PRIZE_DAILY_QUOTAS);
    readAllRows(db, SHEET.CASH_PRIZES).forEach(function (p) {
      var perDay = Math.max(1, Math.ceil(Number(p.remaining_qty) / daysRemaining));
      quotas.filter(function (q) { return q.cash_prize_id === p.cash_prize_id && q.date >= today; })
        .forEach(function (q) { updateRow(db, SHEET.CASH_PRIZE_DAILY_QUOTAS, q._rowNum, { daily_qty: perDay }); });
    });
    return { ok: true, days_remaining: daysRemaining };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 04_Redeem.gs
  // ───────────────────────────────────────────────────────────────────────────
  function redeemDummy(db, slot, cleanUid, now) {
    var nowTs = fmtTs(now);
    var prizeTier = String(slot.prize_tier || '');
    var isDraw = prizeTier === 'draw';
    updateRow(db, SHEET.DUMMY_CARDS, slot._rowNum, { scratched_at: nowTs, batch: isDraw ? '' : batchLabelForScratch(now), active: true });
    var out = {
      ok: true, duplicate: false, redemption_id: 'DUMMY-RED-' + slot.card_id, card_id: String(slot.card_id),
      outcome_type: isDraw ? OUTCOME.DRAW : OUTCOME.CASH, scratched_at_server: nowTs,
      cash_prize: null, disbursement: null, draw_entry: null,
    };
    if (isDraw) {
      var waveId = waveForScratch(now);
      var wave = readAllRows(db, SHEET.DRAW_WAVES).find(function (w) { return w.wave_id === waveId; });
      out.draw_entry = {
        entry_id: 'DUMMY-ENTRY-' + slot.card_id, wave_id: waveId, draw_code: String(slot.draw_code || generateDrawCode(db)),
        wave_label: wave ? wave.label : waveId, livestream_date: wave ? fmtDate(wave.livestream_date) : null,
        livestream_url: wave ? wave.livestream_url : LIVESTREAM_URL, result: STATUS.DRAW_PENDING,
        message: 'Kamu masuk POOL HADIAH SPESIAL! Nonton Livestream Instagram BukuAgen ' +
          (wave ? 'tanggal ' + fmtDate(wave.livestream_date) : '') + ' buat tau hadiah kamu!',
      };
    } else {
      var batch = batchLabelForScratch(now);
      out.cash_prize = { cash_prize_id: prizeTier, tier: prizeTier, value_idr: TIER_VALUES[prizeTier] || 0, label: TIER_LABELS[prizeTier] || prizeTier };
      out.disbursement = { status: STATUS.DISB_QUEUED, batch: batch,
        message: TIER_LABELS[prizeTier] + ' bakal masuk saldo BukuAgen hari Kamis sesuai batch ' + batch };
    }
    return out;
  }

  function buildRedeemResponse(db, redemption, cfg, fromIdempotency) {
    var out = {
      ok: true, duplicate: !!fromIdempotency, redemption_id: redemption.redemption_id, card_id: redemption.card_id,
      outcome_type: redemption.outcome_type, scratched_at_server: redemption.scratched_at ? fmtTs(redemption.scratched_at) : null,
      cash_prize: null, disbursement: null, draw_entry: null,
    };
    if (redemption.outcome_type === OUTCOME.CASH) {
      var cp = findRow(db, SHEET.CASH_PRIZES, 'cash_prize_id', redemption.cash_prize_id);
      if (cp) out.cash_prize = { cash_prize_id: cp.cash_prize_id, tier: cp.tier, value_idr: Number(cp.value_idr), label: cp.label_id };
      var disb = findRow(db, SHEET.KOMISI_DISBURSEMENTS, 'redemption_id', redemption.redemption_id);
      if (disb) out.disbursement = { status: disb.status, batch: disb.batch,
        message: 'Komisi ' + (cp ? cp.label_id : '') + ' bakal masuk saldo BukuAgen hari Kamis sesuai batch ' + disb.batch };
    } else if (redemption.outcome_type === OUTCOME.DRAW) {
      var entry = findRow(db, SHEET.DRAW_ENTRIES, 'redemption_id', redemption.redemption_id);
      if (entry) {
        var wave = findRow(db, SHEET.DRAW_WAVES, 'wave_id', entry.wave_id);
        out.draw_entry = {
          entry_id: entry.entry_id, wave_id: entry.wave_id, draw_code: entry.draw_code || null,
          wave_label: wave ? wave.label : entry.wave_id, livestream_date: wave ? fmtDate(wave.livestream_date) : null,
          livestream_url: wave ? wave.livestream_url : null, result: entry.result,
          message: 'Kamu masuk POOL HADIAH SPESIAL! Nonton Livestream Instagram BukuAgen tanggal ' +
            (wave ? fmtDate(wave.livestream_date) : '') + ' buat tau hadiah kamu!',
        };
      }
    }
    return out;
  }

  /**
   * @param {object} payload  { card_id, uid, idempotency_key, user_agent, ip_address }
   * @param {object} [seedOpts] seeding only: { forceOutcome: 'cash'|'draw' } — never set by the HTTP router
   */
  function redeemCardInner(db, payload, seedOpts) {
    payload = payload || {};
    var card_id = payload.card_id, uid = payload.uid, idempotency_key = payload.idempotency_key;
    if (!card_id || !uid) return { ok: false, error: 'missing_params', message: 'card_id atau uid kosong' };
    var cleanUid = String(uid).replace(/\D/g, '');
    var now = nowJkt(db);
    var cfg = getConfig(db);

    var cutoff = toDate(cfg.scratch_cutoff);
    if (now > cutoff) return { ok: false, error: 'campaign_ended', message: 'Periode gosok sudah berakhir tanggal 10 Juli' };

    if (idempotency_key) {
      var prior = findRow(db, SHEET.REDEMPTIONS, 'idempotency_key', idempotency_key);
      if (prior) return buildRedeemResponse(db, prior, cfg, true);
    }

    var dummySlot = findDummySlotByCardId(db, card_id, cleanUid);
    if (dummySlot === false) return { ok: false, error: 'uid_card_mismatch', message: 'Kartu ini bukan milik UID kamu' };
    if (dummySlot !== null) return redeemDummy(db, dummySlot, cleanUid, now);

    var card = findRow(db, SHEET.SCRATCH_CARDS, 'card_id', card_id);
    if (!card) return { ok: false, error: 'card_not_found', message: 'Kartu tidak ditemukan' };
    if (card.status === STATUS.CARD_SCRATCHED) {
      var priorByCard = findRow(db, SHEET.REDEMPTIONS, 'card_id', card_id);
      if (priorByCard) return buildRedeemResponse(db, priorByCard, cfg, true);
    }
    if (card.status === STATUS.CARD_VOIDED) return { ok: false, error: 'card_voided', message: 'Kartu ini sudah tidak berlaku' };
    if (card.status === STATUS.CARD_EXPIRED) return { ok: false, error: 'card_expired', message: 'Kartu ini sudah kedaluwarsa' };

    var order = findRow(db, SHEET.ORDERS, 'order_id', card.order_id);
    if (!order || String(order.user_id) !== cleanUid) return { ok: false, error: 'uid_card_mismatch', message: 'Kartu ini bukan milik UID kamu' };
    var mintLogRow = findRow(db, SHEET.MINT_LOG, MINT_LOG_COL.ORDER_ID, card.order_id);
    var ok = mintLogRow && (mintLogRow.eligible === true || mintLogRow.eligible === 'TRUE');
    if (!ok) return { ok: false, error: 'order_not_eligible', message: 'Pesanan belum dikonfirmasi ops' };

    var merchantName = String(order.name || '');
    var pickResult;
    if (seedOpts && seedOpts.forceOutcome === OUTCOME.DRAW) {
      pickResult = { outcome_type: OUTCOME.DRAW };
    } else {
      pickResult = pickPrize(db, now);
      for (var tries = 0; seedOpts && seedOpts.forceOutcome === OUTCOME.CASH && pickResult.outcome_type !== OUTCOME.CASH && tries < 50; tries++) {
        pickResult = pickPrize(db, now);
      }
    }
    var redemptionId = genId(db, 'red');
    var nowTs = fmtTs(now);
    var redemption = {
      redemption_id: redemptionId, card_id: card_id, user_id: cleanUid, outcome_type: pickResult.outcome_type,
      cash_prize_id: pickResult.outcome_type === OUTCOME.CASH ? pickResult.cash_prize_id : '',
      scratched_at: nowTs, ip_address: payload.ip_address || '', user_agent: payload.user_agent || '',
      idempotency_key: idempotency_key || '',
    };
    appendRow(db, SHEET.REDEMPTIONS, redemption);
    updateRow(db, SHEET.SCRATCH_CARDS, card._rowNum, { status: STATUS.CARD_SCRATCHED, scratched_at: nowTs });

    if (pickResult.outcome_type === OUTCOME.CASH) {
      recordCashWin(db, pickResult.cash_prize_id, now);
      appendRow(db, SHEET.KOMISI_DISBURSEMENTS, {
        disbursement_id: genId(db, 'disb'), redemption_id: redemptionId, user_id: cleanUid, name: merchantName,
        value_idr: pickResult.value_idr, batch: batchLabelForScratch(now), status: STATUS.DISB_QUEUED,
        queued_at: nowTs, processed_at: '',
      });
    } else {
      appendRow(db, SHEET.DRAW_ENTRIES, {
        entry_id: genId(db, 'dr'), redemption_id: redemptionId, user_id: cleanUid, wave_id: waveForScratch(now),
        draw_code: generateDrawCode(db), grand_prize_id: '', result: STATUS.DRAW_PENDING, entered_at: nowTs, drawn_at: '',
      });
    }
    return buildRedeemResponse(db, redemption, cfg, false);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 07_LivestreamDraw.gs helpers + 10_LiveDrawAttendance.gs
  // ───────────────────────────────────────────────────────────────────────────
  var WAVE_DATE_LABEL = { wave1: '17 Juni 2026', wave2: '8 Juli 2026' };
  var FORM_COL_PHONE = 'Nomor HP yang Digunakan Saat Pembelian EDC BukuAgen';
  var FORM_COL_TANGGAL = 'Tanggal Undian';

  function expandGrandPrizes(grandPrizes, waveId) {
    var slots = [];
    grandPrizes.forEach(function (gp) {
      var alloc = gp.wave_allocation, n = 0;
      if (alloc === 'split') {
        n = Math.floor(Number(gp.total_qty) / 2);
        if (waveId === 'wave2' && Number(gp.total_qty) % 2 === 1) n++;
      } else if (alloc === waveId) n = Number(gp.total_qty);
      for (var i = 0; i < n; i++) slots.push({ grand_prize_id: gp.grand_prize_id, tier: gp.tier, label: gp.label, value_idr: Number(gp.value_idr) });
    });
    return slots;
  }
  function shuffleArray(db, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(db.rand() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function normalizePhone(raw) {
    if (!raw && raw !== 0) return '';
    var s = String(raw).replace(/[^0-9]/g, '');
    if (s.indexOf('62') === 0) s = s.slice(2);
    else if (s.indexOf('0') === 0) s = s.slice(1);
    return s;
  }
  function tanggalToWaveId(tanggal) {
    var t = String(tanggal || '').trim();
    for (var w in WAVE_DATE_LABEL) if (t === WAVE_DATE_LABEL[w]) return w;
    return null;
  }
  function maskPhone(raw) {
    var s = normalizePhone(raw);
    if (s.length < 7) return s;
    return s.slice(0, 3) + '****' + s.slice(-4);
  }
  function getAttendeeSet(db, waveId) {
    var set = new Set();
    try {
      readAllRows(db, FORM_LIVE_SHEET).forEach(function (r) {
        var phone = normalizePhone(r[FORM_COL_PHONE]);
        var tanggal = String(r[FORM_COL_TANGGAL] || '').trim();
        if (!phone) return;
        if (tanggalToWaveId(tanggal) === waveId) set.add(phone);
      });
    } catch (e) { /* FORM_LIVE may not exist yet */ }
    return set;
  }

  function drawPreflightWithAttendance(db, waveId) {
    var wave = findRow(db, SHEET.DRAW_WAVES, 'wave_id', waveId);
    if (!wave) return { ok: false, error: 'wave_not_found', wave_id: waveId };
    var prizeSlots = expandGrandPrizes(readAllRows(db, SHEET.GRAND_PRIZES), waveId);
    var pendingAll = readAllRows(db, SHEET.DRAW_ENTRIES).filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_PENDING; });
    var att = getAttendeeSet(db, waveId);
    var eligiblePool = pendingAll.filter(function (e) { return att.has(normalizePhone(e.user_id)); });
    var nonAttendee = pendingAll.filter(function (e) { return !att.has(normalizePhone(e.user_id)); });
    var groups = {}, order = [];
    prizeSlots.forEach(function (p) {
      if (!groups[p.tier]) { groups[p.tier] = { label: p.label, count: 0, value_idr: p.value_idr }; order.push(p.tier); }
      groups[p.tier].count++;
    });
    return {
      ok: true, wave_id: waveId, wave_label: WAVE_DATE_LABEL[waveId] || waveId,
      already_drawn: wave.status === STATUS.WAVE_DRAWN, total_draw_entries: pendingAll.length,
      total_form_attendees: att.size, eligible_pool: eligiblePool.length, non_attendee_entries: nonAttendee.length,
      prizes_to_award: prizeSlots.length, prize_summary: order.map(function (t) { return groups[t]; }),
    };
  }

  function appendDispatch(db, entryId, now) {
    appendRow(db, SHEET.PHYSICAL_DISPATCH, { dispatch_id: genId(db, 'disp'), entry_id: entryId, courier: '',
      tracking_number: '', status: STATUS.DISB_QUEUED, queued_at: now, shipped_at: '' });
  }

  function drawWaveWithAttendance(db, waveId) {
    var wave = findRow(db, SHEET.DRAW_WAVES, 'wave_id', waveId);
    if (!wave) return { ok: false, error: 'wave_not_found' };
    if (wave.status === STATUS.WAVE_DRAWN) return { ok: false, error: 'already_drawn' };
    var prizeSlots = expandGrandPrizes(readAllRows(db, SHEET.GRAND_PRIZES), waveId);
    var pendingAll = readAllRows(db, SHEET.DRAW_ENTRIES).filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_PENDING; });
    var att = getAttendeeSet(db, waveId);
    var eligible = pendingAll.filter(function (e) { return att.has(normalizePhone(e.user_id)); });
    var notAttended = pendingAll.filter(function (e) { return !att.has(normalizePhone(e.user_id)); });
    var shuffled = shuffleArray(db, eligible.slice());
    var winners = shuffled.slice(0, Math.min(prizeSlots.length, shuffled.length));
    var losers = shuffled.slice(winners.length);
    var now = fmtTs(nowJkt(db));
    var results = [];
    winners.forEach(function (entry, i) {
      var prize = prizeSlots[i];
      updateRow(db, SHEET.DRAW_ENTRIES, entry._rowNum, { grand_prize_id: prize.grand_prize_id, result: STATUS.DRAW_WON, drawn_at: now });
      appendDispatch(db, entry.entry_id, now);
      results.push({ entry_id: entry.entry_id, user_id: maskPhone(entry.user_id), draw_code: entry.draw_code,
        prize_label: prize.label, prize_tier: prize.tier, prize_value: prize.value_idr });
    });
    losers.concat(notAttended).forEach(function (entry) {
      updateRow(db, SHEET.DRAW_ENTRIES, entry._rowNum, { result: STATUS.DRAW_NOT_DRAWN, drawn_at: now });
    });
    updateRow(db, SHEET.DRAW_WAVES, wave._rowNum, { status: STATUS.WAVE_DRAWN });
    return { ok: true, wave_id: waveId, winners: results, not_drawn_attended: losers.length, not_drawn_absent: notAttended.length };
  }

  function getDrawWinners(db, waveId) {
    var idx = {};
    readAllRows(db, SHEET.GRAND_PRIZES).forEach(function (gp) { idx[gp.grand_prize_id] = gp; });
    var winners = readAllRows(db, SHEET.DRAW_ENTRIES)
      .filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_WON; })
      .map(function (e) {
        var gp = idx[e.grand_prize_id] || {};
        return { entry_id: e.entry_id, user_id: maskPhone(e.user_id), draw_code: e.draw_code,
          prize_label: gp.label || e.grand_prize_id, prize_tier: gp.tier || '', prize_value: Number(gp.value_idr) || 0, drawn_at: e.drawn_at };
      });
    return { ok: true, wave_id: waveId, winners: winners };
  }

  function drawPickOneWithAttendance(db, waveId, grandPrizeId) {
    var wave = findRow(db, SHEET.DRAW_WAVES, 'wave_id', waveId);
    if (!wave) return { ok: false, error: 'wave_not_found' };
    if (wave.status === STATUS.WAVE_DRAWN) return { ok: false, error: 'already_drawn' };
    var allSlots = expandGrandPrizes(readAllRows(db, SHEET.GRAND_PRIZES), waveId);
    var thisSlots = allSlots.filter(function (s) { return s.grand_prize_id === grandPrizeId; });
    if (thisSlots.length === 0) return { ok: false, error: 'prize_not_in_this_wave', grand_prize_id: grandPrizeId, wave_id: waveId };
    var prize = thisSlots[0], quantity = thisSlots.length;
    var allEntries = readAllRows(db, SHEET.DRAW_ENTRIES);
    var alreadyWon = allEntries.filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_WON && e.grand_prize_id === grandPrizeId; });
    if (alreadyWon.length >= quantity) return { ok: false, error: 'no_prizes_left', grand_prize_id: grandPrizeId, drawn: alreadyWon.length, total: quantity };

    var att = getAttendeeSet(db, waveId);
    var wonPhones = new Set(allEntries.filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_WON; })
      .map(function (e) { return normalizePhone(e.user_id); }));
    var eligible = allEntries.filter(function (e) {
      return e.wave_id === waveId && e.result === STATUS.DRAW_PENDING && att.has(normalizePhone(e.user_id)) && !wonPhones.has(normalizePhone(e.user_id));
    });
    if (eligible.length === 0) return { ok: false, error: 'pool_empty' };

    var winner = shuffleArray(db, eligible.slice())[0];
    var now = fmtTs(nowJkt(db));
    updateRow(db, SHEET.DRAW_ENTRIES, winner._rowNum, { grand_prize_id: grandPrizeId, result: STATUS.DRAW_WON, drawn_at: now });
    appendDispatch(db, winner.entry_id, now);

    var totalWonNow = allEntries.filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_WON; }).length + 1;
    var waveComplete = totalWonNow >= allSlots.length;
    if (waveComplete) {
      allEntries.forEach(function (e) {
        // DEMO FIX: the .gs version iterates the pre-update snapshot, so the winner just picked
        // still reads as "pending" and is overwritten to not_drawn. Skip the winner's row here.
        if (e._rowNum === winner._rowNum) return;
        if (e.wave_id === waveId && e.result === STATUS.DRAW_PENDING) {
          updateRow(db, SHEET.DRAW_ENTRIES, e._rowNum, { result: STATUS.DRAW_NOT_DRAWN, drawn_at: now });
        }
      });
      updateRow(db, SHEET.DRAW_WAVES, wave._rowNum, { status: STATUS.WAVE_DRAWN });
    }
    var w = { entry_id: winner.entry_id, user_id: maskPhone(winner.user_id), draw_code: winner.draw_code,
      prize_label: prize.label, prize_tier: prize.tier, prize_value: Number(prize.value_idr) || 0 };
    return { ok: true, wave_id: waveId, grand_prize_id: grandPrizeId, prize_label: prize.label, prize_tier: prize.tier,
      prize_value: Number(prize.value_idr) || 0, drawn: alreadyWon.length + 1, total: quantity, wave_completed: waveComplete, winner: w };
  }

  function getDrawProgress(db, waveId) {
    var slots = expandGrandPrizes(readAllRows(db, SHEET.GRAND_PRIZES), waveId);
    var allEntries = readAllRows(db, SHEET.DRAW_ENTRIES);
    var progress = {}, order = [];
    slots.forEach(function (s) {
      if (!progress[s.grand_prize_id]) {
        progress[s.grand_prize_id] = { grand_prize_id: s.grand_prize_id, tier: s.tier, label: s.label, value_idr: s.value_idr, total: 0, drawn: 0, winners: [] };
        order.push(s.grand_prize_id);
      }
      progress[s.grand_prize_id].total++;
    });
    allEntries.filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_WON; }).forEach(function (e) {
      var p = progress[e.grand_prize_id];
      if (p) { p.drawn++; p.winners.push({ entry_id: e.entry_id, user_id: maskPhone(e.user_id), draw_code: e.draw_code, drawn_at: e.drawn_at }); }
    });
    var att = getAttendeeSet(db, waveId);
    var pool = allEntries.filter(function (e) { return e.wave_id === waveId && e.result === STATUS.DRAW_PENDING && att.has(normalizePhone(e.user_id)); }).length;
    return { ok: true, wave_id: waveId, eligible_pool: pool, prizes: order.map(function (id) { return progress[id]; }) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 08_WebApp.gs — doGet router
  // ───────────────────────────────────────────────────────────────────────────
  var WRITE_ACTIONS = { redeem: 1, draw_run: 1, draw_pick_one: 1 };

  function doGet(db, params) {
    var action = params.action;
    if (action === 'health') return { ok: true, ts: fmtTs(nowJkt(db)) };
    if (action === 'lookup') return lookupByUid(db, params.uid);
    if (action === 'redeem') {
      return redeemCardInner(db, { card_id: params.card_id, uid: params.uid, idempotency_key: params.idempotency_key, user_agent: params.user_agent });
    }
    if (action === 'draw_preflight') {
      if (!params.wave_id) return { ok: false, error: 'missing wave_id' };
      return drawPreflightWithAttendance(db, params.wave_id);
    }
    if (action === 'draw_run') {
      if (!params.wave_id) return { ok: false, error: 'missing wave_id' };
      return drawWaveWithAttendance(db, params.wave_id);
    }
    if (action === 'draw_winners') {
      if (!params.wave_id) return { ok: false, error: 'missing wave_id' };
      return getDrawWinners(db, params.wave_id);
    }
    if (action === 'draw_pick_one') {
      if (!params.wave_id || !params.grand_prize_id) return { ok: false, error: 'missing_params', required: ['wave_id', 'grand_prize_id'] };
      return drawPickOneWithAttendance(db, params.wave_id, params.grand_prize_id);
    }
    if (action === 'draw_progress') {
      if (!params.wave_id) return { ok: false, error: 'missing wave_id' };
      return getDrawProgress(db, params.wave_id);
    }
    return { ok: false, error: 'unknown_action', message: 'Use ?action=lookup&uid=... or ?action=health or ?action=redeem&card_id=...&uid=...' };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Synthetic seed data
  // ───────────────────────────────────────────────────────────────────────────
  var FIRST = ['Budi', 'Siti', 'Agus', 'Dewi', 'Rudi', 'Lestari', 'Joko', 'Wati', 'Hendra', 'Ratna', 'Eko', 'Yuni',
    'Fajar', 'Indah', 'Bambang', 'Rina', 'Dedi', 'Sari', 'Teguh', 'Nur', 'Wahyu', 'Fitri', 'Arif', 'Maya', 'Slamet',
    'Ayu', 'Iwan', 'Putri', 'Yanto', 'Mega', 'Rizki', 'Ani', 'Dimas', 'Tuti', 'Gilang', 'Endang', 'Bayu', 'Lina',
    'Hadi', 'Wulan', 'Andi', 'Nina', 'Sugeng', 'Rara', 'Doni'];
  var LAST = ['Santoso', 'Rahayu', 'Wijaya', 'Lestari', 'Hidayat', 'Kusuma', 'Saputra', 'Wibowo', 'Pratama', 'Utami',
    'Nugroho', 'Setiawan', 'Purnomo', 'Handayani', 'Susanto'];
  var CHANNELS = ['Telesales', 'Website', 'Agent Referral', 'Field Sales'];

  function demoUid(i) { return '81200000' + pad(i, 2); }

  // Seed plan (indexes are merchant numbers 1..45, uid = 81200000NN)
  var WAVE1_DRAW = [2, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];  // scratched ≤ 16 Jun → wave1 draw tickets
  var WAVE1_ABSENT = [13, 21];                                 // did not fill FORM_LIVE
  var WAVE2_DRAW = [26, 28, 30, 32, 34, 36, 38];               // scratched 17–19 Jun → wave2 draw tickets
  var WAVE2_ABSENT = [34];
  var UNSCRATCHED = [31, 35, 39, 40];

  function productFor(i) {
    if (i % 6 === 0) return { product_name: 'Android - New', price: 1899000 };
    if (i % 7 === 0) return { product_name: 'Saku - Printer Bundle', price: 749000 };
    if (i % 11 === 0) return { product_name: 'Saku - Insurance Bundle', price: 499000 };
    return { product_name: 'Saku', price: 449000 };
  }

  function buildSeed(db) {
    setupSupportingSheets(db);
    var R = db.rand;
    var orders = [];
    function addOrder(i, opts) {
      var p = opts.product || productFor(i);
      var paid = '2026-06-' + pad(opts.day) + ' ' + pad(9 + Math.floor(R() * 10)) + ':' + pad(Math.floor(R() * 60)) + ':' + pad(Math.floor(R() * 60));
      var opsTs = opts.pendingOps ? '' : fmtTs(new Date(toDate(paid).getTime() + (1 + Math.floor(R() * 4)) * 3600e3));
      orders.push({
        paid_at_jkt: paid, order_id: 'ORD-2606' + pad(opts.day) + '-' + pad(i, 3) + (opts.suffix || ''),
        status: opts.status || 'Completed', payment_status: 'PAID', tfcode: opts.tfcode || ('TS' + pad(1 + (i % 9), 2)),
        channel: CHANNELS[i % CHANNELS.length], user_id: demoUid(i),
        name: FIRST[(i - 1) % FIRST.length] + ' ' + LAST[(i * 7) % LAST.length],
        product_name: p.product_name, price: p.price, waiting_for_ops_at_ts: opsTs, last_updated_at: opsTs || paid,
      });
    }
    for (var i = 1; i <= 40; i++) addOrder(i, { day: 1 + Math.floor((i - 1) * 18 / 40) });
    addOrder(3, { day: 12, suffix: 'B', product: { product_name: 'Saku', price: 449000 } }); // repeat buyer: 2 orders
    addOrder(41, { day: 18, product: { product_name: 'Saku', price: 449000 } });
    addOrder(42, { day: 19, product: { product_name: 'Android - New', price: 1899000 } });
    addOrder(43, { day: 15, product: { product_name: 'Android - New', price: 1899000 } });
    addOrder(44, { day: 19, product: { product_name: 'Saku', price: 449000 }, pendingOps: true });
    addOrder(45, { day: 17, product: { product_name: 'Saku - Printer Bundle', price: 749000 }, tfcode: 'SHOPEE' });

    // Scratch plan
    var scratches = [];
    function plan(i, seq, dayNum, force) {
      scratches.push({ uid: demoUid(i), seq: seq, at: '2026-06-' + pad(dayNum) + ' ' + pad(8 + Math.floor(R() * 13)) + ':' +
        pad(Math.floor(R() * 60)) + ':' + pad(Math.floor(R() * 60)), force: force, orderIdx: i });
    }
    orders.forEach(function (o) {
      var i = Number(o.user_id.slice(-2));
      if (i > 40 && i !== 43) return;
      if (UNSCRATCHED.indexOf(i) !== -1) return;
      var paidDay = Number(o.paid_at_jkt.slice(8, 10));
      var isAndroid = o.product_name.indexOf('Android') !== -1;
      var isW1 = WAVE1_DRAW.indexOf(i) !== -1, isW2 = WAVE2_DRAW.indexOf(i) !== -1;
      var day = paidDay + 1 + Math.floor(R() * 2);
      if (isW1) day = Math.min(day, 16);
      if (isW2) day = Math.max(day, 17 + (i % 3));
      if (o.order_id.slice(-1) === 'B') { isW1 = false; isW2 = false; }
      day = Math.min(day, 19);
      plan(i, 1, day, (isW1 || isW2) ? 'draw' : 'cash');
      if (isAndroid && i !== 43) plan(i, 2, Math.min(day + 1, 19), 'cash');
      o.__seedOrder = true;
    });

    // Chronological replay: orders arrive → sync (mints cards) at 23:30 → scratches happen on later days.
    var clockMs = toDate('2026-06-01 00:00:00').getTime();
    db.clock = function () { return clockMs; };
    var rawSheet = db.tables[SHEET.ORDERS];
    for (var d = 1; d <= 19; d++) {
      var dayStr = '2026-06-' + pad(d);
      var todays = scratches.filter(function (s) { return s.at.slice(0, 10) === dayStr; })
        .sort(function (a, b) { return a.at < b.at ? -1 : 1; });
      todays.forEach(function (s) {
        clockMs = toDate(s.at).getTime();
        var card = readAllRows(db, SHEET.SCRATCH_CARDS).filter(function (c) {
          return c.user_id === s.uid && c.status === STATUS.CARD_BOUND;
        }).sort(function (a, b) { return (a.order_id + a.sequence_no) < (b.order_id + b.sequence_no) ? -1 : 1; })[0];
        if (!card) return;
        redeemCardInner(db, { card_id: card.card_id, uid: s.uid, idempotency_key: card.card_id + '-' + clockMs,
          user_agent: 'Mozilla/5.0 (Linux; Android 13) synthetic-seed' }, { forceOutcome: s.force });
      });
      orders.forEach(function (o) {
        if (o.paid_at_jkt.slice(0, 10) === dayStr) {
          var row = {}; db.headers[SHEET.ORDERS].forEach(function (h) { row[h] = o[h]; });
          rawSheet.push(row);
        }
      });
      clockMs = toDate(dayStr + ' 23:30:00').getTime();
      syncOrders(db);
    }

    // Attendance (FORM_LIVE) — varied phone formats on purpose; normalizePhone_ handles them.
    var fmts = [function (u) { return '0' + u.slice(0, 3) + '-' + u.slice(3, 7) + '-' + u.slice(7); },
      function (u) { return '+62 ' + u.slice(0, 3) + ' ' + u.slice(3, 7) + ' ' + u.slice(7); },
      function (u) { return '62' + u; }, function (u) { return '0' + u; }];
    var form = db.tables[FORM_LIVE_SHEET];
    function attend(i, label, dayHour) {
      form.push({ 'Timestamp': dayHour + ':' + pad(Math.floor(R() * 60)) + ':' + pad(Math.floor(R() * 60)),
        'Nomor HP yang Digunakan Saat Pembelian EDC BukuAgen': fmts[i % fmts.length](demoUid(i)), 'Tanggal Undian': label });
    }
    WAVE1_DRAW.filter(function (i) { return WAVE1_ABSENT.indexOf(i) === -1; }).forEach(function (i, k) { attend(i, '17 Juni 2026', '2026-06-16 ' + pad(10 + k)); });
    attend(1, '17 Juni 2026', '2026-06-16 20');  // registered but only has cash (not in pool)
    attend(4, '17 Juni 2026', '2026-06-16 21');
    attend(2, '17 Juni 2026', '2026-06-16 22');  // duplicate submission (deduped)
    WAVE2_DRAW.filter(function (i) { return WAVE2_ABSENT.indexOf(i) === -1; }).forEach(function (i, k) { attend(i, '8 Juli 2026', '2026-06-19 ' + pad(9 + k)); });
    [41, 42, 43].forEach(function (i, k) { attend(i, '8 Juli 2026', '2026-06-19 ' + pad(17 + k)); });

    // Batches whose Friday payout date has passed are marked sent (stands in for the
    // 09_DisbursementExport.gs CSV → finance handoff, which isn't part of the HTTP API).
    var seedEnd = '2026-06-19';
    db.tables[SHEET.KOMISI_DISBURSEMENTS].forEach(function (row) {
      var slot = DISBURSEMENT_SCHEDULE.find(function (s) { return s.disb.d + ' ' + ID_MONTHS[s.disb.m] + ' ' + s.disb.y === row.batch; });
      if (!slot) return;
      var payDate = slot.disb.y + '-' + pad(slot.disb.m) + '-' + pad(slot.disb.d);
      if (payDate <= seedEnd) { row.status = STATUS.DISB_SENT; row.processed_at = payDate + ' 10:00:00'; }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Runtime: state, persistence, latency, logging
  // ───────────────────────────────────────────────────────────────────────────
  var simBaseMs = toDate(DEFAULT_NOW).getTime();
  var simSetAtMs = Date.now();
  function simNow() { return simBaseMs + (Date.now() - simSetAtMs); }

  var db = makeDb({ clock: simNow });
  var logListeners = [], changeListeners = [], logBuffer = [], logSeq = 0;

  function storageGet() { try { return global.localStorage ? global.localStorage.getItem(STORAGE_KEY) : null; } catch (e) { return null; } }
  function storageSet(v) { try { if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, v); } catch (e) { /* quota / disabled */ } }
  function storageRemove() { try { if (global.localStorage) global.localStorage.removeItem(STORAGE_KEY); } catch (e) { } }

  function save() {
    storageSet(JSON.stringify({ v: STATE_VERSION, simNowMs: simNow(), tables: db.tables, headers: db.headers }));
  }
  function loadFrom(text) {
    try {
      var s = JSON.parse(text);
      if (!s || s.v !== STATE_VERSION || !s.tables) return false;
      db.tables = s.tables; db.headers = s.headers; db._configCache = null;
      if (s.simNowMs) { simBaseMs = s.simNowMs; simSetAtMs = Date.now(); }
      return true;
    } catch (e) { return false; }
  }
  function freshSeed() {
    var seedDb = makeDb({ rand: mulberry32(20260601) });
    buildSeed(seedDb);
    db.tables = seedDb.tables; db.headers = seedDb.headers; db._configCache = null;
    simBaseMs = toDate(DEFAULT_NOW).getTime(); simSetAtMs = Date.now();
  }
  function emitChange(reason) {
    changeListeners.slice().forEach(function (fn) { try { fn({ reason: reason }); } catch (e) { } });
  }
  function emitLog(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > 300) logBuffer.shift();
    logListeners.slice().forEach(function (fn) { try { fn(entry); } catch (e) { } });
  }

  var stored = storageGet();
  if (!stored || !loadFrom(stored)) { freshSeed(); save(); }

  try {
    global.addEventListener('storage', function (ev) {
      if (ev.key !== STORAGE_KEY) return;
      if (ev.newValue && loadFrom(ev.newValue)) emitChange('storage');
      else if (!ev.newValue) { freshSeed(); emitChange('reset'); }
    });
  } catch (e) { }

  function parseParams(url) {
    var q = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?') + 1);
    var params = {};
    new URLSearchParams(q).forEach(function (v, k) { params[k] = v; });
    return params;
  }

  var MockAPI = {
    __core: true,
    version: STATE_VERSION,
    BASE_URL: 'https://script.google.com/macros/s/MOCK_API/exec',
    latency: { min: 300, max: 600 },

    /** Answers a mocked URL. Resolves to the JSON text (cross-realm safe). */
    request: function (url, meta) {
      var self = this;
      var params = parseParams(url);
      var started = Date.now();
      var delay = self.latency.min + Math.random() * (self.latency.max - self.latency.min);
      return new Promise(function (resolve) {
        setTimeout(function () {
          var resp;
          db._configCache = null;
          try { resp = doGet(db, params); }
          catch (e) { resp = { ok: false, error: 'exception', message: String(e && e.message || e) }; }
          if (WRITE_ACTIONS[params.action]) { save(); emitChange(params.action); }
          var text = JSON.stringify(resp);
          emitLog({ id: ++logSeq, at: Date.now(), sim_now: fmtTs(simNow()), source: (meta && meta.source) || 'unknown',
            action: params.action || '(none)', params: params, url: url, ms: Date.now() - started, response: JSON.parse(text) });
          resolve(text);
        }, delay);
      });
    },
    /** Convenience: call an action with a params object; resolves to the parsed response. */
    call: function (action, params, meta) {
      var qs = new URLSearchParams(Object.assign({ action: action }, params || {})).toString();
      return this.request(this.BASE_URL + '?' + qs, meta || { source: 'shell' }).then(JSON.parse);
    },

    get tables() { return db.tables; },
    get headers() { return db.headers; },
    sheetNames: function () { return Object.keys(db.tables); },

    reset: function () {
      storageRemove(); freshSeed(); save();
      logBuffer.length = 0;
      emitChange('reset');
    },
    now: function () { return new Date(simNow()); },
    nowTs: function () { return fmtTs(simNow()); },
    setNow: function (v) {
      simBaseMs = toDate(v).getTime(); simSetAtMs = Date.now();
      save(); emitChange('clock');
    },

    onLog: function (fn) {
      logListeners.push(fn);
      return function () { var i = logListeners.indexOf(fn); if (i !== -1) logListeners.splice(i, 1); };
    },
    onChange: function (fn) {
      changeListeners.push(fn);
      return function () { var i = changeListeners.indexOf(fn); if (i !== -1) changeListeners.splice(i, 1); };
    },
    getLog: function () { return logBuffer.slice(); },
    clearLog: function () { logBuffer.length = 0; },

    admin: {
      /** Runs 02_Sync.gs syncOrders() at the simulated now. */
      syncOrders: function () { db._configCache = null; var r = syncOrders(db); save(); emitChange('sync'); return r; },
      /** Simulates ops confirming every unconfirmed PAID order for a uid (sets waiting_for_ops_at_ts). */
      confirmOps: function (uid) {
        var n = 0;
        db.tables[SHEET.ORDERS].forEach(function (o) {
          if (String(o.user_id) === String(uid) && !o.waiting_for_ops_at_ts) { o.waiting_for_ops_at_ts = fmtTs(simNow()); o.last_updated_at = o.waiting_for_ops_at_ts; n++; }
        });
        save(); emitChange('ops');
        return n;
      },
      regenerateDailyQuotas: function () { var r = regenerateDailyQuotas(db); save(); emitChange('quotas'); return r; },
    },

    /** Pure engine pieces, reusable against any db (the simulator builds its own). */
    engine: {
      SHEET: SHEET, OUTCOME: OUTCOME, CASH_PRIZE_SEED: CASH_PRIZE_SEED,
      CASH_PRIZE_HEADERS: CASH_PRIZE_HEADERS, QUOTA_HEADERS: QUOTA_HEADERS,
      makeDb: makeDb, mulberry32: mulberry32, buildCashPrizeRows: buildCashPrizeRows,
      buildDailyQuotaRows: buildDailyQuotaRows, pickPrize: pickPrize, recordCashWin: recordCashWin,
      fmtTs: fmtTs, fmtDate: fmtDate, fmtDateId: fmtDateId, toDate: toDate,
      batchLabelForScratch: batchLabelForScratch, waveForScratch: waveForScratch,
      expandGrandPrizes: expandGrandPrizes, normalizePhone: normalizePhone, maskPhone: maskPhone,
      generateCardId: generateCardId, generateDrawCode: generateDrawCode, doGet: doGet,
    },

    demoUids: [
      { uid: '8000000001', label: 'Dummy · Rp 5.000', note: 'DUMMY_CARDS test UID, deterministic cash 5k' },
      { uid: '8000000006', label: 'Dummy · Rp 200.000', note: 'Highest cash tier' },
      { uid: '8000000007', label: 'Dummy · Grand-prize draw', note: 'Draw outcome with a GOSOK-XXXXX code' },
      { uid: '8000000008', label: 'Dummy · Android 2 cards', note: 'Two cards: Rp 50.000 + Rp 20.000' },
      { uid: '8120000041', label: 'Fresh Saku card', note: 'Real picker: random weighted outcome' },
      { uid: '8120000042', label: 'Fresh Android ×2', note: 'Two unscratched cards, random outcomes' },
      { uid: '8120000043', label: 'Half scratched', note: 'Android: card #1 done, card #2 ready' },
      { uid: '8120000002', label: 'Wave 1 ticket', note: 'Pending draw entry; run the operator draw, then re-check' },
      { uid: '8120000003', label: 'Repeat buyer', note: 'Two orders, all scratched (summary view)' },
      { uid: '8120000044', label: 'Pending ops', note: 'Paid, not ops-confirmed → order_pending' },
      { uid: '8120000045', label: 'Blocked channel', note: 'tfcode SHOPEE → never eligible (stays pending)' },
      { uid: '8120000099', label: 'No order', note: 'Unknown number → no_order' },
    ],
  };

  global.MockAPI = MockAPI;
  installFetch(MockAPI);
})(typeof window !== 'undefined' ? window : this);
