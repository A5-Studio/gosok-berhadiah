/**
 * 03_Lookup.gs — GET ?action=lookup&uid=...
 *
 * Dummy mode: if the UID exists in DUMMY_CARDS, a fully synthetic response is
 * returned without touching ORDERS, SCRATCH_CARDS, or any other production tab.
 * The card_id stored in DUMMY_CARDS is used directly — no real card is minted.
 */

function lookupByUid(uid) {
  if (!uid || typeof uid !== 'string') {
    return { ok: false, error: 'invalid_uid', message: 'UID kosong atau format salah' };
  }
  uid = String(uid).replace(/\D/g, '');
  const now = nowJkt();

  // ── Dummy mode intercept ──────────────────────────────────────────────────
  const dummyResp = lookupDummy(uid, now);
  if (dummyResp) return dummyResp;

  // ── Production path ───────────────────────────────────────────────────────
  const allOrders    = readAllRows(SHEET.ORDERS);
  const ordersForUid = allOrders.filter(o => String(o.user_id) === uid);

  if (ordersForUid.length === 0) {
    return {
      ok: true, uid: uid, lookup_at: fmtTs(now),
      state: 'no_order',
      message: 'Nomor ini belum ada pesanan EDC BukuAgen di Juni 2026',
      orders: [], summary: emptySummary(),
    };
  }

  // Read eligibility from MINT_LOG (not Raw Order Data columns)
  const mintLog    = readAllRows(SHEET.MINT_LOG);
  const mintLogMap = {};
  mintLog.forEach(r => { mintLogMap[r.order_id] = r; });

  const isEligible = o => {
    const log = mintLogMap[o.order_id];
    return log && (log.eligible === true || log.eligible === 'TRUE');
  };

  const eligibleOrders = ordersForUid.filter(isEligible);
  const pendingOrders  = ordersForUid.filter(o => !isEligible(o));

  if (eligibleOrders.length === 0 && pendingOrders.length > 0) {
    return {
      ok: true, uid: uid,
      merchant_name: pendingOrders[0].name,
      lookup_at: fmtTs(now),
      state: 'order_pending',
      message: 'Pesanan kamu lagi diproses, kartu gosok bakal muncul setelah konfirmasi ops',
      orders: pendingOrders.map(o => orderToPublic(o, [], mintLogMap)),
      summary: emptySummary(),
    };
  }

  const allCards         = readAllRows(SHEET.SCRATCH_CARDS);
  const allRedemptions   = readAllRows(SHEET.REDEMPTIONS);
  const allDisbursements = readAllRows(SHEET.KOMISI_DISBURSEMENTS);
  const allDrawEntries   = readAllRows(SHEET.DRAW_ENTRIES);
  const allWaves         = readAllRows(SHEET.DRAW_WAVES);
  const allCashPrizes    = readAllRows(SHEET.CASH_PRIZES);
  const allGrandPrizes   = readAllRows(SHEET.GRAND_PRIZES);

  const ordersForResponse = eligibleOrders.map(o => {
    const cards = allCards.filter(c => c.order_id === o.order_id);
    const enrichedCards = cards.map(c => enrichCard(c, allRedemptions, allDisbursements,
      allDrawEntries, allWaves, allCashPrizes, allGrandPrizes));
    return orderToPublic(o, enrichedCards, mintLogMap);
  });

  const allEnrichedCards = ordersForResponse.reduce((acc, o) => acc.concat(o.cards), []);

  // Exclude voided and expired cards — they should be invisible to the merchant
  const activeCards = allEnrichedCards.filter(c =>
    c.status !== STATUS.CARD_VOIDED && c.status !== STATUS.CARD_EXPIRED
  );

  // If all cards are voided/expired, treat as no eligible order
  if (activeCards.length === 0) {
    return {
      ok: true, uid: uid,
      lookup_at: fmtTs(now),
      state: 'no_order',
      message: 'Nomor ini belum ada pesanan EDC BukuAgen di Juni 2026',
      orders: [], summary: emptySummary(),
    };
  }

  // Rebuild orders with only active cards
  const activeOrdersForResponse = ordersForResponse.map(o => ({
    ...o,
    cards:      o.cards.filter(c => c.status !== STATUS.CARD_VOIDED && c.status !== STATUS.CARD_EXPIRED),
    card_quota: o.cards.filter(c => c.status !== STATUS.CARD_VOIDED && c.status !== STATUS.CARD_EXPIRED).length,
  })).filter(o => o.cards.length > 0);

  const summary    = buildSummary(activeCards);
  const allScratched = activeCards.every(c => c.status !== STATUS.CARD_BOUND);
  const state = allScratched ? 'all_scratched' : 'cards_ready';

  return {
    ok: true, uid: uid,
    merchant_name: eligibleOrders[0].name,
    lookup_at: fmtTs(now),
    state: state,
    orders: activeOrdersForResponse.concat(pendingOrders.map(o => orderToPublic(o, [], mintLogMap))),
    summary: summary,
  };
}

// ── Dummy lookup ──────────────────────────────────────────────────────────────

/**
 * Returns a fully synthetic lookup response for dummy UIDs.
 * Reads card state from REDEMPTIONS (keyed on card_id from DUMMY_CARDS)
 * so the result reflects whether the dummy card has been scratched or not.
 * Returns null if uid is not in DUMMY_CARDS.
 */
function lookupDummy(uid, now) {
  const rows = readAllRows(SHEET.DUMMY_CARDS);
  const slots = rows.filter(r => String(r.uid) === uid);
  if (!slots.length) return null;

  const merchantName = String(slots[0].name || 'Dummy Merchant');

  // Build one synthetic card per slot — reads only from DUMMY_CARDS
  const cards = slots.map((slot, idx) => {
    const cardId      = String(slot.card_id || '');
    const isScratched = slot.scratched_at && String(slot.scratched_at).trim() !== '';
    const prizeTier   = String(slot.prize_tier || '');
    const isDraw      = prizeTier === 'draw';

    const base = {
      card_id:      cardId,
      sequence_no:  idx + 1,
      status:       isScratched ? STATUS.CARD_SCRATCHED : STATUS.CARD_BOUND,
      bound_at:     fmtTs(now),
      scratched_at: isScratched ? String(slot.scratched_at) : null,
      outcome_type: null,
      cash_prize:   null,
      disbursement: null,
      draw_entry:   null,
    };

    if (!isScratched) return base;

    if (isDraw) {
      base.outcome_type = OUTCOME.DRAW;
      // Wave derived from scratched_at timestamp stored in DUMMY_CARDS
      const scratchedDate = new Date(String(slot.scratched_at));
      const waveId = waveForScratch(isNaN(scratchedDate) ? now : scratchedDate);
      // Get wave info from DRAW_WAVES (read-only, no writes)
      const waves = readAllRows(SHEET.DRAW_WAVES);
      const wave  = waves.find(w => w.wave_id === waveId);
      base.draw_entry = {
        entry_id:        'DUMMY-ENTRY-' + cardId,
        wave_id:         waveId,
        draw_code:       String(slot.draw_code || ''),
        wave_label:      wave ? wave.label : waveId,
        livestream_date: wave ? fmtDate(wave.livestream_date) : null,
        livestream_url:  wave ? wave.livestream_url : LIVESTREAM_URL,
        result:          STATUS.DRAW_PENDING,
        grand_prize:     null,
      };
    } else {
      // Cash — derive value from prize_tier name (e.g. cash_50k → 50000)
      base.outcome_type = OUTCOME.CASH;
      const TIER_VALUES = {
        cash_5k: 5000, cash_10k: 10000, cash_20k: 20000,
        cash_50k: 50000, cash_100k: 100000, cash_200k: 200000,
      };
      const TIER_LABELS = {
        cash_5k: 'Komisi Agen Rp 5.000',   cash_10k: 'Komisi Agen Rp 10.000',
        cash_20k: 'Komisi Agen Rp 20.000', cash_50k: 'Komisi Agen Rp 50.000',
        cash_100k: 'Komisi Agen Rp 100.000', cash_200k: 'Komisi Agen Rp 200.000',
      };
      const valueIdr = TIER_VALUES[prizeTier] || 0;
      base.cash_prize = {
        cash_prize_id: prizeTier,
        tier:          prizeTier,
        value_idr:     valueIdr,
        label:         TIER_LABELS[prizeTier] || prizeTier,
      };
      base.disbursement = {
        status:       STATUS.DISB_QUEUED,
        batch:        slot.batch || batchLabelForScratch(now),
        queued_at:    isScratched ? String(slot.scratched_at) : null,
        processed_at: null,
      };
    }
    return base;
  });

  const productType = String(slots[0].product_type || 'saku');
  const syntheticOrder = {
    order_id:     'DUMMY-' + uid,
    product_name: productType === 'android' ? 'Android - New' : 'Saku',
    paid_at_jkt:  fmtDate(now),
    price_idr:    productType === 'android' ? 1899000 : 449000,
    channel:      'dummy',
    order_status: 'Completed',
    eligible:     true,
    card_quota:   cards.length,
    cards:        cards,
  };

  const allScratched = cards.length > 0 && cards.every(c => c.status !== STATUS.CARD_BOUND);
  const state = allScratched ? 'all_scratched' : 'cards_ready';

  return {
    ok: true, uid: uid,
    merchant_name: merchantName,
    lookup_at: fmtTs(now),
    state: state,
    is_dummy: true,
    orders: [syntheticOrder],
    summary: buildSummary(cards),
  };
}


function emptySummary() {
  return {
    total_orders: 0, total_cards: 0, cards_scratched: 0, cards_unscratched: 0,
    total_komisi_won_idr: 0, komisi_disbursed_idr: 0, komisi_pending_idr: 0,
    draw_tickets_active: 0,
  };
}

function buildSummary(cards) {
  const s = emptySummary();
  s.total_cards = cards.length;
  cards.forEach(c => {
    if (c.status === STATUS.CARD_SCRATCHED) s.cards_scratched++;
    if (c.status === STATUS.CARD_BOUND)     s.cards_unscratched++;
    if (c.cash_prize) {
      s.total_komisi_won_idr += c.cash_prize.value_idr;
      if (c.disbursement && c.disbursement.status === STATUS.DISB_SENT)
        s.komisi_disbursed_idr += c.cash_prize.value_idr;
      else if (c.disbursement && c.disbursement.status === STATUS.DISB_QUEUED)
        s.komisi_pending_idr += c.cash_prize.value_idr;
    }
    if (c.draw_entry && c.draw_entry.result === STATUS.DRAW_PENDING)
      s.draw_tickets_active++;
  });
  return s;
}

function orderToPublic(o, cards, mintLogMap) {
  const log = mintLogMap ? mintLogMap[o.order_id] : null;
  return {
    order_id:     o.order_id,
    product_name: o.product_name,
    paid_at_jkt:  fmtDate(o.paid_at_jkt),
    price_idr:    o.price,
    channel:      o.channel,
    order_status: o.status,
    eligible:     !!(log && (log.eligible === true || log.eligible === 'TRUE')),
    card_quota:   cards.length,
    cards:        cards,
  };
}

function enrichCard(card, redemptions, disbursements, drawEntries, waves, cashPrizes, grandPrizes) {
  const base = {
    card_id:      card.card_id,
    sequence_no:  Number(card.sequence_no),
    status:       card.status,
    bound_at:     card.bound_at     ? fmtTs(card.bound_at)     : null,
    scratched_at: card.scratched_at ? fmtTs(card.scratched_at) : null,
    outcome_type: null,
    cash_prize:   null,
    disbursement: null,
    draw_entry:   null,
  };
  if (card.status !== STATUS.CARD_SCRATCHED) return base;
  const red = redemptions.find(r => r.card_id === card.card_id);
  if (!red) return base;
  base.outcome_type = red.outcome_type;
  if (red.outcome_type === OUTCOME.CASH) {
    const cp = cashPrizes.find(p => p.cash_prize_id === red.cash_prize_id);
    base.cash_prize = cp ? {
      cash_prize_id: cp.cash_prize_id,
      tier:          cp.tier,
      value_idr:     Number(cp.value_idr),
      label:         cp.label_id,
    } : null;
    const d = disbursements.find(x => x.redemption_id === red.redemption_id);
    base.disbursement = d ? {
      status:       d.status,
      batch:        d.batch,
      queued_at:    d.queued_at    ? fmtTs(d.queued_at)    : null,
      processed_at: d.processed_at ? fmtTs(d.processed_at) : null,
    } : null;
  } else if (red.outcome_type === OUTCOME.DRAW) {
    const entry = drawEntries.find(e => e.redemption_id === red.redemption_id);
    if (entry) {
      const wave = waves.find(w => w.wave_id === entry.wave_id);
      const gp   = entry.grand_prize_id
        ? grandPrizes.find(g => g.grand_prize_id === entry.grand_prize_id)
        : null;
      base.draw_entry = {
        entry_id:        entry.entry_id,
        wave_id:         entry.wave_id,
        draw_code:       entry.draw_code || null,
        wave_label:      wave ? wave.label : entry.wave_id,
        livestream_date: wave ? fmtDate(wave.livestream_date) : null,
        livestream_url:  wave ? wave.livestream_url : null,
        result:          entry.result,
        grand_prize: gp ? {
          tier: gp.tier, label: gp.label, value_idr: Number(gp.value_idr),
        } : null,
      };
    }
  }
  return base;
}