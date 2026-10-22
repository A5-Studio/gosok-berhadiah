/**
 * 08_WebApp.gs — JSON API endpoints only.
 * Landing page lives in WordPress; this file exposes lookup and redeem
 * as plain HTTPS endpoints. Both go through doGet because Apps Script's
 * POST + CORS handling is unreliable from cross-origin browsers.
 *
 * Endpoints:
 *   GET  ?action=health
 *   GET  ?action=lookup&uid=08xxx
 *   GET  ?action=redeem&card_id=...&uid=...&idempotency_key=...
 *
 * Operator draw endpoints (used by draw_operator.html):
 *   GET  ?action=draw_preflight&wave_id=wave1
 *   GET  ?action=draw_run&wave_id=wave1
 *   GET  ?action=draw_winners&wave_id=wave1
 */

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action;

  // ── Public merchant endpoints ────────────────────────────────────────────────
  if (action === 'health') {
    return jsonResponse({ ok: true, ts: fmtTs(nowJkt()) });
  }
  if (action === 'lookup') {
    return jsonResponse(lookupByUid(params.uid));
  }
  if (action === 'redeem') {
    return jsonResponse(redeemCard({
      card_id:         params.card_id,
      uid:             params.uid,
      idempotency_key: params.idempotency_key,
      user_agent:      params.user_agent,
    }));
  }

  // ── Operator draw endpoints ──────────────────────────────────────────────────

  /**
   * draw_preflight — pool stats, no side effects.
   * ?action=draw_preflight&wave_id=wave1
   */
  if (action === 'draw_preflight') {
    const waveId = params.wave_id;
    if (!waveId) return jsonResponse({ ok: false, error: 'missing wave_id' });
    return jsonResponse(drawPreflightWithAttendance(waveId));
  }

  /**
   * draw_run — runs the attendance-gated draw. One-time; idempotent-protected.
   * ?action=draw_run&wave_id=wave1
   */
  if (action === 'draw_run') {
    const waveId = params.wave_id;
    if (!waveId) return jsonResponse({ ok: false, error: 'missing wave_id' });
    return jsonResponse(drawWaveWithAttendance(waveId));
  }

  /**
   * draw_winners — returns current winners after draw has run.
   * ?action=draw_winners&wave_id=wave1
   */
  if (action === 'draw_winners') {
    const waveId = params.wave_id;
    if (!waveId) return jsonResponse({ ok: false, error: 'missing wave_id' });
    return jsonResponse(getDrawWinners(waveId));
  }

  /**
   * draw_pick_one — picks one winner for a specific prize slot (one-by-one live draw).
   * Stores immediately; Konfirmasi on the frontend is a UI-only acknowledgment.
   * ?action=draw_pick_one&wave_id=wave1&grand_prize_id=gp_xxx
   */
  if (action === 'draw_pick_one') {
    const waveId       = params.wave_id;
    const grandPrizeId = params.grand_prize_id;
    if (!waveId || !grandPrizeId) {
      return jsonResponse({ ok: false, error: 'missing_params', required: ['wave_id', 'grand_prize_id'] });
    }
    return jsonResponse(drawPickOneWithAttendance(waveId, grandPrizeId));
  }

  /**
   * draw_progress — per-prize drawn/total counts + winners list for the operator panel.
   * ?action=draw_progress&wave_id=wave1
   */
  if (action === 'draw_progress') {
    const waveId = params.wave_id;
    if (!waveId) return jsonResponse({ ok: false, error: 'missing wave_id' });
    return jsonResponse(getDrawProgress(waveId));
  }

  return jsonResponse({
    ok: false,
    error: 'unknown_action',
    message: 'Use ?action=lookup&uid=... or ?action=health or ?action=redeem&card_id=...&uid=...',
  });
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'invalid_json' });
  }

  if (body.action === 'redeem') {
    return jsonResponse(redeemCard({
      card_id:         body.card_id,
      uid:             body.uid,
      idempotency_key: body.idempotency_key,
      user_agent:      body.user_agent,
      ip_address:      body.ip_address,
    }));
  }
  return jsonResponse({ ok: false, error: 'unknown_action' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
