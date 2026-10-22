# Technical Design — Gosok Berhadiah

> The system behind the campaign: architecture, data model, core flows, API, and the trade-offs behind each decision.
> For the campaign mechanics and prize economics, see [01-program-design.md](01-program-design.md).

---

## 1. Constraints that shaped the design

| Constraint | Consequence |
|---|---|
| No backend team, no infra budget | Serverless on tools the company already had: Google Sheets + Apps Script |
| Landing page lives on WordPress / Elementor | Frontend is a single self-contained HTML widget |
| Ops, finance and marketing must see and edit data | Database *is* a spreadsheet they can open |
| Upstream order export overwrites its own sheet | Campaign must never write into the raw order sheet |
| Real money and physical prizes | Strong guarantees on inventory, idempotency and auditability |
| Short runway before the June launch | Simple, testable modules; a built-in test mode |

## 2. Architecture

```mermaid
flowchart TB
    subgraph Upstream
        ORD[(Raw Order Data<br/>read-only export)]
    end

    subgraph GAS[Google Apps Script — Web App]
        SYNC[02_Sync<br/>syncOrders every 2h]
        API[08_WebApp<br/>doGet router]
        LK[03_Lookup]
        RD[04_Redeem<br/>LockService]
        PP[05_PrizePicker]
        DRAW[07 / 10 LiveDraw<br/>attendance-gated]
        DISB[09_DisbursementExport<br/>Thu 09:00 cron]
    end

    subgraph DB[Google Sheets — 14 tabs]
        ML[(MINT_LOG)]
        SC[(SCRATCH_CARDS)]
        RE[(REDEMPTIONS)]
        CP[(CASH_PRIZES +<br/>DAILY_QUOTAS)]
        DE[(DRAW_ENTRIES)]
        KD[(KOMISI_DISBURSEMENTS)]
        DP[(DISBURSEMENT_PROGRESS)]
        PD[(PHYSICAL_DISPATCH)]
    end

    subgraph Clients
        WP[WordPress widget<br/>merchant scratch UI]
        OP[Operator draw panel]
        FIN[Finance]
    end

    ORD --> SYNC --> ML & SC
    WP -- GET lookup / redeem --> API
    OP -- GET draw_* --> API
    API --> LK & RD & DRAW
    RD --> PP --> CP
    RD --> RE & KD & DE
    DRAW --> DE & PD
    DISB --> KD --> DP
    DISB -- CSV --> DRIVE[(Google Drive)] --> FIN
    FIN -- status = DONE --> DP
```

| Layer | Technology | Role |
|---|---|---|
| Database | Google Sheets (one workbook, 14 tabs) | Source of truth, human-editable |
| Backend | Google Apps Script, 11 `.gs` modules | JSON API (Web App) + time triggers |
| Merchant UI | Vanilla JS + `<canvas>` in an Elementor HTML widget | Lookup, scratch, celebration, share |
| Operator UI | Standalone HTML panel | Live draw, one prize at a time |
| Payout handoff | CSV in Google Drive | Finance processes in their own tool |

### Module map

| File | Responsibility |
|---|---|
| `00_Config.gs` | Sheet names, enums, schedules, date/ID helpers |
| `01_SheetIO.gs` | Header-driven row read / append / update / upsert |
| `02_Sync.gs` | Eligibility, card minting, voiding, sheet bootstrap + seeds |
| `03_Lookup.gs` | Merchant state + card enrichment |
| `04_Redeem.gs` | Scratch transaction (locked, idempotent) |
| `05_PrizePicker.gs` | Weighted pick + daily quota smoothing + audit |
| `06_Disbursement.gs` | Legacy direct-API payout (kept as reference, not triggered) |
| `07_LivestreamDraw.gs` | Whole-wave draw |
| `08_WebApp.gs` | `doGet` / `doPost` router |
| `09_DisbursementExport.gs` | Weekly CSV export + finance DONE backfill |
| `10_LiveDrawAttendance.gs` | Attendance-gated, one-by-one live draw |

## 3. Data model

```mermaid
erDiagram
    RAW_ORDER_DATA ||--|| MINT_LOG : "sync state"
    RAW_ORDER_DATA ||--|{ SCRATCH_CARDS : "1 (Saku) or 2 (Android)"
    SCRATCH_CARDS ||--o| REDEMPTIONS : "when scratched"
    REDEMPTIONS ||--o| KOMISI_DISBURSEMENTS : "if cash"
    REDEMPTIONS ||--o| DRAW_ENTRIES : "if draw"
    CASH_PRIZES ||--o{ REDEMPTIONS : "tier"
    CASH_PRIZES ||--|{ CASH_PRIZE_DAILY_QUOTAS : "per day"
    DRAW_WAVES ||--o{ DRAW_ENTRIES : "wave"
    GRAND_PRIZES ||--o{ DRAW_ENTRIES : "if won"
    DRAW_ENTRIES ||--o| PHYSICAL_DISPATCH : "if won"
    DISBURSEMENT_PROGRESS ||--o{ KOMISI_DISBURSEMENTS : "batch"

    RAW_ORDER_DATA {
        string order_id PK
        string user_id "phone"
        string product_name
        string payment_status
        datetime paid_at_jkt
        datetime waiting_for_ops_at_ts
    }
    MINT_LOG {
        string order_id PK
        bool eligible
        bool cards_minted
        datetime last_sync
    }
    SCRATCH_CARDS {
        string card_id PK "KARTUGOSOK-XXXXXXXX"
        string order_id FK
        string user_id
        int sequence_no
        enum status "bound|scratched|voided|expired"
    }
    REDEMPTIONS {
        string redemption_id PK
        string card_id FK
        enum outcome_type "cash|draw"
        string cash_prize_id FK
        string idempotency_key UK
    }
    CASH_PRIZES {
        string cash_prize_id PK
        int value_idr
        int total_qty
        int remaining_qty
        float weight_multiplier
    }
    CASH_PRIZE_DAILY_QUOTAS {
        date date
        string cash_prize_id FK
        int daily_qty
        int given_out_today
    }
    DRAW_ENTRIES {
        string entry_id PK
        string redemption_id FK
        string wave_id FK
        string draw_code UK "GOSOK-XXXXX"
        string grand_prize_id FK
        enum result "pending|won|not_drawn"
    }
    KOMISI_DISBURSEMENTS {
        string disbursement_id PK
        string redemption_id FK
        int value_idr
        string batch "e.g. 12 Juni 2026"
        enum status "queued|sent|failed"
    }
    DISBURSEMENT_PROGRESS {
        string batch PK
        int total_users
        int total_amount
        enum status "DATA_COMPLETE|REQUESTED|DONE"
        string file_url
    }
```

Supporting tabs: `CONFIG` (key/value settings), `GRAND_PRIZES`, `DRAW_WAVES`, `PHYSICAL_DISPATCH`, `CASH_PRIZE_AUDIT`, `DUMMY_CARDS` (test harness), `FORM_LIVE` (livestream attendance form responses).

**Invariant:** columns A–Z of `Raw Order Data` are never written. All campaign state is keyed by `order_id` in separate tabs, so the upstream export can append or replace rows freely.

## 4. Core flows

### 4.1 Eligibility sync and card minting (every 2 hours)

```mermaid
flowchart TD
    A[For each order in Raw Order Data] --> B[Evaluate isEligibleNow]
    B --> C{MINT_LOG row exists?}
    C -- no --> D[Append MINT_LOG row]
    C -- yes --> E[Update eligible flag if changed]
    D & E --> F{eligible AND not minted?}
    F -- yes --> G[Mint 1 or 2 SCRATCH_CARDS<br/>cards_minted = true]
    F -- no --> H{not eligible AND minted<br/>AND none scratched?}
    H -- yes --> I[Void bound cards<br/>cards_minted = false]
    H -- no --> J[No-op]
```

Safe to run any number of times: minting only happens when `cards_minted = false`, and voiding never touches a scratched card.

### 4.2 Scratch (redeem)

```mermaid
sequenceDiagram
    autonumber
    participant M as Merchant widget
    participant API as doGet router
    participant R as redeemCard
    participant P as pickPrize
    participant S as Sheets

    M->>M: Generate idempotency_key
    M->>API: GET ?action=redeem&card_id&uid&idempotency_key
    API->>R: redeemCard(payload)
    R->>R: LockService.getScriptLock() (15s)
    R->>S: Past cutoff? Key seen before?
    alt key already used
        R-->>M: Return prior result (no re-pick)
    end
    R->>S: Load card, check owner = uid, order eligible
    R->>P: pickPrize(now)
    P->>S: Read CASH_PRIZES + today's quotas
    P-->>R: {cash, tier} or {draw}
    R->>S: Append REDEMPTIONS, card → scratched
    alt cash
        R->>S: remaining_qty −1, given_out_today +1
        R->>S: Append KOMISI_DISBURSEMENTS (batch by date)
    else draw
        R->>S: Append DRAW_ENTRIES (GOSOK-XXXXX, wave by date)
    end
    R->>R: Release lock
    R-->>M: JSON result
    M->>M: Paint prize under canvas, user scratches to reveal
```

The prize is decided **before** the merchant starts scratching. The canvas gesture is pure UX; the server result is already fixed and persisted, so closing the tab mid-scratch loses nothing.

### 4.3 Prize picker

```
eligibleTiers = tiers where remaining_qty > 0 AND today's quota not exhausted
if eligibleTiers is empty           → DRAW   (never deny a scratch)
if random() < draw_pool_ratio (3%)  → DRAW
else pick tier with weight = remaining_qty × weight_multiplier
```

- **Weight by remaining inventory.** As a tier depletes, its odds drop on their own. The campaign ends close to the planned mix without manual tuning.
- **Daily quotas.** `daily_qty = ceil(total_qty / days)`, seeded per (date × tier). Stops a high-traffic day from draining the budget.
- **Rebalancing.** `regenerateDailyQuotas()` spreads remaining inventory over remaining days after a budget change. Every `CASH_PRIZES` edit is written to `CASH_PRIZE_AUDIT`.

Try it: the demo's **Prize simulator** tab runs this exact function with and without smoothing.

### 4.4 Live draw (attendance-gated)

```mermaid
sequenceDiagram
    participant O as Operator panel
    participant API as doGet router
    participant D as LiveDrawAttendance
    participant S as Sheets

    O->>API: draw_preflight&wave_id
    API->>D: Pool size, attendees, prize slots (read-only)
    D-->>O: Stats
    loop per prize slot, on air
        O->>API: draw_pick_one&wave_id&grand_prize_id
        D->>D: Lock, filter pending entries ∩ FORM_LIVE attendees
        D->>D: Uniform random pick
        D->>S: Entry → won, append PHYSICAL_DISPATCH
        D-->>O: Winner (masked phone + draw code)
    end
    O->>API: draw_progress&wave_id
```

Wave allocation: each grand prize tier is split across waves; odd quantities give the extra unit to wave 2 (Tablet 5 → 2 + 3).

### 4.5 Weekly disbursement

```mermaid
sequenceDiagram
    participant T as Thu 09:00 trigger
    participant X as DisbursementExport
    participant S as Sheets
    participant G as Drive
    participant F as Finance

    T->>X: generateThursdayDisbursementCSV()
    X->>X: Is tomorrow a batch Friday? else exit
    X->>S: KOMISI_DISBURSEMENTS where batch = label AND status = queued
    X->>X: Normalize phone, SUM(value_idr) per user
    X->>S: DISBURSEMENT_PROGRESS → DATA_COMPLETE
    X->>G: Trash previous file, upload CSV
    X->>S: DISBURSEMENT_PROGRESS → REQUESTED (+ file_url)
    F->>G: Download CSV, credit balances
    F->>S: Set status = DONE
    S->>X: onEdit trigger
    X->>S: Batch rows → sent, processed_at = now
```

CSV format: `userId,amount,expiryDate,description`, one row per merchant per batch.

## 5. API

Single Web App deployment: `GET https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec?action=...`

| Action | Params | Side effects | Used by |
|---|---|---|---|
| `health` | — | none | monitoring |
| `lookup` | `uid` | none | merchant widget |
| `redeem` | `card_id`, `uid`, `idempotency_key` | writes, locked | merchant widget |
| `draw_preflight` | `wave_id` | none | operator |
| `draw_pick_one` | `wave_id`, `grand_prize_id` | writes, locked | operator |
| `draw_progress` / `draw_winners` | `wave_id` | none | operator |
| `draw_run` | `wave_id` | writes, one-time | operator (bulk fallback) |

### Lookup states

| `state` | Meaning | UI |
|---|---|---|
| `no_order` | Phone has no orders | "Kartu hadiah belum ada" |
| `order_pending` | Orders exist, none eligible yet | "Kartu lagi diproses" |
| `cards_ready` | At least one unscratched card | Card grid |
| `all_scratched` | Everything scratched | Prize history + payout / draw notes |

### Redeem response (cash)

```json
{
  "ok": true,
  "redemption_id": "red_…",
  "card_id": "KARTUGOSOK-A3FX9B2K",
  "outcome_type": "cash",
  "cash_prize": { "value_idr": 10000, "label": "Komisi Agen Rp 10.000" },
  "disbursement": { "status": "queued", "batch": "12 Juni 2026" }
}
```

### Errors

`{ "ok": false, "error": "<code>", "message": "…" }` — codes: `invalid_uid`, `missing_params`, `system_busy`, `campaign_ended`, `card_not_found`, `card_voided`, `card_expired`, `uid_card_mismatch`, `order_not_eligible`, `unknown_action`.

## 6. Key design decisions

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| 1 | **Google Sheets as the database** | Firestore, Postgres | Zero infra, ops and finance can read and fix data directly, built-in history. Volume (~14K cards) is well within limits |
| 2 | **GET-only API** | POST for writes | Apps Script answers cross-origin POST with a 302 that browsers turn into a GET and drop the body. GET + idempotency key avoids it |
| 3 | **Separate `MINT_LOG` tab** | Extra columns on the raw sheet | First version wrote flags into columns AA–AC of the raw sheet. Moving state out makes the raw sheet strictly read-only, so upstream refreshes can never clash with campaign state |
| 4 | **Global script lock on every write** | Optimistic writes | Picker is read-then-write on inventory. A lock is the only atomicity Apps Script offers. Cost: brief "system busy" at extreme peaks |
| 5 | **Client idempotency key** | Server-side dedupe by card only | Covers network retries and double taps; a replay returns the same prize instead of an error |
| 6 | **Prize decided before the scratch animation** | Decide on reveal | Server stays the only source of truth; the canvas cannot be tampered with to change the prize |
| 7 | **Inventory-weighted + daily-capped picker** | Fixed probabilities | Fixed odds can overshoot a tier's budget. Weighting by what is left converges to the plan; daily caps stop early burn |
| 8 | **CSV handoff to finance** | Direct balance API (`06_Disbursement.gs`) | Keeps a human checkpoint before money moves and fits finance's existing process. The API path is kept in the repo but not triggered |
| 9 | **Attendance-gated, one-by-one draw** | Bulk draw script | Drives livestream viewership, guarantees winners are reachable, and makes the stream watchable |
| 10 | **Unambiguous code alphabet** | Full alphanumeric | Codes are read aloud on stream and typed from screenshots; no 0/O or 1/I/L confusion |
| 11 | **Dummy mode in production** | Separate staging stack | 8 reserved phone numbers with fixed outcomes go through the real deployed API, auto-reset, and never touch real inventory |

## 7. Reliability and limits

| Area | Behavior |
|---|---|
| Concurrency | Lock serializes writes; above ~50 concurrent redeems, some requests get `system_busy` and the UI asks the merchant to retry |
| Sync vs redeem race | Sync only appends cards or voids `bound` ones, so it cannot overwrite a fresh scratch |
| Time zones | All dates are `Asia/Jakarta`, compared as `yyyy-MM-dd` strings; cutoffs built with explicit `+07:00` |
| Config caching | `CONFIG` is read once per execution |
| Schema strictness | Writers follow row-1 headers; adding a column requires adding its header |
| Deployments | Always "new version" on the same deployment, so the widget's URL never changes |

## 8. Testing

- **Dummy mode:** UIDs `8000000001`–`8000000008` cover every outcome (each cash tier, draw entry, 2-card Android) on the live stack.
- **Dry-run helpers:** `previewDisbursementCSVForBatch`, `drawPreflightWithAttendance` read without writing.
- **Re-runnable jobs:** sync, CSV export and quota rebalance are all idempotent.
- **Interactive demo:** [`demo/`](../demo/) ports the backend to the browser so the full flow can be tried without Google services.

## 9. What I would change at larger scale

| Today | At 10× volume |
|---|---|
| Sheets + global lock | Postgres (or Firestore) with row-level transactions on inventory |
| Apps Script Web App | Cloud Run / Functions behind a proper CORS-enabled API |
| Phone number as login | OTP via WhatsApp to stop anyone checking someone else's cards |
| CSV payout handoff | Direct balance API with approval step and reconciliation report |
| Manual address capture for winners | Winner form linked to `PHYSICAL_DISPATCH` |
| Log inspection | Alerts on failed syncs, quota exhaustion and payout lag |
