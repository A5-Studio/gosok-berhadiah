/**
 * 02_Sync.gs — Reads "Raw Order Data", mints card stubs for eligible orders.
 * Sync state (eligible, cards_minted, last_sync) stored in MINT_LOG sheet.
 * Raw Order Data columns A–Z are NEVER written to.
 *
 * Changes vs. previous version:
 *   - All reads/writes of campaign_eligible/cards_minted/last_sync
 *     moved from Raw Order Data AA-AC columns → MINT_LOG sheet
 *   - _ensureCampaignColumns and _setCampaignCols removed
 *   - CAMPAIGN_COL removed — use MINT_LOG_COL instead
 *   - backfillMintLog() — one-time helper to populate MINT_LOG from
 *     existing SCRATCH_CARDS data (for orders already minted)
 *   - generateCardId_() local copy avoids Apps Script load-order issues
 *   - campaign_cards_minted set ONLY after appendRow succeeds
 */

// Local copy — avoids load-order dependency on 00_Config.gs
function generateCardId_() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return 'KARTUGOSOK-' + suffix;
}

// ─── syncOrders ───────────────────────────────────────────────────────────────

function syncOrders() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { Logger.log('syncOrders: could not acquire lock, skipping'); return; }

  try {
    const cfg = getConfig();
    Logger.log('syncOrders: starting');

    const allOrders  = readAllRows(SHEET.ORDERS);
    const mintLog    = readAllRows(SHEET.MINT_LOG);
    const mintLogMap = {};
    mintLog.forEach(r => { mintLogMap[r.order_id] = r; });

    let minted_count = 0, voided = 0;

    allOrders.forEach(o => {
      const eligible    = isEligibleNow(o, cfg);
      const logRow      = mintLogMap[o.order_id];
      const wasEligible = logRow ? (logRow.eligible === true || logRow.eligible === 'TRUE') : false;
      const alreadyMinted = logRow ? (logRow.cards_minted === true || logRow.cards_minted === 'TRUE') : false;

      // Upsert eligibility state to MINT_LOG
      if (!logRow) {
        // New order — always write a row
        appendRow(SHEET.MINT_LOG, {
          [MINT_LOG_COL.ORDER_ID]:     o.order_id,
          [MINT_LOG_COL.USER_ID]:      o.user_id,
          [MINT_LOG_COL.ELIGIBLE]:     eligible,
          [MINT_LOG_COL.CARDS_MINTED]: false,
          [MINT_LOG_COL.LAST_SYNC]:    fmtTs(nowJkt()),
          [MINT_LOG_COL.PRODUCT_NAME]: o.product_name,
          [MINT_LOG_COL.PAID_AT]:      fmtDate(o.paid_at_jkt),
        });
        mintLogMap[o.order_id] = { eligible: eligible, cards_minted: false };
      } else if (eligible !== wasEligible) {
        updateRow(SHEET.MINT_LOG, logRow._rowNum, {
          [MINT_LOG_COL.ELIGIBLE]:  eligible,
          [MINT_LOG_COL.LAST_SYNC]: fmtTs(nowJkt()),
        });
        mintLogMap[o.order_id].eligible = eligible;
      }

      if (eligible && !alreadyMinted) {
        // Mint first, then flag — never the other way around
        const count = mintCardsForOrder(o, cfg);
        if (count > 0) {
          const lr = mintLogMap[o.order_id];
          const rowNum = logRow ? logRow._rowNum : null;
          if (rowNum) {
            updateRow(SHEET.MINT_LOG, rowNum, {
              [MINT_LOG_COL.CARDS_MINTED]: true,
              [MINT_LOG_COL.LAST_SYNC]:    fmtTs(nowJkt()),
            });
          } else {
            // Row was just appended — find it
            const fresh = findRow(SHEET.MINT_LOG, MINT_LOG_COL.ORDER_ID, o.order_id);
            if (fresh) updateRow(SHEET.MINT_LOG, fresh._rowNum, {
              [MINT_LOG_COL.CARDS_MINTED]: true,
              [MINT_LOG_COL.LAST_SYNC]:    fmtTs(nowJkt()),
            });
          }
          minted_count++;
        }
      } else if (!eligible && alreadyMinted) {
        const cards = findRows(SHEET.SCRATCH_CARDS, 'order_id', o.order_id);
        const hasScratched = cards.some(c => c.status === STATUS.CARD_SCRATCHED);
        if (!hasScratched) {
          voidCardsForOrder(cards);
          const lr = logRow;
          if (lr) updateRow(SHEET.MINT_LOG, lr._rowNum, {
            [MINT_LOG_COL.CARDS_MINTED]: false,
            [MINT_LOG_COL.LAST_SYNC]:    fmtTs(nowJkt()),
          });
          voided++;
        }
      }
    });

    setConfig('last_sync_at', fmtTs(nowJkt()));
    // Re-read MINT_LOG after all updates for accurate final count
    const finalMintLog = readAllRows(SHEET.MINT_LOG);
    const totalMinted  = finalMintLog.filter(r => r.cards_minted === true || r.cards_minted === 'TRUE').length;
    const totalElig    = finalMintLog.filter(r => r.eligible === true || r.eligible === 'TRUE').length;
    Logger.log('syncOrders: done' +
      ' | orders_scanned=' + allOrders.length +
      ' | eligible=' + totalElig +
      ' | total_minted=' + totalMinted +
      ' | new_minted_this_run=' + minted_count +
      ' | voided=' + voided);
  } finally {
    lock.releaseLock();
  }
}

// ─── Eligibility check ────────────────────────────────────────────────────────

function isEligibleNow(order, cfg) {
  if (order.payment_status !== 'PAID') return false;
  if (!order.waiting_for_ops_at_ts) return false;
  if (['Cancelled', 'Rejected'].indexOf(order.status) !== -1) return false;
  const blocked = (cfg.blocked_tfcodes || '').split(',').map(s => s.trim()).filter(Boolean);
  if (blocked.indexOf(String(order.tfcode)) !== -1) return false;
  const allowed = (cfg.allowed_products || '').split(',').map(s => s.trim()).filter(Boolean);
  const productName = String(order.product_name || '');
  const productAllowed = allowed.some(ap => productName === ap || productName.startsWith(ap));
  if (!productAllowed) return false;
  const paid = fmtDate(order.paid_at_jkt);
  if (paid < cfg.campaign_start || paid > cfg.campaign_end) return false;
  return true;
}

// ─── Card minting / voiding ───────────────────────────────────────────────────

/** Creates SCRATCH_CARDS rows for a newly eligible order. Returns count of cards minted. */
function mintCardsForOrder(order, cfg) {
  const productName = String(order.product_name || '');
  const isAndroid   = productName.indexOf('Android') !== -1;
  const quota       = isAndroid
    ? Number(cfg.android_card_quota || 2)
    : Number(cfg.saku_card_quota    || 1);

  const now = fmtTs(nowJkt());
  for (let i = 1; i <= quota; i++) {
    appendRow(SHEET.SCRATCH_CARDS, {
      card_id:      generateCardId_(),
      user_id:      order.user_id,
      order_id:     order.order_id,
      sequence_no:  i,
      status:       STATUS.CARD_BOUND,
      bound_at:     now,
      scratched_at: '',
    });
  }
  Logger.log('mintCardsForOrder: ' + order.order_id + ' quota=' + quota);
  return quota;
}

function voidCardsForOrder(cards) {
  cards.forEach(c => {
    if (c.status === STATUS.CARD_BOUND) {
      updateRow(SHEET.SCRATCH_CARDS, c._rowNum, { status: STATUS.CARD_VOIDED });
    }
  });
}

function expireOldCards() {
  const cutoff = new Date('2026-07-08T11:59:00+07:00');
  if (nowJkt() < cutoff) { Logger.log('expireOldCards: cutoff not yet reached'); return; }
  const cards = readAllRows(SHEET.SCRATCH_CARDS);
  let count = 0;
  cards.forEach(c => {
    if (c.status === STATUS.CARD_BOUND) {
      updateRow(SHEET.SCRATCH_CARDS, c._rowNum, { status: STATUS.CARD_EXPIRED });
      count++;
    }
  });
  Logger.log('expireOldCards: expired ' + count + ' cards');
}

// ─── MINT_LOG helpers ─────────────────────────────────────────────────────────

/**
 * ONE-TIME backfill — call once after migrating to MINT_LOG.
 * Populates MINT_LOG from existing SCRATCH_CARDS data so orders
 * already minted are not re-minted on next syncOrders run.
 * Safe to call multiple times — uses upsert on order_id.
 */
function backfillMintLog() {
  const cfg      = getConfig();
  const allOrders  = readAllRows(SHEET.ORDERS);
  const allCards   = readAllRows(SHEET.SCRATCH_CARDS);
  const mintLog    = readAllRows(SHEET.MINT_LOG);

  const mintLogMap  = {};
  mintLog.forEach(r => { mintLogMap[r.order_id] = r; });

  const cardOrderIds = new Set(allCards.map(c => c.order_id));
  const nowTs = fmtTs(nowJkt());
  let inserted = 0, skipped = 0;

  allOrders.forEach(o => {
    if (mintLogMap[o.order_id]) { skipped++; return; } // already in MINT_LOG

    const eligible    = isEligibleNow(o, cfg);
    const hasMinted   = cardOrderIds.has(o.order_id);

    appendRow(SHEET.MINT_LOG, {
      [MINT_LOG_COL.ORDER_ID]:     o.order_id,
      [MINT_LOG_COL.USER_ID]:      o.user_id,
      [MINT_LOG_COL.ELIGIBLE]:     eligible,
      [MINT_LOG_COL.CARDS_MINTED]: hasMinted,
      [MINT_LOG_COL.LAST_SYNC]:    nowTs,
      [MINT_LOG_COL.PRODUCT_NAME]: o.product_name,
      [MINT_LOG_COL.PAID_AT]:      fmtDate(o.paid_at_jkt),
    });
    inserted++;
  });

  Logger.log('backfillMintLog: inserted=' + inserted + ' skipped=' + skipped);
  return 'Done — inserted ' + inserted + ', skipped ' + skipped;
}

// ─── setupSupportingSheets ────────────────────────────────────────────────────

function setupSupportingSheets() {
  const spreadsheet = ss();
  Logger.log('setupSupportingSheets: starting');

  Logger.log('  (Raw Order Data columns A-Z untouched — sync state in MINT_LOG)');

  function getOrCreate(name, force) {
    let sh = spreadsheet.getSheetByName(name);
    if (!sh) {
      sh = spreadsheet.insertSheet(name);
      Logger.log('  + Created sheet: ' + name);
      return { sh: sh, isNew: true };
    }
    if (force) {
      sh.clearContents();
      Logger.log('  ~ Force-cleared sheet: ' + name);
      return { sh: sh, isNew: true };
    }
    Logger.log('  = Skipped (already exists): ' + name);
    return { sh: sh, isNew: false };
  }

  function setHeaders(sh, headers) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  function appendData(sh, headers, rows) {
    if (!rows.length) return;
    const data = rows.map(r => headers.map(h => (r[h] !== undefined ? r[h] : '')));
    sh.getRange(2, 1, data.length, headers.length).setValues(data);
  }

  // ── 3. CASH_PRIZES ──────────────────────────────────────────────────────────
  {
    const { sh: shCP, isNew: isNewCP } = getOrCreate(SHEET.CASH_PRIZES);
    if (isNewCP) {
      const headers = ['cash_prize_id','tier','value_idr','label_id','total_qty','remaining_qty','weight_multiplier'];
      setHeaders(shCP, headers);
      const rows = [
        { cash_prize_id:'cash_5k',   tier:'komisi_5k',   value_idr:5000,   label_id:'Komisi Agen Rp 5.000',   total_qty:8666, remaining_qty:8666, weight_multiplier:1 },
        { cash_prize_id:'cash_10k',  tier:'komisi_10k',  value_idr:10000,  label_id:'Komisi Agen Rp 10.000',  total_qty:2317, remaining_qty:2317, weight_multiplier:1 },
        { cash_prize_id:'cash_20k',  tier:'komisi_20k',  value_idr:20000,  label_id:'Komisi Agen Rp 20.000',  total_qty:2000, remaining_qty:2000, weight_multiplier:1 },
        { cash_prize_id:'cash_50k',  tier:'komisi_50k',  value_idr:50000,  label_id:'Komisi Agen Rp 50.000',  total_qty:500,  remaining_qty:500,  weight_multiplier:1 },
        { cash_prize_id:'cash_100k', tier:'komisi_100k', value_idr:100000, label_id:'Komisi Agen Rp 100.000', total_qty:150,  remaining_qty:150,  weight_multiplier:1 },
        { cash_prize_id:'cash_200k', tier:'komisi_200k', value_idr:200000, label_id:'Komisi Agen Rp 200.000', total_qty:50,   remaining_qty:50,   weight_multiplier:1 },
      ];
      appendData(shCP, headers, rows);
      Logger.log('  ✓ CASH_PRIZES seeded (' + rows.length + ' tiers)');
    }
  }

  // ── 4. CASH_PRIZE_DAILY_QUOTAS ──────────────────────────────────────────────
  {
    const { sh: shDQ, isNew: isNewDQ } = getOrCreate(SHEET.CASH_PRIZE_DAILY_QUOTAS);
    if (isNewDQ) {
      const headers = ['date','cash_prize_id','daily_qty','given_out_today'];
      setHeaders(shDQ, headers);
      const tierCaps = { cash_5k:8666, cash_10k:2317, cash_20k:2000, cash_50k:500, cash_100k:150, cash_200k:50 };
      const tierIds  = Object.keys(tierCaps);
      const start    = new Date('2026-06-01T00:00:00+07:00');
      const end      = new Date('2026-07-08T00:00:00+07:00');
      const totalDays = Math.round((end - start) / 86400000) + 1;
      const rows = [];
      let cursor = new Date(start);
      while (cursor <= end) {
        const dateStr = Utilities.formatDate(cursor, 'Asia/Jakarta', 'yyyy-MM-dd');
        tierIds.forEach(tid => {
          rows.push({ date: dateStr, cash_prize_id: tid,
            daily_qty: Math.max(1, Math.ceil(tierCaps[tid] / totalDays)), given_out_today: 0 });
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      appendData(shDQ, headers, rows);
      Logger.log('  ✓ CASH_PRIZE_DAILY_QUOTAS seeded (' + rows.length + ' rows)');
    }
  }

  // ── 5. GRAND_PRIZES ─────────────────────────────────────────────────────────
  {
    const { sh: shGP, isNew: isNewGP } = getOrCreate(SHEET.GRAND_PRIZES);
    if (isNewGP) {
      const headers = ['grand_prize_id','tier','label','value_idr','total_qty','wave_allocation'];
      setHeaders(shGP, headers);
      const rows = [
        { grand_prize_id:'gp_smartphone', tier:'smartphone', label:'Samsung S24 / equiv.', value_idr:8000000,  total_qty:2,  wave_allocation:'split' },
        { grand_prize_id:'gp_tablet',     tier:'tablet',     label:'iPad mini / equiv.',   value_idr:3500000,  total_qty:5,  wave_allocation:'split' },
        { grand_prize_id:'gp_cctv',       tier:'cctv',       label:'Smart CCTV Camera',    value_idr:1000000,  total_qty:10, wave_allocation:'split' },
      ];
      appendData(shGP, headers, rows);
      Logger.log('  ✓ GRAND_PRIZES seeded');
    }
  }

  // ── 6. DRAW_WAVES ────────────────────────────────────────────────────────────
  {
    const { sh: shDW, isNew: isNewDW } = getOrCreate(SHEET.DRAW_WAVES);
    if (isNewDW) {
      const headers = ['wave_id','label','scratch_window_start','scratch_window_end',
                       'livestream_date','livestream_url','prizes_allocated','status'];
      setHeaders(shDW, headers);
      const rows = WAVE_SCHEDULE.map(w => ({
        wave_id: w.wave_id, label: w.label,
        scratch_window_start: w.scratch_from, scratch_window_end: w.scratch_to,
        livestream_date: w.livestream_date, livestream_url: w.livestream_url,
        prizes_allocated: w.prizes_allocated, status: w.status,
      }));
      appendData(shDW, headers, rows);
      Logger.log('  ✓ DRAW_WAVES seeded');
    }
  }

  // ── 7. Empty transactional sheets ───────────────────────────────────────────
  const emptySheets = {
    [SHEET.SCRATCH_CARDS]: [
      'card_id','user_id','order_id','sequence_no','status','bound_at','scratched_at'
    ],
    [SHEET.REDEMPTIONS]: [
      'redemption_id','card_id','user_id','outcome_type','cash_prize_id',
      'scratched_at','ip_address','user_agent','idempotency_key'
    ],
    [SHEET.DRAW_ENTRIES]: [
      'entry_id','redemption_id','user_id','wave_id','draw_code','grand_prize_id',
      'result','entered_at','drawn_at'
    ],
    [SHEET.KOMISI_DISBURSEMENTS]: [
      'disbursement_id','redemption_id','user_id','name','value_idr','batch','status','queued_at','processed_at'
    ],
    [SHEET.PHYSICAL_DISPATCH]: [
      'dispatch_id','entry_id','courier','tracking_number','status','queued_at','shipped_at'
    ],
    [SHEET.CASH_PRIZE_AUDIT]: [
      'audit_id','cash_prize_id','field_changed','old_value','new_value',
      'changed_by','changed_at','reason'
    ],
    [SHEET.MINT_LOG]: [
      'order_id','user_id','eligible','cards_minted','last_sync','product_name','paid_at_jkt'
    ],
    [SHEET.DISBURSEMENT_PROGRESS]: [
      'batch','total_disbursement_needed','unique_users','file_url','file_id',
      'status','generated_at','processed_at'
    ],
    // DUMMY_CARDS excluded — seeded separately in block 7b
  };

  Object.entries(emptySheets).forEach(([name, headers]) => {
    const { sh, isNew } = getOrCreate(name);
    if (isNew) {
      setHeaders(sh, headers);
      Logger.log('  ✓ ' + name + ' — headers set, empty');
    }
  });

  // ── 7b. Seed DUMMY_CARDS — full self-contained schema ────────────────────────
  {
    const { sh, isNew } = getOrCreate(SHEET.DUMMY_CARDS);
    if (isNew) {
      const dummyHeaders = [
        'uid','name','product_type','prize_tier','card_id',
        'draw_code','active','scratched_at','batch','notes'
      ];
      setHeaders(sh, dummyHeaders);
      const slots = [
        { uid:'8000000001', name:'Test Saku 5rb',    product_type:'saku',    prize_tier:'cash_5k',   notes:'Test: Komisi Rp 5.000' },
        { uid:'8000000002', name:'Test Saku 10rb',   product_type:'saku',    prize_tier:'cash_10k',  notes:'Test: Komisi Rp 10.000' },
        { uid:'8000000003', name:'Test Saku 20rb',   product_type:'saku',    prize_tier:'cash_20k',  notes:'Test: Komisi Rp 20.000' },
        { uid:'8000000004', name:'Test Saku 50rb',   product_type:'saku',    prize_tier:'cash_50k',  notes:'Test: Komisi Rp 50.000' },
        { uid:'8000000005', name:'Test Saku 100rb',  product_type:'saku',    prize_tier:'cash_100k', notes:'Test: Komisi Rp 100.000' },
        { uid:'8000000006', name:'Test Saku 200rb',  product_type:'saku',    prize_tier:'cash_200k', notes:'Test: Komisi Rp 200.000' },
        { uid:'8000000007', name:'Test Grand Prize', product_type:'saku',    prize_tier:'draw',      notes:'Test: Grand Prize draw pool' },
        { uid:'8000000008', name:'Test Android',     product_type:'android', prize_tier:'cash_50k',  notes:'Test: Android kartu #1' },
        { uid:'8000000008', name:'Test Android',     product_type:'android', prize_tier:'cash_20k',  notes:'Test: Android kartu #2' },
      ];
      const dummyData = slots.map(s => {
        const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        function rndStr(len) {
          let out = '';
          for (let i = 0; i < len; i++) out += alpha.charAt(Math.floor(Math.random() * alpha.length));
          return out;
        }
        return {
          uid: s.uid, name: s.name, product_type: s.product_type,
          prize_tier: s.prize_tier,
          card_id:    'KARTUGOSOK-' + rndStr(8),
          draw_code:  s.prize_tier === 'draw' ? 'GOSOK-' + rndStr(5) : '',
          active: true, scratched_at: '', batch: '', notes: s.notes,
        };
      });
      appendData(sh, dummyHeaders, dummyData);
      Logger.log('  ✓ DUMMY_CARDS seeded (' + dummyData.length + ' slots)');
    }
  }

  // ── 8. CONFIG ────────────────────────────────────────────────────────────────
  {
    let sh = spreadsheet.getSheetByName(SHEET.CONFIG);
    const needsSeed = !sh || sh.getLastRow() < 2;
    if (!sh) {
      sh = spreadsheet.insertSheet(SHEET.CONFIG);
      Logger.log('  + Created sheet: CONFIG');
    } else if (!needsSeed) {
      Logger.log('  = Skipped (already exists): CONFIG');
    }
    if (needsSeed) {
      sh.clearContents();
      const headers = ['key','value','description'];
      sh.getRange(1, 1, 1, 3).setValues([headers]);
      const configRows = [
        ['campaign_start',    '2026-06-01',              'First eligible paid_at_jkt'],
        ['campaign_end',      '2026-06-30',              'Last eligible paid_at_jkt'],
        ['scratch_cutoff',    '2026-07-08 11:59:59',     'After this time (WIB), cards expire'],
        ['wave1_boundary',    '2026-06-16 23:59:59',     'scratched_at on or before = wave1'],
        ['draw_pool_ratio',   '0.03',                    'Target % of scratches → draw outcome'],
        ['last_sync_at',      '',                        'Updated by syncOrders()'],
        ['allowed_products',  'Saku,Android - New,Saku - Insurance Bundle,Saku - Printer Bundle', ''],
        ['blocked_tfcodes',   'SHOPEE',                  ''],
        ['saku_card_quota',   '1',                       ''],
        ['android_card_quota','2',                       ''],
        ['disbursement_drive_folder_id', '',             'Google Drive folder UUID for disbursement CSVs (REQUIRED before first run)'],
        ['disbursement_expiry_date',     '2026-12-31',   'expiryDate column value in the disbursement CSV'],
      ];
      sh.getRange(2, 1, configRows.length, 3).setValues(configRows);
      Logger.log('  ✓ CONFIG seeded');
    }
  }

  Logger.log('setupSupportingSheets: DONE ✓');
  return 'Setup complete';
}