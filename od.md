# Outside Docker — 完整構建手冊 / Complete Build Manual

> **命理：破軍殺破狼 · 壬水 59.86% · 用神戊土（土 ✅ 第一用神）**
> **OD 是土 — 你的第一用神產品。做 OD = 順命而行。**
> **2026.07：OS（Ω Sanctuary）功能已完整合併入 OD。雙軌制：Track H（人類文檔，/event）+ Track M（機器日誌，/record）。**

---

## Table of Contents / 目錄

1. [Product Overview / 產品概述](#1-product-overview--產品概述)
2. [Architecture / 架構](#2-architecture--架構)
3. [D1 Schema / 數據庫設計](#3-d1-schema--數據庫設計)
4. [Full API Spec / 完整 API 規範](#4-full-api-spec--完整-api-規範)
5. [Pricing / 定價](#5-pricing--定價)
6. [User Journey / 用戶旅程](#6-user-journey--用戶旅程)
7. [Polygon Anchoring + Cron / Polygon 錨定設計](#7-polygon-anchoring--cron--polygon-錨定設計)
8. [Public Verify Page / 公開驗證頁面](#8-public-verify-page--公開驗證頁面)
9. [Chain-of-Custody PDF Report / 監管鏈 PDF 報告](#9-chain-of-custody-pdf-report--監管鏈-pdf-報告)
10. [Build Order / 構建順序](#10-build-order--構建順序)
11. [Security Considerations / 安全考量](#11-security-considerations--安全考量)
12. [Legal Compliance Notes / 法律合規筆記](#12-legal-compliance-notes--法律合規筆記)
13. [SWOT Analysis / 優劣勢分析](#13-swot-analysis--優劣勢分析)
14. [Timeline / 時間線](#14-timeline--時間線)

---

## 1. Product Overview / 產品概述

### English

**Outside Docker (OD)** is a time-series record integrity preservation and verification system for human documents and machine logs. It is **not** a single-file timestamping service (like Bernstein.io). OD proves **event chain integrity** — that event A happened before B, and B before C, with no insertions, deletions, or reorderings.

**Important boundary:** OD preserves records and proves they haven't been tampered with after capture. OD does NOT verify the truthfulness of the original content — that depends on the submitting party's process and the original document's authenticity.

**Three-Layer Proof Chain:**

| Layer | Mechanism | Prevents |
|-------|-----------|----------|
| 1. SHA-256 | hash(payload) == stored | Content tampering |
| 2. Hash Chain | proof_N = SHA-256(payload_N + proof_(N-1)) | Deletion, insertion, reordering |
| 3. Merkle + Polygon Anchor | Daily merkle root committed on-chain | Platform operator tampering |

**Key Differentiator:** Layer 2 (hash chain). Single-file timestamps only prove individual existence. Hash chain proves **sequence integrity** — A happened, then B, then C, and nothing was inserted or removed. If you modify Event 1, Event 2's proof breaks, Event 3's proof breaks — the entire chain proves tampering.

**Target Buyers:** Legal evidence preservation, insurance claims, internal investigations, audit firms, robotics/automation companies (machine behavior logging for compliance).

**Tech Stack:** TypeScript + Hono + Cloudflare Workers + D1. **Zero AI dependency** — core is cryptography. HTTP is the universal SDK. No Python, no Node.js SDK — curl examples in docs.

**One Sentence:**
> OD is the event-chain integrity layer for human and machine records. Prove an event happened at that time. Prove the record was never changed after capture. Hash chain proves sequence. Merkle proves existence. Blockchain proves platform can't tamper after anchoring.

**Important boundary:** OD's three-layer proof proves the record was captured at a given time and has not been modified since. It does NOT prove the record's content is inherently truthful — capture integrity and source authenticity depend on the submitting party's process.

### 中文

**Outside Docker (OD)** 是一個用於人類文檔與機器日誌的時間序列記錄完整性保存與驗證系統。它**不是**單一文件時間戳服務（如 Bernstein.io）。OD 證明的是**事件鏈完整性**——事件 A 發生在 B 之前、B 在 C 之前，無插入、刪除或重排。

**重要邊界：** OD 保存記錄並證明捕獲後未被篡改。OD 不驗證原始內容的真實性——這取決於提交方的流程和原始文檔的可靠性。

**三層證明鏈：**

| 層級 | 機制 | 防止 |
|------|------|------|
| 1. SHA-256 | hash(內容) == 已存儲 | 內容篡改 |
| 2. 哈希鏈 | proof_N = SHA-256(payload_N + proof_(N-1)) | 刪除、插入、重排 |
| 3. Merkle + Polygon 錨定 | 每日 merkle root 上鏈 | 平台運營商篡改 |

**關鍵差異化：** 第 2 層（哈希鏈）。單一文件戳記只證明個別存在。哈希鏈證明**序列完整性**——A 發生，然後 B，然後 C，無任何插入或刪除。修改事件 1，事件 2 的證明中斷，事件 3 的證明中斷——整條鏈證明篡改。

**目標買家：** 律師事務所、保險公司、物流企業、醫療機構、審計公司、電商平台、機器人/自動化公司（機器行為日誌合規）。

**技術棧：** TypeScript + Hono + Cloudflare Workers + D1。**零 AI 依賴**——核心是密碼學。HTTP 是通用 SDK。無 Python，無 Node.js SDK——文檔中使用 curl 示例。

**一句話：**
> OD 是人類文檔與機器日誌的事件鏈完整性層。證明事件在該時間發生。證明捕獲後從未被更改。哈希鏈證明序列。Merkle 證明存在。區塊鏈證明平台在錨定後也無法篡改。

---

## 2. Architecture / 架構

### English

```
┌──────────────────────────────────────────────────────┐
│                DATA SOURCES (Two Tracks)               │
│                                                       │
│  Track H (Human)              Track M (Machine)        │
│  ┌──────────────────┐        ┌──────────────────┐    │
│  │ Law firms        │        │ Robot fleets     │    │
│  │ Insurance        │        │ Automation lines │    │
│  │ Logistics        │        │ Drones / AVs     │    │
│  │ Healthcare       │        │ IoT sensor nets  │    │
│  │ Audit firms      │        │ ROS / MQTT logs  │    │
│  │ E-commerce       │        │ PLC / SCADA      │    │
│  └────────┬─────────┘        └────────┬─────────┘    │
│           │ POST /event              │ POST /record   │
│           │ (case-based)             │ (source-action) │
└───────────┼──────────────────────────┼────────────────┘
            │                          │
┌───────────▼──────────────────────────▼────────────────┐
│                  Dashboard (React)                     │
│    API Keys | Cases | Reports | Billing               │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              API Layer (Hono on Workers)              │
│                                                      │
│  POST /event         → Human doc event (case-based)  │
│  POST /record        → Machine log entry (source-act)│
│  GET /case/:ref/chain → All events + integrity       │
│  GET /verify/:proof   → Verify (auth required)       │
│  GET /verify/public/:proof → Public verify (NO auth) │
│  GET /case/:ref/export → Chain-of-custody PDF        │
│  POST /signup         → Register (free, no payment)  │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              Core Engine (TypeScript)                 │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ event.ts │  │merkle.ts │  │anchor.ts │          │
│  │ Hash Chain│  │Merkle    │  │Polygon   │          │
│  │ Linking  │  │Tree+Proof│  │Tx+Anchor │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │verify.ts │  │report.ts │  │ auth.ts  │          │
│  │Verify+   │  │PDF Gen   │  │API Key   │          │
│  │Public    │  │Chain-of- │  │Mgmt      │          │
│  │Verify    │  │Custody   │  │          │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  ┌──────────┐  ┌──────────┐                         │
│  │billing.ts│  │  db.ts   │                         │
│  │Stripe    │  │ D1 Schema│                         │
│  │Webhooks  │  │ Queries  │                         │
│  └──────────┘  └──────────┘                         │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              Data Layer (Cloudflare D1)               │
│                                                      │
│  api_keys  │  events  │  cases  │  merkle_anchors   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│           Blockchain Layer (Polygon/Ethereum)         │
│                                                      │
│  Daily cron → buildMerkleTree() → merkle_root        │
│  → Polygon tx (Solo: weekly, Firm: daily, Ent: daily)│
│  → Contract stores root → Anyone can verify          │
└─────────────────────────────────────────────────────┘
```

**Three-Layer Proof Visualization:**

```
    ┌── Layer 3: Polygon Anchor ──────────────────┐
    │  merkle_root committed on-chain              │
    │  tx_hash: 0xabc... block: 12345678           │
    │  Prevents: platform operator tampering       │
    └────────────────────┬─────────────────────────┘
                         │
    ┌── Layer 2: Merkle Tree ─────────────────────┐
    │  All case roots → merkle_root               │
    │  generateMerkleProof() → proof per case     │
    └────────────────────┬─────────────────────────┘
                         │
    ┌── Layer 1: Hash Chain ──────────────────────┐
    │  Event 1 proof = SHA-256(payload_1)          │
    │  Event 2 proof = SHA-256(payload_2 + p1)     │
    │  Event 3 proof = SHA-256(payload_3 + p2)     │
    │  Modify Event 1 → all subsequent proofs break│
    └──────────────────────────────────────────────┘
```

### 中文

```

┌──────────────────────────────────────────────────────┐
│                資料來源（雙軌制）                        │
│                                                       │
│  軌道 H（人類文檔）          軌道 M（機器日誌）          │
│  ┌──────────────────┐        ┌──────────────────┐    │
│  │ 律師事務所       │        │ 機器人集群       │    │
│  │ 保險公司         │        │ 自動化產線       │    │
│  │ 物流公司         │        │ 無人機/自駕      │    │
│  │ 醫療機構         │        │ IoT 傳感器網絡   │    │
│  │ 審計公司         │        │ ROS / MQTT 日誌  │    │
│  │ 電商平台         │        │ PLC / SCADA      │    │
│  └────────┬─────────┘        └────────┬─────────┘    │
│           │ POST /event              │ POST /record   │
│           │（案件制）                  │（來源-行為制）  │
└───────────┼──────────────────────────┼────────────────┘
            │                          │
┌───────────▼──────────────────────────▼────────────────┐
│                    儀表板 (React)                       │
│    API 密鑰 | 案件 | 報告 | 帳單                      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│               API 層 (Workers 上的 Hono)              │
│                                                      │
│  POST /event         → 人類文檔事件（案件制）        │
│  POST /record        → 機器日誌記錄（來源-行為制）   │
│  GET /case/:ref/chain → 所有事件 + 完整性狀態         │
│  GET /verify/:proof   → 驗證（需要認證）               │
│  GET /verify/public/:proof → 公開驗證（無需認證）      │
│  GET /case/:ref/export → 監管鏈 PDF                   │
│  POST /signup         → 註冊（免費，無需支付）       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│               核心引擎 (TypeScript)                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ event.ts │  │merkle.ts │  │anchor.ts │          │
│  │ 哈希鏈    │  │Merkle    │  │Polygon   │          │
│  │ 鏈接     │  │樹+證明   │  │交易+錨定 │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │verify.ts │  │report.ts │  │ auth.ts  │          │
│  │驗證+     │  │PDF 生成  │  │API 密鑰  │          │
│  │公開驗證  │  │監管鏈    │  │管理      │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  ┌──────────┐  ┌──────────┐                         │
│  │billing.ts│  │  db.ts   │                         │
│  │Stripe    │  │ D1 Schema│                         │
│  │Webhooks  │  │ 查詢     │                         │
│  └──────────┘  └──────────┘                         │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              數據層 (Cloudflare D1)                   │
│                                                      │
│  api_keys  │  events  │  cases  │  merkle_anchors   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│           區塊鏈層 (Polygon/Ethereum)                  │
│                                                      │
│  每日 cron → buildMerkleTree() → merkle_root         │
│  → Polygon 交易 (Solo: 每週, Firm: 每日, Ent: 每日)   │
│  → 合約存儲 root → 任何人都可驗證                     │
└─────────────────────────────────────────────────────┘
```

**三層證明可視化：**

```
    ┌── 第 3 層: Polygon 錨定 ───────────────────┐
    │  merkle_root 上鏈提交                        │
    │  tx_hash: 0xabc... 區塊: 12345678           │
    │  防止: 平台運營商篡改                         │
    └────────────────────┬─────────────────────────┘
                         │
    ┌── 第 2 層: Merkle 樹 ──────────────────────┐
    │  所有案例根 → merkle_root                    │
    │  generateMerkleProof() → 每個案例的證明      │
    └────────────────────┬─────────────────────────┘
                         │
    ┌── 第 1 層: 哈希鏈 ─────────────────────────┐
    │  事件 1 proof = SHA-256(payload_1)          │
    │  事件 2 proof = SHA-256(payload_2 + p1)     │
    │  事件 3 proof = SHA-256(payload_3 + p2)     │
    │  修改事件 1 → 所有後續證明中斷               │
    └──────────────────────────────────────────────┘
```

---

## 3. D1 Schema / 數據庫設計

> Schema 詳見 [`design.md §8`](./design.md#8-database-schema)。

### 中文

Cloudflare D1（基於 SQLite）中的四個表：

```sql
-- 表: api_keys
-- 管理所有 API 調用的認證。免費註冊 — 無需支付即可註冊。
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,          -- uuid v4
  key_hash      TEXT NOT NULL UNIQUE,      -- 實際密鑰的 SHA-256（絕不存儲原始密鑰）
  label         TEXT NOT NULL,             -- 用戶友好名稱
  email         TEXT NOT NULL,             -- 擁有者郵箱（用於發票、合規報告）
  firm_name     TEXT,                      -- 可選的公司/組織名稱
  bar_number    TEXT,                      -- 可選的律師執業證號（印在合規報告上）
  stripe_customer_id TEXT,                 -- Stripe 客戶參考（首次購買時創建）
  read_pass_expires_at TEXT,              -- NULL = 無活躍通行證; 30天通行證到期的 ISO 8601 日期
  read_pass_purchase_id TEXT,             -- 上次通行證購買的 Stripe PaymentIntent ID
  events_used   INTEGER NOT NULL DEFAULT 0, -- 自通行證開始以來寫入的事件數
  api_calls_read INTEGER NOT NULL DEFAULT 0, -- 已使用的讀取 API 調用次數（GET /verify, GET /case/:ref/chain, GET /case/:ref/export）
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 表: events
-- 每個註冊的事件。人類軌道通過 case_ref 鏈接，機器軌道通過 source 鏈接。
-- log_type 區分：'human'（Track H，/event）vs 'machine'（Track M，/record）
CREATE TABLE events (
  id            TEXT PRIMARY KEY,          -- uuid v4
  api_key_id    TEXT NOT NULL REFERENCES api_keys(id),
  log_type      TEXT NOT NULL DEFAULT 'human', -- 'human' 或 'machine'
  case_ref      TEXT,                      -- 案件參考（人類軌道），機器軌道為 NULL
  source        TEXT,                      -- 機器人/設備 ID（機器軌道），人類軌道為 NULL
  event_type    TEXT,                      -- 如 "CONTRACT_SIGNED"（人類）或 NULL
  action        TEXT,                      -- 如 "PICK_UP", "MOVE_TO"（機器）或 NULL
  params        TEXT,                      -- JSON blob：結構化行為參數（機器）或 NULL
  file_hash     TEXT,                      -- 外部文檔的 SHA-256（可選，僅人類軌道）
  payload_hash  TEXT NOT NULL,             -- 完整 payload 的 SHA-256（完整性檢查）
  metadata      TEXT,                      -- 任意元數據的 JSON blob（雙軌通用）
  proof         TEXT NOT NULL UNIQUE,      -- SHA-256(payload + previous_proof)
  previous_proof TEXT,                     -- 同一鏈中前一個事件的 proof，首事件為 NULL
  chain_position INTEGER NOT NULL,         -- 鏈中位置（1, 2, 3...）
  merkle_proof  TEXT,                      -- JSON: { root, proof[] } 下次 cron 後更新
  merkle_root   TEXT,                      -- 此事件所屬的 Merkle root
  anchored      INTEGER NOT NULL DEFAULT 0, -- 0=待處理, 1=已上鏈
  tx_hash       TEXT,                      -- Polygon/Ethereum 交易哈希（cron 後）
  timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 快速檢索索引
CREATE INDEX idx_events_case_ref_cn ON events(case_ref, chain_position) WHERE log_type = 'human';
CREATE INDEX idx_events_source_cn ON events(source, chain_position) WHERE log_type = 'machine';
CREATE INDEX idx_events_proof_cn ON events(proof);
CREATE INDEX idx_events_api_key_cn ON events(api_key_id);
CREATE INDEX idx_events_log_type_cn ON events(log_type);

-- 表: cases
-- 案件級元數據和鏈狀態
CREATE TABLE cases (
  id            TEXT PRIMARY KEY,          -- uuid v4
  api_key_id    TEXT NOT NULL REFERENCES api_keys(id),
  case_ref      TEXT NOT NULL UNIQUE,      -- 用戶指定的案件參考
  title         TEXT,                      -- 可選的案件標題
  event_count   INTEGER NOT NULL DEFAULT 0, -- 此案件的總事件數
  first_event   TEXT,                      -- 首個事件的 proof
  last_event    TEXT,                      -- 最後一個事件的 proof
  chain_integrity INTEGER NOT NULL DEFAULT 1, -- 1=完整, 0=中斷
  merkle_root   TEXT,                      -- 此案件的最新 Merkle root
  last_anchored TEXT,                      -- 最後錨定時間
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 表: merkle_anchors
-- 每次 cron 運行創建一條錨定記錄
CREATE TABLE merkle_anchors (
  id            TEXT PRIMARY KEY,          -- uuid v4
  anchor_type   TEXT NOT NULL DEFAULT 'polygon',  -- 'polygon' | 'ethereum'
  merkle_root   TEXT NOT NULL,             -- 所有事件的根哈希
  tx_hash       TEXT NOT NULL,             -- 區塊鏈交易哈希
  block_number  INTEGER,                   -- 鏈上區塊號
  block_confirmations INTEGER DEFAULT 0,   -- 已接收確認數
  case_count    INTEGER NOT NULL,          -- 此根中的案件數
  event_count   INTEGER NOT NULL,          -- 此根中的事件數
  anchor_date   TEXT NOT NULL,             -- 此錨定涵蓋的日期
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'confirmed' | 'failed'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 4. Full API Spec / 完整 API 規範

> API 規格詳見 [`design.md §4.4`](./design.md#44-api-response-格式)。
Request:
{
  "email": "lawyer@firm.com",
  "firm_name": "Smith & Associates",
  "bar_number": "CA-123456"       // optional
}

Response 201:
{
  "api_key": "od_sk_live_abc123def456",
  "api_key_id": "uuid",
  "message": "Account created. Purchase a plan to start writing, or a Read Pass ($29/30d) to start reading."
}

Errors:
  400 — Missing required fields
  409 — Email already registered
```

#### `POST /event`
Register a new event. Auto-chains to previous event in the same case.

```
Headers:
  Authorization: Bearer od_sk_live_abc123def456

Request:
{
  "case_ref": "CASE-2026-073",
  "event_type": "CONTRACT_SIGNED",
  "file_hash": "sha256:def456...",      // optional, SHA-256 of external doc
  "metadata": {
    "signatories": ["John Doe", "Jane Smith"],
    "contract_ref": "CONT-2026-042"
  }
}

Response 201:
{
  "proof": "a1b2c3d4e5f6...",
  "previous_proof": "z9y8x7w6...",     // null if first event in case
  "chain_position": 3,
  "case_ref": "CASE-2026-073",
  "timestamp": "2026-07-05T14:30:00Z",
  "events_used": 3,
  "customer_balance_cents": 5000,          // $50.00 remaining in Customer Balance
  "chain_integrity": true               // false if hash chain mismatch detected
}

Errors:
  401 — Invalid/missing API key
  402 — Insufficient balance (top up event credits)
  409 — Chain integrity error (if previous_proof doesn't match)
  429 — Rate limited

#### `POST /record`

**Machine Track (Track M):** record robot/automation behavior logs. Same three-layer proof chain as Track H (`/event`), different data model — optimized for high-frequency source-action telemetry.

```bash
curl -X POST https://od.workers.dev/record \
  -H "Authorization: Bearer od_sk_live_abc123def456" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "robot-07",
    "action": "PICK_UP",
    "params": {
      "x": 10.5,
      "y": 20.3,
      "object_id": "widget-441"
    },
    "metadata": {
      "firmware": "v2.1.3",
      "sensor_temp": 42.5
    }
  }'
```

Response 201:
```json
{
  "proof": "sha256:a1b2c3d4e5f6...",
  "source": "robot-07",
  "action": "PICK_UP",
  "chain_depth": 1234,
  "timestamp": "2028-03-15T10:30:00Z",
  "events_used": 1234,
  "customer_balance_cents": 50000,
  "chain_integrity": true
}
```

**Key differences from `/event`:**

| Field | `/event` (Track H) | `/record` (Track M) |
|---|---|---|
| Grouping | `case_ref` (human case) | `source` (robot/device ID) |
| Event type | `event_type` (CONTRACT_SIGNED, etc.) | `action` (PICK_UP, MOVE_TO, etc.) |
| Payload | `file_hash` + `metadata` | `params` (structured) + `metadata` |
| Rate | 2–20 writes/min | 2–20 writes/min (same tiers) |
| Chain | Per-case hash chain | Per-source hash chain |

**Same proof layer:** both `/event` and `/record` write to the same D1 `events` table with a `log_type` column (`human` / `machine`). Both go through the identical SHA-256 → Hash Chain → Merkle+Polygon pipeline. Cross-track verification works via the same `/verify/:proof` and `/verify/public/:proof` endpoints.

Errors:
  401 — Invalid/missing API key
  402 — Insufficient balance (top up event credits)
  429 — Rate limited
```

**Hash Chain Logic (in event.ts):**

```typescript
// On POST /event:
// 1. Find latest event for this case_ref
// 2. If exists, previous_proof = latest.proof
// 3. Compute payload_hash = SHA-256(JSON.stringify(payload))
// 4. Compute proof = SHA-256(payload_hash + previous_proof)
//    (or SHA-256(payload_hash) if first event)
// 5. Verify chain integrity: check that all links match
// 6. Store event with computed proof
// 7. Update case.last_event, case.event_count
// 8. Return proof + chain status
```

#### `GET /case/:ref/chain`
Retrieve all events in a case with chain integrity status.

```
Headers:
  Authorization: Bearer od_sk_live_abc123def456

Response 200:
{
  "case_ref": "CASE-2026-073",
  "event_count": 3,
  "chain_integrity": true,
  "events": [
    {
      "event_type": "CONTRACT_SIGNED",
      "proof": "a1b2...",
      "previous_proof": null,
      "chain_position": 1,
      "timestamp": "2026-07-05T14:30:00Z",
      "anchored": true,
      "merkle_proof": { "root": "...", "proof": [...] }
    },
    {
      "event_type": "BREACH_NOTICE_SENT",
      "proof": "e4f5...",
      "previous_proof": "a1b2...",
      "chain_position": 2,
      "timestamp": "2026-07-06T09:15:00Z",
      "anchored": false,
      "merkle_proof": null
    }
  ],
  "merkle_root": "abc123...",
  "last_anchored": "2026-07-07T00:00:00Z",
  "anchor_tx": "0xabc...block12345678"
}
```

#### `GET /verify/:proof`
Verify a single proof. Requires authentication (for the API key owner to self-verify).

```
Headers:
  Authorization: Bearer od_sk_live_abc123def456

Response 200:
{
  "verified": true,
  "proof": "a1b2c3d4...",
  "event": {
    "event_type": "CONTRACT_SIGNED",
    "case_ref": "CASE-2026-073",
    "timestamp": "2026-07-05T14:30:00Z",
    "chain_position": 1
  },
  "chain_integrity": true,
  "merkle_proof_valid": true,
  "blockchain_anchor_valid": true,
  "blockchain_tx": "0xabc...",
  "block_number": 12345678
}

Response 200 (when tampered):
{
  "verified": false,
  "proof": "a1b2c3d4...",
  "chain_integrity": false,
  "merkle_proof_valid": false,
  "message": "Hash chain broken at position 2. Evidence integrity compromised."
}
```

#### `GET /verify/public/:proof`
Public verify endpoint. **NO authentication required.** Designed for judges, opposing counsel, juries, and auditors.

```
Response 200 (HTML page — see Public Verify Page section):
{
  "verified": true,
  "proof": "a1b2c3d4...",
  "event_type": "CONTRACT_SIGNED",
  "case_ref": "CASE-2026-073",
  "timestamp": "2026-07-05T14:30:00Z",
  "chain_integrity": true,
  "merkle_proof_valid": true,
  "blockchain_tx": "0xabc...",
  "block_number": 12345678,
  "blockchain_anchor_valid": true
}

Response 200 — Tampered:
{
  "verified": false,
  "proof": "a1b2c3d4...",
  "message": "This record has been tampered with or does not exist.",
  "details": {
    "note": "If you have the original event payload, you can independently compute SHA-256 and compare."
  }
}
```

#### `GET /case/:ref/export`
Generate a chain-of-custody PDF report for the entire case.

```
Headers:
  Authorization: Bearer od_sk_live_abc123def456

Response 200:
Content-Type: application/pdf
Content-Disposition: attachment; filename="CASE-2026-073-chain-of-custody.pdf"

(Binary PDF — see Chain-of-Custody PDF Report section for contents)
```

### 中文

所有端點均返回 JSON。通過 `Authorization: Bearer <api_key>` 標頭進行認證（公開驗證除外）。基礎 URL：`https://od.workers.dev`

#### `POST /signup`
註冊一個新帳戶。免費註冊 — 無需支付。您將獲得 API 密鑰，但需購買方案或 Read Pass 後才能讀寫。

```
請求:
{
  "email": "lawyer@firm.com",
  "firm_name": "史密斯律師事務所",
  "bar_number": "京-123456"        // 可選
}

響應 201:
{
  "api_key": "od_sk_live_abc123def456",
  "api_key_id": "uuid",
  "message": "帳戶已創建。購買方案開始寫入，或購買 Read Pass（$29/30天）開始讀取。"
}

錯誤:
  400 — 缺少必填字段
  409 — 郵箱已註冊
```

#### `POST /event`
註冊一個新事件。自動鏈接到同一案件的前一個事件。

```
標頭:
  Authorization: Bearer od_sk_live_abc123def456

請求:
{
  "case_ref": "CASE-2026-073",
  "event_type": "CONTRACT_SIGNED",
  "file_hash": "sha256:def456...",       // 可選，外部文檔的 SHA-256
  "metadata": {
    "signatories": ["張三", "李四"],
    "contract_ref": "CONT-2026-042"
  }
}

響應 201:
{
  "proof": "a1b2c3d4e5f6...",
  "previous_proof": "z9y8x7w6...",     // 如為案件首事件則為 null
  "chain_position": 3,
  "case_ref": "CASE-2026-073",
  "timestamp": "2026-07-05T14:30:00Z",
  "events_used": 3,
  "customer_balance_cents": 5000,          // 客戶餘額剩餘 $50.00
  "chain_integrity": true               // 如檢測到哈希鏈不匹配則為 false
}

錯誤:
  401 — 無效/缺失 API 密鑰
  402 — 餘額不足（需充值事件積分）
  409 — 鏈完整性錯誤（若 previous_proof 不匹配）
  429 — 請求過於頻繁
```

#### `POST /record`

**機器軌道（Track M）：** 記錄機器人/自動化行為日誌。與 Track H（`/event`）共用同一套三層證明鏈，但使用針對高頻來源-行為遙測優化的數據模型。

```bash
curl -X POST https://od.workers.dev/record \
  -H "Authorization: Bearer od_sk_live_abc123def456" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "robot-07",
    "action": "PICK_UP",
    "params": {
      "x": 10.5,
      "y": 20.3,
      "object_id": "widget-441"
    },
    "metadata": {
      "firmware": "v2.1.3",
      "sensor_temp": 42.5
    }
  }'
```

Response 201:
```json
{
  "proof": "sha256:a1b2c3d4e5f6...",
  "source": "robot-07",
  "action": "PICK_UP",
  "chain_depth": 1234,
  "timestamp": "2028-03-15T10:30:00Z",
  "events_used": 1234,
  "customer_balance_cents": 50000,
  "chain_integrity": true
}
```

**與 `/event` 的關鍵差異：**

| 欄位 | `/event`（Track H） | `/record`（Track M） |
|---|---|---|
| 分組 | `case_ref`（人類案件） | `source`（機器人/設備 ID） |
| 事件類型 | `event_type`（CONTRACT_SIGNED 等） | `action`（PICK_UP, MOVE_TO 等） |
| 內容 | `file_hash` + `metadata` | `params`（結構化參數） + `metadata` |
| 速率 | 2–20 寫入/分鐘 | 2–20 寫入/分鐘（相同方案） |
| 鏈 | 按案件哈希鏈 | 按來源哈希鏈 |

**相同證明層：** `/event` 和 `/record` 寫入同一個 D1 `events` 表，以 `log_type` 欄位區分（`human` / `machine`）。兩者經過完全相同的 SHA-256 → 哈希鏈 → Merkle+Polygon 管線。跨軌道驗證通過相同的 `/verify/:proof` 和 `/verify/public/:proof` 端點進行。

錯誤:
  401 — 無效/缺失 API 密鑰
  402 — 餘額不足（需充值事件積分）
  429 — 請求過於頻繁
```

**哈希鏈邏輯 (event.ts)：**

```typescript
// POST /event 時：
// 1. 查找此 case_ref 的最新事件
// 2. 如存在，previous_proof = 最新事件的 proof
// 3. 計算 payload_hash = SHA-256(JSON.stringify(payload))
// 4. 計算 proof = SHA-256(payload_hash + previous_proof)
//    （首事件則為 SHA-256(payload_hash)）
// 5. 驗證鏈完整性：檢查所有鏈接是否匹配
// 6. 使用計算出的 proof 存儲事件
// 7. 更新 case.last_event, case.event_count
// 8. 返回 proof + 鏈狀態
```

#### `GET /case/:ref/chain`
檢索案件中的所有事件及鏈完整性狀態。

```
標頭:
  Authorization: Bearer od_sk_live_abc123def456

響應 200:
{
  "case_ref": "CASE-2026-073",
  "event_count": 3,
  "chain_integrity": true,
  "events": [
    {
      "event_type": "CONTRACT_SIGNED",
      "proof": "a1b2...",
      "previous_proof": null,
      "chain_position": 1,
      "timestamp": "2026-07-05T14:30:00Z",
      "anchored": true,
      "merkle_proof": { "root": "...", "proof": [...] }
    },
    {
      "event_type": "BREACH_NOTICE_SENT",
      "proof": "e4f5...",
      "previous_proof": "a1b2...",
      "chain_position": 2,
      "timestamp": "2026-07-06T09:15:00Z",
      "anchored": false,
      "merkle_proof": null
    }
  ],
  "merkle_root": "abc123...",
  "last_anchored": "2026-07-07T00:00:00Z",
  "anchor_tx": "0xabc...block12345678"
}
```

#### `GET /verify/:proof`
驗證單個證明。需要認證（供 API 密鑰擁有者自行驗證）。

```
標頭:
  Authorization: Bearer od_sk_live_abc123def456

響應 200:
{
  "verified": true,
  "proof": "a1b2c3d4...",
  "event": {
    "event_type": "CONTRACT_SIGNED",
    "case_ref": "CASE-2026-073",
    "timestamp": "2026-07-05T14:30:00Z",
    "chain_position": 1
  },
  "chain_integrity": true,
  "merkle_proof_valid": true,
  "blockchain_anchor_valid": true,
  "blockchain_tx": "0xabc...",
  "block_number": 12345678
}

響應 200（被篡改時）:
{
  "verified": false,
  "proof": "a1b2c3d4...",
  "chain_integrity": false,
  "merkle_proof_valid": false,
  "message": "哈希鏈在位置 2 中斷。證據完整性受損。"
}
```

#### `GET /verify/public/:proof`
公開驗證端點。**無需認證。** 專為法官、對方律師、陪審團和審計人員設計。

```
響應 200（HTML 頁面——見公開驗證頁面部門）:
{
  "verified": true,
  "proof": "a1b2c3d4...",
  "event_type": "CONTRACT_SIGNED",
  "case_ref": "CASE-2026-073",
  "timestamp": "2026-07-05T14:30:00Z",
  "chain_integrity": true,
  "merkle_proof_valid": true,
  "blockchain_tx": "0xabc...",
  "block_number": 12345678,
  "blockchain_anchor_valid": true
}

響應 200 — 被篡改:
{
  "verified": false,
  "proof": "a1b2c3d4...",
  "message": "此記錄已被篡改或不存在。",
  "details": {
    "note": "如果您有原始事件 payload，可以獨立計算 SHA-256 進行比較。"
  }
}
```

#### `GET /case/:ref/export`
為整個案件生成監管鏈 PDF 報告。

```
標頭:
  Authorization: Bearer od_sk_live_abc123def456

響應 200:
Content-Type: application/pdf
Content-Disposition: attachment; filename="CASE-2026-073-chain-of-custody.pdf"

（二進制 PDF——內容見監管鏈 PDF 報告章節）
```

---

## 5. Pricing / 定價

### English

**Unified with OS: same two-track model.**

**Track A — Writers (businesses generating evidence):**
Law firms, hospitals, insurance, ecommerce, logistics — anyone storing human evidence chains.

| Tier | Writes/min | Records/write | Monthly | Reads |
|---|---|---|---|---|
| **A** | 2 | 250 | **$99/mo** | 10/min included |
| **B** | 4 | 700 | **$299/mo** | 10/min included |
| **C** | 10 | 1,150 | **$799/mo** | 10/min included |
| **D** | 20 | 2,000 | **$1,999/mo** | 10/min included |

Payment: Stripe Customer Balance + monthly auto-debit. Not a Subscription object.

**Track B — Readers (anyone verifying evidence):**
Lawyers, insurers, regulators, auditors, opposing counsel. One Read Pass works for both **OD (human evidence)** and **OS (robot behavior records)**.

| Item | Price | What You Get |
|---|---|---|
| **Read Pass (30 days)** | **$29** | Unlimited GET /verify, GET /case/:ref/chain, GET /case/:ref/export, dashboard, cross-product query |

**No free reads. No public verify portal. Read Pass is the only way to read.**

**Free tier:** Register + API key only. Cannot read or write.

**Benchmark:** Bernstein.io charges $54/mo for 1 certificate. OD at $29 Read Pass + per-event credits gives you unlimited event chains — different category.

**Payment:** Writers → Customer Balance + monthly debit. Readers → one-time PaymentIntent.

### 中文

**與 OS 統一：同一套雙軌定價。**

**Track A — 寫入者（產生證據的企業）：**
律師事務所、醫院、保險公司、電商平台、物流公司——任何需要存儲人類證據鏈的機構。

| Tier | 寫入/分鐘 | 記錄/每次寫入 | 月費 | 讀取 |
|---|---|---|---|---|
| **A** | 2 | 250 | **$99/月** | 10/min 包含 |
| **B** | 4 | 700 | **$299/月** | 10/min 包含 |
| **C** | 10 | 1,150 | **$799/月** | 10/min 包含 |
| **D** | 20 | 2,000 | **$1,999/月** | 10/min 包含 |

付款：Stripe Customer Balance + 每月自動扣款。非 Subscription 物件。

**Track B — 讀取者（驗證證據的人）：**
律師、保險理賠員、監管機構、審計師、對造律師。一個 Read Pass 同時可讀 **OD（人類證據鏈）** 和 **OS（機器人行為記錄）**。

| 項目 | 價格 | 功能 |
|---|---|---|
| **Read Pass（30天）** | **$29** | 無限 GET /verify、GET /case/:ref/chain、GET /case/:ref/export、dashboard、跨產品查詢 |

**沒有免費讀取。沒有公開驗證入口。Read Pass 是唯一的讀取方式。**

**免費層：** 註冊 + API key only。不能讀也不能寫。

**基準比較：** Bernstein.io 收費 $54/月（1 個證書）。OD 以 $29 Read Pass + 按事件付費提供無限事件鏈——完全不同類別。

**付款：** 寫入者 → Customer Balance + 每月扣款。讀取者 → one-time PaymentIntent。

---

## 6. User Journey / 用戶旅程

### English

#### Phase 0: Discovery (發現)
```
Lawyer gets evidence challenged in court.
Judge: "How do I know this document existed on that date and wasn't modified?"
Lawyer: shows internal log → Judge rejects.

Afterwards: Google "blockchain evidence notarization litigation"
→ outside-docker.com
→ "Prove when it happened. Prove it was never changed."
→ Lawyer sees the pricing: A tier $99/mo or Read Pass $29/30d. Cheaper than one notary visit. Signs up.
```

#### Phase 1: Sign Up (Free) + Buy Pass (註冊免費 + 購買通行證)
```
1. Lawyer visits outside-docker.com
2. Clicks "Get Started"
3. Enters: email, firm_name, bar_number (optional)
4. Instantly receives: API key + dashboard access (free tier — read/write locked until payment)
5. When ready to start a case: clicks "Buy Read Pass" → $29 one-time Stripe PaymentIntent
6. Pass active for 30 days — unlimited reads, can write events at $0.01/ea
7. Total time to sign up: 30 seconds. No credit card needed to register.
```

#### Phase 2: Build Event Chain (構建事件鏈)
```
Case: CASE-2026-073 (Supply Agreement Dispute)

Event 1: POST /event
  { case_ref: "CASE-2026-073",
    event_type: "CONTRACT_SIGNED",
    file_hash: "sha256:def...",
    metadata: { signatories: ["John Doe", "Jane Smith"] } }
  → proof: "b1c2d3..."

Event 2: POST /event
  { case_ref: "CASE-2026-073",
    event_type: "BREACH_NOTICE_SENT",
    metadata: { notice_ref: "NOT-2026-089" } }
  → proof: "e4f5g6...", previous_proof: "b1c2d3..."

Event 3: POST /event
  { case_ref: "CASE-2026-073",
    event_type: "LAWSUIT_FILED",
    metadata: { docket: "NY-SC-2026-1234" } }
  → proof: "g7h8i9...", previous_proof: "e4f5g6..."
```

**Chain Integrity Enforcement:**
- Modify Event 1 → Event 2's proof breaks → Event 3's proof breaks → entire chain proves tampering
- Insert a fake Event 1.5 → breaks hash chain → detected immediately
- Reorder events → chain position mismatch → flagged as integrity failure

**Usage Tracking:**
- Each POST /event increments `events_used` counter and deducts $0.01 from Customer Balance
- When balance is low, API returns warning headers: `X-Balance-Remaining: 2300` (cents)
- When balance exhausted, API returns 402 Payment Required
- Read Pass expires after 30 days — repurchase for continued dashboard access

#### Phase 3: Court (法庭)
```
Lawyer submits OD chain-of-custody PDF to court.
PDF contains:
  - All event hashes in the chain
  - Chain integrity status (VERIFIED)
  - Merkle proof for each event
  - Polygon transaction hash + block number
  - Public verify URL for each proof

Opposing counsel objects:
  "Your Honor, this is just a website. Anyone could have made this."

Judge clicks the public verify link directly from the bench.
  → Opens in browser. Zero installation. Zero crypto knowledge needed.
  → Shows: VERIFIED ✓ · Chain intact ✓ · On Polygon block 12345678 ✓

Judge: "The record is verified by an independent cryptographic system.
        Objection overruled. Evidence admitted."
```

#### Phase 4: Network Effect (網絡效應)
```
Lawyer A wins case citing OD → Precedent cites OD by name
  → Opposing lawyer B sees OD used against them → Adopts OD for own cases
  → Judges expect OD format → Court expects both parties on OD
  → More lawyers adopt OD
  → When both parties use OD, evidence authenticity is no longer disputable

Flywheel:
  Law firm pays → OD notarizes →
  Opposing counsel/judge/auditor publicly verifies →
  Court precedent cites OD →
  More firms adopt OD (compelled by precedent + referral)

The flywheel engine is court precedents.
One precedent is worth 100,000 marketing dollars.
```

### 中文

#### 階段 0: 發現
```
律師在法庭上證據被挑戰。
法官：「你如何證明這份文件在那天存在且未被修改？」
律師：出示內部日誌 → 法官不予採信。

之後：Google 搜索「區塊鏈證據公證訴訟」
→ outside-docker.com
→ 「證明何時發生。證明從未被更改。」
→ 律師看到定價：$29 Read Pass。比一次公證更便宜。免費註冊，準備好時再購買通行證。
```

#### 階段 1: 註冊（免費）+ 購買通行證
```
1. 律師訪問 outside-docker.com
2. 點擊「開始使用」
3. 輸入：郵箱、事務所名稱、律師執業證號（可選）
4. 立即獲得：API 密鑰 + 儀表板訪問權限（免費層 — 讀寫皆鎖定，需付款後解鎖）
5. 準備好接案時：點擊「購買 Read Pass」→ $29 一次性 Stripe PaymentIntent
6. 通行證有效 30 天——無限讀取，可按 $0.01/事件寫入
7. 註冊時間：30 秒。無需信用卡即可註冊。
```

#### 階段 2: 構建事件鏈
```
案件: CASE-2026-073 (供應協議糾紛)

事件 1: POST /event
  { case_ref: "CASE-2026-073",
    event_type: "CONTRACT_SIGNED",
    file_hash: "sha256:def...",
    metadata: { signatories: ["張三", "李四"] } }
  → proof: "b1c2d3..."

事件 2: POST /event
  { case_ref: "CASE-2026-073",
    event_type: "BREACH_NOTICE_SENT",
    metadata: { notice_ref: "NOT-2026-089" } }
  → proof: "e4f5g6...", previous_proof: "b1c2d3..."

事件 3: POST /event
  { case_ref: "CASE-2026-073",
    event_type: "LAWSUIT_FILED",
    metadata: { docket: "NY-SC-2026-1234" } }
  → proof: "g7h8i9...", previous_proof: "e4f5g6..."
```

**鏈完整性強制：**
- 修改事件 1 → 事件 2 的 proof 中斷 → 事件 3 的 proof 中斷 → 整條鏈證明篡改
- 插入偽造的事件 1.5 → 哈希鏈中斷 → 立即檢測
- 重排事件 → 鏈位置不匹配 → 標記為完整性失敗

**用量跟蹤：**
- 每次 POST /event 增加 `events_used` 計數器並從 Customer Balance 扣除 $0.01
- 餘額不足時，API 返回警告標頭：`X-Balance-Remaining: 2300`（美分）
- 餘額用盡時，API 返回 402 Payment Required
- Read Pass 30 天後過期——需重新購買以繼續使用儀表板

#### 階段 3: 法庭
```
律師向法庭提交 OD 監管鏈 PDF。
PDF 包含：
  - 鏈中所有事件哈希
  - 鏈完整性狀態（已驗證）
  - 每個事件的 Merkle 證明
  - Polygon 交易哈希 + 區塊號
  - 每個證明的公開驗證 URL

對方律師反對：
  「法官閣下，這只是一個網站。任何人都可以做出這個。」

法官直接在審判席上點擊公開驗證鏈接。
  → 在瀏覽器中打開。零安裝。零密碼學知識要求。
  → 顯示：已驗證 ✓ · 鏈完整 ✓ · 在 Polygon 區塊 12345678 上 ✓

法官：「此記錄由獨立的密碼學系統驗證。
        反對無效。證據採信。」
```

#### 階段 4: 網絡效應
```
律師 A 引用 OD 勝訴 → 判例點名 OD
  → 對方律師 B 看到 OD 被用來對抗自己 → 為自己案件採用 OD
  → 法官期待 OD 格式 → 法庭期望雙方使用 OD
  → 更多律師採用 OD
  → 當雙方都使用 OD，證據真實性不再有爭議

飛輪：
  律師事務所付費 → OD 記錄 →
  對方律師/法官/審計員公開驗證 →
  法院判例引用 OD →
  更多事務所採用 OD（受判例和推薦驅動）

飛輪引擎是法院判例。
一個判例價值十萬美元營銷費用。
```

---

## 7. Polygon Anchoring + Cron / Polygon 錨定設計

> Polygon 錨定設計詳見 [`design.md §5`](./design.md#5-polygon-上鏈資料結構) 和 [`§12`](./design.md#12-polygon-合約部署)。
┌─────────────┬──────────────┬──────────────────────────────────────┐
│ Plan         │ Frequency     │ Cost Estimate (gas)                  │
├─────────────┼──────────────┼──────────────────────────────────────┤
│ Solo         │ Weekly        │ ~$2-5/mo Polygon gas                 │
│ Firm         │ Daily         │ ~$15-30/mo Polygon gas               │
│ Enterprise   │ Daily (ETH)   │ ~$100-500/mo Ethereum gas            │
└─────────────┴──────────────┴──────────────────────────────────────┘
```

#### anchor.ts Logic

```typescript
// Cron trigger (Cloudflare Workers Cron Triggers)
// Solo: every Sunday at 00:00 UTC
// Firm: every day at 00:00 UTC
// Enterprise: every day at 00:00 UTC (Ethereum mainnet)

async function anchorCron(env: Env): Promise<void> {
  // 1. Get all new events since last anchor
  // 2. Group by case_ref
  // 3. For each case, compute case_merkle_root = MerkleTree(events[].proof)
  // 4. Build global merkle tree: global_root = MerkleTree(all case_merkle_roots)
  // 5. Submit global_root to Polygon/Ethereum contract
  // 6. Record tx_hash in merkle_anchors table
  // 7. Update each event with its merkle_proof (path from leaf to root)
  // 8. Update each case's merkle_root and last_anchored timestamp
}
```

#### Polygon Smart Contract (Minimal)

```solidity
// Deployed once. Stores a history of merkle roots.
// ~50 lines of Solidity. No dependencies.

contract ODAnchor {
    address public owner;
    mapping(uint256 => bytes32) public roots;  // block.timestamp => root
    event RootAnchored(uint256 indexed timestamp, bytes32 root, uint256 blockNumber);

    constructor() {
        owner = msg.sender;
    }

    function anchor(bytes32 _root) external {
        require(msg.sender == owner, "Only owner");
        roots[block.timestamp] = _root;
        emit RootAnchored(block.timestamp, _root, block.number);
    }

    function verify(bytes32 _root, uint256 _timestamp) external view returns (bool) {
        return roots[_timestamp] == _root;
    }
}
```

#### Verify with Blockchain Proof

When a user calls `GET /verify/:proof`, the system:
1. Looks up the event's merkle_proof
2. Verifies: MerkleProof.verify(merkle_proof.root, merkle_proof.path, event.proof)
3. Looks up merkle_anchors for the root
4. Calls the Polygon contract at tx_hash to verify root exists on-chain
5. Returns: chain_integrity ✓, merkle_proof_valid ✓, blockchain_anchor_valid ✓

#### Handling Failed Anchors

- If Polygon tx fails (gas too low, network congestion), mark as `status: 'failed'`
- Retry on next cron cycle
- If 3 consecutive failures, alert admin
- Events remain verifiable via hash chain + merkle — they just lack the blockchain layer temporarily

### 中文

錨定確保即使 OD 的平台運營商也無法篡改證據。Merkle root 被提交到公共區塊鏈——篡改需要在 Polygon/Ethereum 上擁有 51% 的算力。

#### Cron 調度

```
┌─────────────┬──────────────┬──────────────────────────────────────┐
│ 方案         │ 頻率          │ 費用估算（GAS）                        │
├─────────────┼──────────────┼──────────────────────────────────────┤
│ Solo         │ 每週          │ ~$2-5/月 Polygon gas                 │
│ Firm         │ 每日          │ ~$15-30/月 Polygon gas               │
│ Enterprise   │ 每日 (ETH)    │ ~$100-500/月 Ethereum gas            │
└─────────────┴──────────────┴──────────────────────────────────────┘
```

#### anchor.ts 邏輯

```typescript
// Cron 觸發器（Cloudflare Workers Cron Triggers）
// Solo: 每週日 00:00 UTC
// Firm: 每天 00:00 UTC
// Enterprise: 每天 00:00 UTC（Ethereum 主網）

async function anchorCron(env: Env): Promise<void> {
  // 1. 獲取自上次錨定以來所有新事件
  // 2. 按 case_ref 分組
  // 3. 對每個案件，計算 case_merkle_root = MerkleTree(events[].proof)
  // 4. 構建全局 merkle 樹：global_root = MerkleTree(all case_merkle_roots)
  // 5. 將 global_root 提交到 Polygon/Ethereum 合約
  // 6. 在 merkle_anchors 表中記錄 tx_hash
  // 7. 更新每個事件的 merkle_proof（從葉子到根的路徑）
  // 8. 更新每個案件的 merkle_root 和 last_anchored 時間戳
}
```

#### Polygon 智能合約（最小化）

```solidity
// 一次性部署。存儲 merkle root 的歷史記錄。
// 約 50 行 Solidity。無依賴。

contract ODAnchor {
    address public owner;
    mapping(uint256 => bytes32) public roots;  // block.timestamp => root
    event RootAnchored(uint256 indexed timestamp, bytes32 root, uint256 blockNumber);

    constructor() {
        owner = msg.sender;
    }

    function anchor(bytes32 _root) external {
        require(msg.sender == owner, "Only owner");
        roots[block.timestamp] = _root;
        emit RootAnchored(block.timestamp, _root, block.number);
    }

    function verify(bytes32 _root, uint256 _timestamp) external view returns (bool) {
        return roots[_timestamp] == _root;
    }
}
```

#### 使用區塊鏈證明驗證

用戶調用 `GET /verify/:proof` 時，系統：
1. 查找事件的 merkle_proof
2. 驗證：MerkleProof.verify(merkle_proof.root, merkle_proof.path, event.proof)
3. 在 merkle_anchors 中查找該 root
4. 在 tx_hash 處調用 Polygon 合約以驗證 root 是否存在於鏈上
5. 返回：chain_integrity ✓, merkle_proof_valid ✓, blockchain_anchor_valid ✓

#### 處理錨定失敗

- 如果 Polygon 交易失敗（gas 過低、網絡擁堵），標記為 `status: 'failed'`
- 在下一個 cron 週期重試
- 連續 3 次失敗，通知管理員
- 事件仍然可通過哈希鏈 + merkle 驗證——只是暫時缺少區塊鏈層

---

## 8. Public Verify Page / 公開驗證頁面

### English

This is the most critical UX element. When a lawyer submits an OD report to court, the judge clicks a link. If the experience requires any crypto knowledge or installation, the evidence is rejected.

**Design Principles:**
1. **Zero installation** — open in any browser, including a judge's locked-down courthouse PC
2. **Zero crypto knowledge** — no wallets, no MetaMask, no gas fees, no blockchain jargon
3. **Immediate visual result** — green checkmark or red X, immediately understood
4. **Transparent detail** — click to expand technical proof details
5. **Printable** — `@media print` styles for court records

**Page Design:**

```
┌──────────────────────────────────────────────────────┐
│                    Outside Docker                      │
│                 Evidence Verification                  │
├──────────────────────────────────────────────────────┤
│                                                        │
│                   ✅ VERIFIED                          │
│                                                        │
│   Event: CONTRACT_SIGNED                               │
│   Case:  CASE-2026-073                                 │
│   Timestamp: 2026-07-05 14:30:00 UTC                  │
│                                                        │
│   ┌─── Layers ────────────────────────────────┐       │
│   │ ✓ Hash chain intact                       │       │
│   │ ✓ Merkle proof valid                      │       │
│   │ ✓ Blockchain anchor on Polygon            │       │
│   │   Tx: 0xabc...def  Block: 12,345,678      │       │
│   └──────────────────────────────────────────┘       │
│                                                        │
│   ┌─── Technical Details ─────────────────────┐       │
│   │ proof:          a1b2c3d4e5f6...           │       │
│   │ payload_hash:   abc123...                 │       │
│   │ merkle_root:    0x789...                  │       │
│   │ chain_position: 3 of 5                    │       │
│   │ previous_event: VERIFIED ✓               │       │
│   └──────────────────────────────────────────┘       │
│                                                        │
│   ┌─── How to Verify Independently ───────────┐       │
│   │ 1. Open SHA-256 tool                      │       │
│   │ 2. Compute hash of your document          │       │
│   │ 3. Compare with payload_hash above        │       │
│   │ 4. If match → document is authentic       │       │
│   └──────────────────────────────────────────┘       │
│                                                        │
│   This record is independently verified on            │
│   Polygon blockchain. Outside Docker cannot           │
│   modify or delete this record.                       │
│                                                        │
└──────────────────────────────────────────────────────┘
```

**When Tampered (Red State):**

```
┌──────────────────────────────────────────────────────┐
│                   ❌ VERIFICATION FAILED              │
│                                                        │
│   This record has been tampered with or does not       │
│   exist in our system.                                 │
│                                                        │
│   ┌─── Layers ────────────────────────────────┐       │
│   │ ✗ Hash chain broken at position 2        │       │
│   │ ✗ Merkle proof invalid                    │       │
│   │ ✗ Blockchain anchor not found             │       │
│   └──────────────────────────────────────────┘       │
│                                                        │
│   If you have the original document, you can           │
│   independently compute its SHA-256 hash and           │
│   compare.                                             │
│                                                        │
└──────────────────────────────────────────────────────┘
```

**HTML Response from `GET /verify/public/:proof`:**

```html
<!-- Returned as HTML when Accept header includes text/html -->
<!-- Returned as JSON when Accept header is application/json -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Outside Docker — Evidence Verification</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* Minimal, clean, court-appropriate styling */
    body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; }
    .verified { background: #e6ffe6; border: 2px solid #00aa00; border-radius: 12px; padding: 24px; }
    .failed { background: #ffe6e6; border: 2px solid #cc0000; border-radius: 12px; padding: 24px; }
    .layer { margin: 8px 0; padding: 8px; border-radius: 6px; }
    .layer-ok { background: #f0fff0; }
    .layer-fail { background: #fff0f0; }
    code { font-family: 'SF Mono', monospace; font-size: 13px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; word-break: break-all; }
    @media print { body { font-size: 12pt; } .verified, .failed { border: 1px solid #000; } }
  </style>
</head>
<body>
  <!-- Verified or Failed view rendered server-side -->
</body>
</html>
```

### 中文

這是最關鍵的 UX 元素。當律師向法庭提交 OD 報告時，法官點擊一個鏈接。如果體驗需要任何密碼學知識或安裝，證據將被拒絕。

**設計原則：**
1. **零安裝** — 在任何瀏覽器中打開，包括法官鎖定的法庭電腦
2. **零密碼學知識** — 無錢包、無 MetaMask、無 gas 費用、無區塊鏈術語
3. **即時視覺結果** — 綠色勾號或紅色叉號，立即理解
4. **透明細節** — 點擊展開技術證明細節
5. **可打印** — 為法庭記錄添加 `@media print` 樣式

**頁面設計：**

```
┌──────────────────────────────────────────────────────┐
│                    Outside Docker                      │
│                    證據驗證                            │
├──────────────────────────────────────────────────────┤
│                                                        │
│                   ✅ 已驗證                            │
│                                                        │
│   事件: CONTRACT_SIGNED                                │
│   案件: CASE-2026-073                                  │
│   時間戳: 2026-07-05 14:30:00 UTC                     │
│                                                        │
│   ┌─── 層級 ────────────────────────────────┐         │
│   │ ✓ 哈希鏈完整                            │         │
│   │ ✓ Merkle 證明有效                       │         │
│   │ ✓ Polygon 區塊鏈錨定                    │         │
│   │   交易: 0xabc...def  區塊: 12,345,678   │         │
│   └──────────────────────────────────────────┘         │
│                                                        │
│   ┌─── 技術細節 ─────────────────────────────┐         │
│   │ proof:          a1b2c3d4e5f6...           │         │
│   │ payload_hash:   abc123...                 │         │
│   │ merkle_root:    0x789...                  │         │
│   │ 鏈位置:         3/5                       │         │
│   │ 前一事件:       已驗證 ✓                  │         │
│   └──────────────────────────────────────────┘         │
│                                                        │
│   ┌─── 如何獨立驗證 ─────────────────────────┐         │
│   │ 1. 打開 SHA-256 工具                      │         │
│   │ 2. 計算您的文檔的哈希                     │         │
│   │ 3. 與上面的 payload_hash 比較             │         │
│   │ 4. 如匹配 → 文檔為真實                   │         │
│   └──────────────────────────────────────────┘         │
│                                                        │
│   此記錄已在 Polygon 區塊鏈上獨立驗證。                │
│   Outside Docker 無法修改或刪除此記錄。                │
│                                                        │
└──────────────────────────────────────────────────────┘
```

**被篡改時（紅色狀態）：**

```
┌──────────────────────────────────────────────────────┐
│                   ❌ 驗證失敗                          │
│                                                        │
│   此記錄已被篡改或不存在於我們的系統中。                │
│                                                        │
│   ┌─── 層級 ────────────────────────────────┐         │
│   │ ✗ 哈希鏈在第 2 位置中斷                  │         │
│   │ ✗ Merkle 證明無效                        │         │
│   │ ✗ 未找到區塊鏈錨定                       │         │
│   └──────────────────────────────────────────┘         │
│                                                        │
│   如果您有原始文檔，可以獨立計算其 SHA-256 哈希        │
│   並進行比較。                                         │
│                                                        │
└──────────────────────────────────────────────────────┘
```

---

## 9. Chain-of-Custody PDF Report / 監管鏈 PDF 報告

> 請見 [`design.md §7`](./design.md#7-file-upload-策略) 和 [`§14 Phase 7`](./design.md#phase-7-pdf-1-day)。

---

## 10. Build Order / 構建順序

> 請見 [`design.md §14`](./design.md#14-build-order)。

---

## 11. Security Considerations / 安全考量

> 請見 [`design.md §11`](./design.md#11-security-threat-model)。

---

## 12. Legal Compliance Notes / 法律合規筆記

### English

**Important: I am not a lawyer. This section is research-based, not legal advice. Consult with a legal professional for your specific jurisdiction.**

#### Chain of Custody Standards
- **ISO/IEC 27037** — Guidelines for identification, collection, acquisition, and preservation of digital evidence. OD's hash chain + merkle tree + blockchain anchor aligns with this standard's integrity requirements.
- **U.S. Federal Rules of Evidence (FRE 901)** — Requires authentication of evidence. OD's 3-layer proof provides a cryptographic basis for authentication.
- **E.U. eIDAS Regulation** — Electronic signatures and trust services. OD does not provide e-signatures but provides timestamped evidence chains that may complement eIDAS-compliant signatures.

#### Court Precedents on Blockchain Evidence
- **China** — Supreme People's Court (2018): Internet courts may accept blockchain-verified evidence if technical verification methods are reliable.
- **United States** — Multiple state courts have accepted blockchain timestamping as evidence (varies by jurisdiction).
- **EU** — Frontiers in Blockchain (2026) confirms blockchain evidentiary value in civil litigation.
- **Singapore** — Electronic Evidence Act accepts digitally verifiable records.

**OD's Strategy:** Focus on jurisdictions with existing blockchain evidence precedents. Target law firms in: China (internet courts), US (9th Circuit, Delaware), UK (Business and Property Courts), Singapore.

#### Data Sovereignty
- OD uses Cloudflare's global network. Data may be stored in any Cloudflare data center.
- For GDPR compliance: configure D1 to use EU data region.
- For US-specific compliance: use US data region.
- Enterprise plan: dedicated data region negotiation.

#### Electronic Notarization
- OD is NOT a notary service. It does not verify identity or witness signatures.
- OD provides cryptographic evidence of event sequences. The legal weight depends on how it's used and presented.
- Recommendation: Use OD alongside traditional notarization for maximum legal weight. In the future, OD may pursue e-notary compliance (varies by jurisdiction).

#### Third-Party Independence
- **Key legal argument:** "Free evidence is an oxymoron in court." Free services create an incentive misalignment — opposing counsel can argue the service profits from data access, not evidence preservation.
- OD is a paid, independent third party. This is critical for chain-of-custody admissibility.
- OD does NOT store the content of documents — only hashes. The original documents remain with the customer.

#### Billing & Liability
- Stripe handles payment compliance (PCI-DSS Level 1).
- Terms of Service must include: limitation of liability, no warranty of evidence admissibility, no attorney-client relationship.
- Per-event pricing ($0.01/event) with Customer Balance top-up avoids billing disputes — you only pay for what you record.
- Read Pass ($29/30d) is a simple one-time charge — no auto-renewal disputes.
- Enterprise SLA: define uptime guarantees, anchor frequency, support response times.

#### Recommended Actions Before Launch
1. Consult with a lawyer specializing in electronic evidence law in target jurisdictions
2. Review ISO/IEC 27037 compliance gaps
3. Draft Terms of Service + Privacy Policy
4. Ensure D1 data region aligns with customer expectations
5. Prepare for opposing counsel challenges: document the technical verification process in plain language
6. **Cryptographic edge cases** — 請見 [`design.md §5.2.1`](./design.md#521-gas-失敗重試)、[`§5.3`](./design.md#53-anchor-gap-緩解)、[`§11`](./design.md#11-security-threat-model)。

### 中文

**重要：我不是律師。本節基於研究，非法律建議。請諮詢您所在地區的專業法律人士。**

#### 監管鏈標準
- **ISO/IEC 27037** — 數字證據的識別、收集、獲取和保存指南。OD 的哈希鏈 + merkle 樹 + 區塊鏈錨定符合此標準的完整性要求。
- **美國聯邦證據規則 (FRE 901)** — 要求證據的認證。OD 的三層證明為認證提供了密碼學基礎。
- **歐盟 eIDAS 法規** — 電子簽名和信任服務。OD 不提供電子簽名，但提供加時間戳的證據鏈，可補充 eIDAS 合規簽名。

#### 區塊鏈證據的法院判例
- **中國** — 最高人民法院（2018）：互聯網法院可接受區塊鏈驗證的證據，如果技術驗證方法可靠。
- **美國** — 多個州法院已接受區塊鏈時間戳作為證據（因司法管轄區而異）。
- **歐盟** — Frontiers in Blockchain（2026）確認區塊鏈在民事訴訟中的證據價值。
- **新加坡** — 電子證據法接受數字可驗證記錄。

**OD 策略：** 專注於有關鏈區塊鏈證據判例的司法管轄區。目標律師事務所所在地：中國（互聯網法院）、美國（第 9 巡迴法院、特拉華州）、英國（商業和財產法院）、新加坡。

#### 數據主權
- OD 使用 Cloudflare 的全球網絡。數據可能存儲在任何 Cloudflare 數據中心。
- 為 GDPR 合規：將 D1 配置為使用歐盟數據區域。
- 為美國合規：使用美國數據區域。
- Enterprise 方案：可協商專用數據區域。

#### 電子公證
- OD **不是**公證服務。它不驗證身份或不見證簽名。
- OD 提供事件序列的密碼學證明。法律效力取決於使用和呈現方式。
- 建議：OD 與傳統公證一同使用以獲得最大法律效力。未來 OD 可能追求電子公證合規（因管轄區而異）。

#### 第三方獨立性
- **關鍵法律論證：**「免費證據在法庭上是矛盾的。」免費服務造成激勵錯位——對方律師可以論證該服務從數據訪問而非證據保存中獲利。
- OD 是付費的獨立第三方。這對監管鏈的可採性至關重要。
- OD 不存儲文檔內容——僅存儲哈希。原始文檔仍由客戶持有。

#### 帳單與責任
- Stripe 處理支付合規（PCI-DSS Level 1）。
- 服務條款必須包含：責任限制、不保證證據可採性、無律師-客戶關係。
- 月度訂閱模式意味著無按事件定價爭議。
- Enterprise SLA：定義正常運行時間保證、錨定頻率、支持響應時間。

#### 啟動前建議採取的行動
1. 諮詢目標管轄區的電子證據法律專家律師
2. 審查 ISO/IEC 27037 合規差距
3. 起草服務條款 + 隱私政策
4. 確保 D1 數據區域符合客戶期望
5. 準備應對對方律師的挑戰：用平實語言記錄技術驗證過程

---

## 12.5 EU AI Act Compliance / EU AI Act 合規

> **Source:** OS (Ω Sanctuary) original market intelligence. Applies primarily to Track M (machine track). Track H (human documents) benefits indirectly from the same compliance infrastructure.

### Why This Matters

**EU AI Act Article 12** (effective 2026.08.02) mandates that high-risk AI systems must have automatic event logging. **Article 19** requires logs be kept for at least 6 months.

The law does NOT mandate a third party — but **your own logs are not credible after an incident.** Third-party timestamp preservation is the difference between "we say this record existed" and "the blockchain proves this record existed at that time."

> Regulator audits Company A: "Here are our logs."
> "Who controls them?" "We do."
> "Fine: €30M or 6% of global revenue."
>
> Regulator audits Company B (using OD Track M):
> "Here is OD's event chain proof. Merkle root on Polygon: 0xabc..."
> "Record timestamps are independently verifiable."

### Market: Physical AI & Robotics

| Segment | 2025/26 | 2030+ | CAGR |
|---|---|---|---|
| Physical AI (total) | $5.23B | $87.43B (2035) | 32.53% |
| Humanoid robots | $2.16B (2026) | $8.78B (2033+) | — |
| Autonomous mobile robots | $4.2B | $11.8B | 23% |

Source: SNS Insider, Goldman Sachs, MarketsAndMarkets

### Competition: Blue Ocean

- **0 products** positioned as "robot event timestamp preservation layer"
- Bernstein.io ($54-329/mo): IP certificates, single-file timestamping — does NOT do machine behavior chains
- Self-built logging: technically possible, but zero credibility in court
- Traditional notarization: cannot handle high-frequency machine logs

> 技術對應詳見 [`design.md §15`](./design.md#15-eu-ai-act-compliance)。

## 13. SWOT Analysis / 優劣勢分析

### English

| Strength | Weakness |
|----------|----------|
| **S1 — First Use God Product.** 戊土 is the most needed element in your Ba Zi. Building OD = following destiny. | **W1 — Concept stage, zero code.** Nothing built yet. |
| **S2 — Zero AI dependency.** Core is cryptography (hash chains + timestamps + blockchain anchoring). Not affected by AI market volatility. | **W2 — Solo developer, no background.** No team, no reputation in legal tech. |
| **S3 — Blue ocean market.** LegalTech $32.8B (2026) → $63.1B (2033) CAGR 12%. Evidence management $2.1B (2024) → $4.5B (2032). Market fragmented, no dominant player. | **W3 — Willingness to pay unverified.** Need to validate that law firms will actually pay. |
| **S4 — Clear differentiation.** Verifiable event chains (NOT Bernstein.io's single-file stamps). Modify any node → entire chain breaks. | |
| **S5 — Blockchain evidence already recognized.** Chinese Supreme Court 2018, US, EU, Singapore all accept blockchain evidence. | |

| Opportunity | Threat |
|-------------|--------|
| **O1 — Frontiers in Blockchain 2026** confirms blockchain evidentiary value in civil litigation. | **T1 — Bernstein.io** has first-mover advantage and court cases citing them. |
| **O2 — AI era trust deficit** only increases → time-series evidence demand grows exponentially. | **T2 — DocuSign/Adobe Sign** could extend into blockchain notarization features. |
| **O3 — Evidence management market CAGR 9.77%** confirms market growth. | **T3 — Regulatory changes** in electronic evidence law across jurisdictions. |
| **O4 — LegalTech not monopolized** by giants, clear gap. | **T4 — In-house build** is feasible for large law firms. |

### 中文

| 優勢 | 劣勢 |
|------|------|
| **S1 — 第一用神產品。** 戊土在你的八字中最需要。做 OD = 順命而行。 | **W1 — 概念階段，零代碼。** 尚無任何構建。 |
| **S2 — 零 AI 依賴。** 核心是密碼學（哈希鏈 + 時間戳 + 區塊鏈錨定），不受 AI 市場波動影響。 | **W2 — 單人開發，無背景。** 無團隊，法律技術領域無聲譽。 |
| **S3 — 藍海市場。** LegalTech $32.8B (2026) → $63.1B (2033) CAGR 12%。證據管理 $2.1B (2024) → $4.5B (2032)。市場碎片化，無龍頭。 | **W3 — 付費意願未驗證。** 需要驗證律師事務所是否會實際付費。 |
| **S4 — 差異化明確。** 可驗證的事件鏈（非 Bernstein.io 的單一文件戳記）。修改任一節點→整鏈斷裂。 | |
| **S5 — 區塊鏈證據已被認可。** 中國最高法院 2018、美國、歐盟、新加坡均接受區塊鏈證據。 | |

| 機會 | 威脅 |
|------|------|
| **O1 — Frontiers in Blockchain 2026** 確認區塊鏈在民事訴訟中的證據價值。 | **T1 — Bernstein.io** 有先發優勢和引用他們的法院案例。 |
| **O2 — AI 時代信任赤字**只會增加→時間序列證據需求指數級增長。 | **T2 — DocuSign/Adobe Sign** 可能擴展至區塊鏈公證功能。 |
| **O3 — 證據管理市場 CAGR 9.77%** 確認市場在增長。 | **T3 — 各國電子證據法規變動**風險。 |
| **O4 — 法律科技未被巨頭壟斷**，缺口明確。 | **T4 — 自建方案**對大型律師事務所可行。 |

---

## 14. Timeline / 時間線

### English

```
2026 Jul  ─── Cryptography + evidence law study
     Aug  ─── LegalTech market research
     Sep  ─── CLI PoC starts (hash chain + merkle + anchor)
     Oct  ─── Law firm interviews begin (schedule on high-energy days)
     Nov  ─── Interview feedback compilation
     Dec  ─── GO/NO-GO decision on MVP

2027 Jan  ─── If GO: MVP development starts (Phase A-F = ~8 days)
     Feb  ─── MVP deployed, first design partner onboarding
     Mar  ─── Active design partner program (paid, not free)
     Apr  ─── Product iteration based on feedback
     May  ─── First regular customers
     Jun  ─── Prepare for first court precedent
     Jul  ─── Target: first OD-cited court ruling

2027 Q3  ─── Flywheel begins spinning
2027 Q4  ─── 10+ active customers
2028     ─── Scale (if precedent flywheel ignites)
         ─── If NO-GO: redirect resources to FM (Fortune Master)
```

**Important Note:** OD is 土 (Earth) — your first 用神. But 用神 doesn't mean "build immediately." First ask law firms if they'll pay. If they say yes, this is your destiny product. If they say no, OD can wait until 戊辰大运 (2030-2039) — 用神 doesn't expire.

### 中文

```
2026年7月  ─── 密碼學 + 證據法學習
     8月  ─── LegalTech 市場研究
     9月  ─── CLI 概念驗證開始（哈希鏈 + merkle + 錨定）
     10月 ─── 律師事務所訪談開始（安排在高能量日）
     11月 ─── 訪談回饋整理
     12月 ─── MVP 階段 GO/NO-GO 決定

2027年1月  ─── 如 GO：MVP 開發開始（A-F 階段 = 約 8 天）
     2月  ─── MVP 部署，首個 design partner 入駐
     3月  ─── 活躍的 design partner 計劃（付費，非免費）
     4月  ─── 根據反饋進行產品迭代
     5月  ─── 首批常規客戶
     6月  ─── 為首個法院判例做準備
     7月  ─── 目標：首個引用 OD 的法院裁決

2027 Q3  ─── 飛輪開始轉動
2027 Q4  ─── 10+ 活躍客戶
2028     ─── 規模化（如判例飛輪點燃）
         ─── 如 NO-GO：資源轉移到 FM（財神）
```

**重要說明：** OD 是土——你的第一用神。但用神不等於「立刻做」。先問律師事務所願不願意付錢。如果他們說 yes，這就是你的天命產品。如果他們說 no，OD 可以等到戊辰大運（2030-2039）再啟動——用神不會過期。

---

## Appendices / 附錄

### A. Project File Structure Suggestion (Up to improvement)

```
outside-docker/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # Hono app, routes, middleware
│   ├── db.ts             # D1 schema + query helpers
│   ├── auth.ts           # API key management + auth middleware
│   ├── event.ts          # POST /event + hash chain logic
│   ├── merkle.ts         # Merkle tree + proof generation
│   ├── anchor.ts         # Polygon anchoring + cron
│   ├── verify.ts         # GET /verify + /verify/public
│   ├── report.ts         # Chain-of-custody PDF
│   ├── billing.ts        # Stripe PaymentIntent (Read Pass) + Customer Balance (event credits)
│   └── contracts/
│       └── ODAnchor.sol  # Polygon/Ethereum anchor contract
├── dashboard/            # React SPA
│   ├── src/
│   │   ├── pages/
│   │   │   ├── ApiKeysPage.tsx
│   │   │   ├── CasesPage.tsx
│   │   │   ├── ReportsPage.tsx
│   │   │   └── BillingPage.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   └── App.tsx
│   ├── package.json
│   └── vite.config.ts
├── docs/
│   ├── api.md
│   ├── integration.md
│   └── verification.md
├── scripts/
│   ├── seed.ts
│   └── migrate.ts
└── README.md
```

### B. Key curl Examples / 關鍵 curl 示例

```bash
# Sign up
curl -X POST https://od.workers.dev/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"lawyer@firm.com","firm_name":"Smith & Assoc"}'

# Register event
curl -X POST https://od.workers.dev/event \
  -H "Authorization: Bearer od_sk_live_abc123" \
  -H "Content-Type: application/json" \
  -d '{"case_ref":"CASE-2026-073","event_type":"CONTRACT_SIGNED","metadata":{"signatories":["John Doe"]}}'

# Get chain
curl https://od.workers.dev/case/CASE-2026-073/chain \
  -H "Authorization: Bearer od_sk_live_abc123"

# Public verify (no auth needed)
curl https://od.workers.dev/verify/public/a1b2c3d4e5f6...

# Export PDF
curl https://od.workers.dev/case/CASE-2026-073/export \
  -H "Authorization: Bearer od_sk_live_abc123" \
  -o chain-of-custody.pdf
```

### C. Market Data Sources / 市場數據來源

- **LegalTech Market:** Persistence Market Research — $32.8B (2026) → $63.1B (2033), CAGR 12%
- **Evidence Management:** Verified Market Research — $2.1B (2024) → $4.5B (2032), CAGR 9.77%
- **Blockchain Evidence:** Frontiers in Blockchain (2026) — academic confirmation of evidentiary value
- **Chinese Supreme Court:** 最高人民法院《關於互聯網法院審理案件若干問題的規定》(2018)
- **Pricing Benchmark:** Bernstein.io — $54-329/mo for single-file timestamp certificates

---

> *This manual was synthesized from OD_TODO.md, aq.md, and post.md — the complete strategic, technical, and market blueprint for Outside Docker.*
>
> *本手冊由 OD_TODO.md、aq.md 和 post.md 綜合而成——Outside Docker 的完整戰略、技術和市場藍圖。*
>
> **Build now. The market is already here.**
> **立即構建。市場已經存在。**
