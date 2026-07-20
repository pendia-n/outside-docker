# OD — 完整技術與 UX 藍圖

> 根據 od.md 產品規格與後續討論整理而成的實作設計文件。

---

## 目錄

1. [Tech Stack](#1-tech-stack)
2. [Auth 系統](#2-auth-系統)
3. [Access Control](#3-access-control)
4. [雙軌強制 Track H vs Track M](#4-雙軌強制-track-h-vs-track-m)
5. [Polygon 上鏈資料結構（不可變倉庫）](#5-polygon-上鏈資料結構不可變倉庫)
6. [Passcode 加密機制](#6-passcode-加密機制)
7. [File Upload 策略](#7-file-upload-策略)
8. [Database Schema](#8-database-schema)
9. [Dashboard Pages](#9-dashboard-pages)
10. [Verification Flow UX](#10-verification-flow-ux)
11. [Security Threat Model](#11-security-threat-model)
12. [Polygon 合約部署](#12-polygon-合約部署)
13. [Dev Seed Route](#13-dev-seed-route)
14. [Build Order](#14-build-order)

---

## 1. Tech Stack

| 層級 | 技術 |
|------|------|
| API Framework | Hono (Cloudflare Workers) |
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 |
| Query | Drizzle ORM |
| Frontend | React + Vite + TypeScript（同一個 Worker 掛 SPA） |
| PDF | @cloudflare/puppeteer (Workers Browser Rendering) |
| Auth | Argon2id (hash-wasm) + JWT (8h) + httpOnly refresh token (28d) + 可選 TOTP |
| Payment | Stripe Customer Balance (writer) + PaymentIntent (reader) |
| Blockchain | Polygon (event logs) |
| Encryption | AES-256-GCM (Web Crypto API) + passcode-derived key (Argon2id) |
| Passcode scope | Per-case（case 建立時系統產生 high-entropy passcode，一次性顯示） |
| File hash | 前端 Web Crypto API（PHI 情境） / Server-side fallback（non-PHI） |
| Monorepo | npm workspaces |

---

## 2. Auth 系統

### 2.1 註冊與登入

```
Signup（需付款才完成註冊）
  ├── username + password (required)
  ├── email (required, 帳單/通知)
  └── TOTP (optional)

Login
  ├── username + password
  ├── if TOTP enabled → verify 6-digit code
  └── Access token: JWT (8h, in memory)
  └── Refresh token: httpOnly cookie (28d, rotated on each use)

Password Reset（二選一）:
  ├── Path A: 記得 current password → 直接設新密碼
  └── Path B: 有 TOTP → verify TOTP → 設新密碼
  無 email reset
```

### 2.2 Roles

| Role | 誰 | 權限 |
|------|----|------|
| `writer` | 付費上傳者（律師、保險、物流、機器人公司） | 寫入 + 讀自己的 events（需 passcode） |
| `reader` | 付費讀取者（律師、會計師、監管機構） | 讀被 share 的 events（需 passcode） |

不存在 admin role。營運操作走 Cloudflare / Stripe 原生管理介面。

### 2.3 JWT Claims

```typescript
// Access token (8h)
{
  sub: user_id,
  username: string,
  role: 'writer' | 'reader',
  type: 'access',
  iat: timestamp,
  exp: timestamp + 8 hours
}

// Refresh token (28d, httpOnly cookie, rotated on each use)
{
  sub: user_id,
  type: 'refresh',
  iat: timestamp,
  exp: timestamp + 28 days
}
```

### 2.4 Password Hashing

使用 `hash-wasm` Argon2id。Workers 上無法使用 bcrypt，Argon2id WASM 是目前最佳替代。

### 2.5 API Keys（程式化存取）

`api_keys` 表綁定 user，用於程式化提交（Track M 強制使用）：

```typescript
{
  id: string,
  userId: string,       // FK → users.id
  keyHash: string,      // SHA-256 of raw key
  label: string,
  machineOnly: boolean, // true → 只能用於 Track M
  isActive: boolean,
  createdAt: string
}
```

### 2.6 TOTP Gate on Sensitive Read

```
查看 event detail、export PDF、create share token → 需 TOTP re-verify
List view（只看 timestamp + case_ref + proof prefix） → 不需 TOTP
```

### 2.7 API Key Write-Only

```
API key 只能用於 POST /event 和 POST /record
不能讀取任何資料
讀取必須走 dashboard session + TOTP
```

---

## 3. Access Control

### 3.1 讀取權限矩陣

| Who | 能讀 payload 內容？ | 方式 |
|-----|-------------------|------|
| **Writer**（in plan） | ✅ 自己的 events | 提供 passcode → server 即時解密 |
| **Reader**（paid） | ✅ 被 share 的 events | 提供 passcode（uploader 帶外提供） |
| **Platform** | ❌ 無法解密 | 沒有 passcode，display_blob 等於亂碼 |
| **Random** | ❌ | — |

### 3.2 Share Token 機制

```
Writer dashboard → 選一個 proof → 點 "Share"
  → 產生 share URL (內含 token)
  → 把 URL 傳給要驗證的人

Verifier 打開 URL：
  → Worker 驗證 token
  → 輸入 passcode
  → Worker 用 passcode 即時解密 display_blob
  → 回傳 verification page + decrypted payload
  → token 無效 → 403
```

### 3.3 Passcode 不存 Server — Per-Case

Passcode 綁定 case（Track H）/ source（Track M），不是綁定帳號。每個 case/source 有自己的 passcode，leak 時只曝險單一案件。

```
建立 case/source 時:
  Server 產生 high-entropy passcode（8 chars alphanumeric，~47 bits）
  → 一次性顯示給 user（dashboard / API response）
  → User 自行保管（password manager、case file、PDF export）
  → Server **不存 passcode**

寫入時:
  User 提供 case_ref/source + passcode
  derived_key = Argon2id(passcode)
  display_blob = AES-256-GCM({ payload, payload_hash }, derived_key)
  → D1 只存 display_blob
  → passcode、derived_key、payload_hash 用完即丟

讀取時:
  User 提供 passcode
  derived_key = Argon2id(passcode)
  payload_hash = AES.decrypt(display_blob, derived_key)
  → 驗證 hash chain + merkle
  → 回傳結果
  → derived_key、payload_hash 用完即丟

遺失 passcode → 該 case/source 資料永久遺失，無救援可能。
```

### 3.4 獨立驗證（不需 OD）

情境分兩種：

**情境 A — Verifier 擁有原始檔案**

```
Verifier 擁有：
  1. 原始檔案（在自己電腦）
  2. proof + merkle_proof path（來自 PDF report / POST 回傳）
  3. merkle_root（來自 Polygon，公開）

驗證步驟（全部 client-side）:
  1. SHA-256(原始檔案) = file_hash
  2. 組合 payload JSON（file_hash + event_type + event_nonce + metadata + ...）
  3. payload_hash = SHA-256(JSON.stringify(payload))
  4. SHA-256(payload_hash + previous_proof) == proof ✅
  5. MerkleProof.verify(root, path, proof) ✅
```

**情境 B — Verifier 有 passcode 但無原始檔案（OD 倒閉，只剩 Polygon）**

```
Verifier 擁有：
  1. passcode（由 writer 帶外提供）
  2. 能讀 Polygon event log（公開）

驗證步驟（全部 client-side）:
  1. 從 Polygon event log 撈到 display_blob（AES 加密） + proof
  2. derived_key = Argon2id(passcode)
  3. AES-256-GCM 解密 display_blob → { payload, payload_hash }
  4. 重新計算: SHA-256(JSON.stringify(payload)) == payload_hash ✅
  5. SHA-256(payload_hash + previous_proof) == proof ✅
  6. MerkleProof.verify(root, path, proof) ✅
```

兩種情境都不需要 OD server、不需要 D1。Polygon 是第三方不可變永久倉庫。

### 3.5 Security Threat Model

| 攻擊向量 | 保護層 | 突破條件 |
|---------|--------|---------|
| JWT theft | Passcode-derived key | 需同時有 JWT + passcode |
| D1 SQL injection / dump | display_blob AES 加密 + Argon2id KDF | 需 passcode（離線暴力破解受 Argon2id cost 保護） |
| Server RCE | Passcode 不持久儲存 | 需在讀取請求時恰好攔截 in-memory key |
| Polygon tx public | display_blob AES 加密 + proof 含 per-event nonce | 無 passcode 無法解密；nonce 防止 dictionary attack |
| API key leak | API key write-only | 只能寫不能讀 |
| Platform admin abuse | 無 passcode | 無法解密 |
| Proof dictionary attack | event_nonce 隨機 salt | 公開 proof 無法反推 payload（nonce 在 display_blob 加密保護） |

---

## 4. 雙軌強制 Track H vs Track M

| | Track H (Human) | Track M (Machine) |
|---|---|---|
| **Submit 方式** | REST API / MCP agent / UI dashboard | REST API / MCP agent **only** |
| **Grouping** | `case_ref` | `source` + 可選 `session_id` |
| **Auth method** | JWT (session) / API key / MCP token | **API key / MCP token only** |
| **Dashboard** | Create / Read / Export | Read / Export **only, no Create** |

### 4.1 Track H 允許的情境

- 律師助理打開 OD dashboard，填表單、上傳檔案、按 submit
- 律師事務所的 DMS 系統用 REST API 自動上傳
- MCP agent 監聽文件資料夾，自動 POST /event

### 4.2 Track M 強制程式化

Track M 的 auth 限制（API key / MCP token only）確保**提交管道為程式化**，在合規審計中提供可追溯的提交方式。這不是對 payload 內容的擔保（內容真實性取決於來源系統的完整性），而是對提交路徑的擔保。

```typescript
// route/record.ts
if (log_type === 'machine') {
  const authMethod = c.get('auth_method')
  if (authMethod !== 'api_key' && authMethod !== 'mcp_token') {
    return c.json({ error: 'Track M requires programmable submission only' }, 403)
  }
}
```

### 4.3 何時斷鏈開新 chain

| 情境 | 新 chain 觸發方式 | `previous_proof` |
|------|------------------|-----------------|
| Track H: 新案件 | 新的 `case_ref` | null |
| Track M: 新 source | 新的 `source` | null |
| Track M: 新 session | 新的 `session_id`（可選） | null |
| Track M: 繼續同一 chain | 同 source + 同 session_id | 上一個 proof |

```typescript
function computePreviousProofKey(event): string | null {
  if (log_type === 'human') {
    return `case_ref:${case_ref}`
  } else {
    if (session_id) return `source:${source}:session:${session_id}`
    return `source:${source}`
  }
}
```

### 4.4 API Response 格式

#### 4.4.1 POST /event（Track H）

```json
// 200
{
  "proof": "abc...",
  "chain_position": 3,
  "chain_integrity": true,
  "events_used": 42,
  "customer_balance_cents": 5000
}

// 402 — 餘額不足
{ "error": "insufficient_balance", "detail": "Required: $0.01, Balance: $0.00" }

// 409 — Chain integrity 異常
{ "error": "chain_integrity_violation", "detail": "previous_proof mismatch" }
```

#### 4.4.2 POST /record（Track M）

```json
// 200
{
  "proof": "def...",
  "chain_depth": 1234,
  "events_used": 100,
  "customer_balance_cents": 5000
}
```

#### 4.4.3 通用 Error Codes

| Code | 情境 | Response |
|------|------|----------|
| 402 | Customer Balance 不足 | `{ error, detail }` |
| 409 | Hash chain 驗證失敗 | `{ error, detail }` |
| 429 | Rate limit 超過 | `{ error, retry_after }` + `Retry-After` header |

所有成功 response 含 `X-Balance-Remaining` header（單位：cents）。

---

## 5. Polygon 上鏈資料結構

### 5.1 每日 anchor batch

每個 event 的 `display_blob` 已用 passcode-derived key（Argon2id）加密。Batch JSON 直接明文上 Polygon，**不用再包一層 AES**。

```json
{
  "merkle_root": "0xabc...",
  "anchor_date": "2026-07-19",
  "proofs": ["0xproof1", "0xproof2", "0xproof3"],
  "display_blobs": ["0xencrypted_blob_1", "0xencrypted_blob_2", "0xencrypted_blob_3"],
  "proof_count": 42,
  "event_count": 42
}
```

**Polygon = 第三方不可變永久倉庫。** display_blob 已 AES-256-GCM 加密，沒有 passcode 的人拿到也是亂碼。有 passcode 的供應商/reader 可直接從 Polygon 解密，不需 OD server。

Polygon 上沒有未加密的 payload、沒有 metadata、沒有 passcode。所有敏感資料都受 AES + Argon2id 保護。

### 5.2 Gas 策略

用 **Polygon event log** 而非 contract state storage。display_blob 約 300-500 bytes/event，8 gas/byte。

| 情境 | Gas/tx | 成本估算 |
|------|--------|---------|
| 僅 merkle_root + proofs（原設計） | ~10,000-15,000 | ~$0.0004/天, ~$0.012/月 |
| 含 display_blobs（100 events/day） | ~250,000-400,000 | ~$0.08-0.16/天, ~$2.5-5/月 |

一天一筆 log，不是每事件一筆。Polygon PoS mainnet 非 zkEVM（zk 對已加密資料無額外價值）。

成本仍遠低於 Solo tier $99/mo 定價，可接受。

#### 5.2.1 Gas 失敗重試

```typescript
// anchor cron pseudocode
const merkleRoot = buildMerkleTree(events)
const tx = await sendPolygonTx(merkleRoot, proofs, displayBlobs)
const record = {
  status: 'pending',
  tx_hash: tx.hash,
  merkle_root: merkleRoot,
  anchor_date: today
}
await db.insert(merkle_anchors).values(record)

// wait for receipt
const receipt = await tx.wait()
if (receipt.status === 1) {
  await db.update(merkle_anchors)
    .set({ status: 'success', block_number: receipt.blockNumber, block_confirmations: 0 })
    .where(eq(merkle_anchors.tx_hash, tx.hash))
} else {
  // fee-bumped retry with same nonce
  const retryTx = await wallet.sendTransaction({
    to: contractAddress,
    data: encodedAnchorCall,
    nonce: tx.nonce,          // same nonce = replace pending tx
    maxFeePerGas: originalFee * 1.5
  })
  await db.update(merkle_anchors)
    .set({ status: 'failed', tx_hash: retryTx.hash })
    .where(eq(merkle_anchors.tx_hash, tx.hash))
}
```

### 5.3 Anchor Gap 緩解

從事件寫入到 daily anchor 之間約有 ~14h 空窗期，期間 platform 可能竄改 payload。

**緩解方式**：POST /event 回傳 `proof` + `previous_proof`，client 端立即存下。Platform 若事後在 D1 偷改，client 持有當時的 hash 可舉證。

```typescript
// POST /event response 含 anchor gap 緩解欄位
{
  "proof": "sha256(payload_hash + previous_proof)",
  "previous_proof": "sha256(prev_payload_hash + prev_prev_proof)",
  "chain_position": 3,
  // 其餘欄位...
}
```

Client 拿到後存在自己的系統（律師的 DMS、IoT 的本地 DB）。即使 server 被入侵竄改，client 有寫入當時的 proof 作為證據。

---

## 6. Passcode 加密機制

這是 OD 信任模型的核心。所有 payload 的加密金鑰來自使用者的 passcode，Server 無法獨立解密。

### 6.1 Derived Key 計算

使用 `hash-wasm` Argon2id（同 §2.4 password hashing）取代裸 SHA-256，防止離線暴力破解。

```typescript
// Argon2id 作為 key derivation function
// 保護離線暴力破解（與登入密碼同一套標準）
async function deriveKey(passcode: string): Promise<Uint8Array> {
  const argon2id = await import('hash-wasm')
  const derivedKey = await argon2id.argon2id({
    password: passcode,
    salt: crypto.getRandomValues(new Uint8Array(16)),
    parallelism: 1,
    iterations: 3,
    memorySize: 4096,   // 4 MB
    hashLength: 32,      // 32 bytes → AES-256-GCM key
    outputType: 'binary',
  })
  return derivedKey
}
```

### 6.2 寫入流程

```typescript
async function handleWrite(payload: object, passcode: string) {
  // 1. 加入 per-event nonce（防 Polygon proof dictionary attack）
  const payloadWithNonce = { ...payload, event_nonce: crypto.randomUUID() }
  const payloadJson = JSON.stringify(payloadWithNonce)
  const payloadHash = await sha256(payloadJson)

  // 2. 建立 display_blob（加密 payload_with_nonce + payload_hash）
  const derivedKey = await deriveKey(passcode)   // Argon2id
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = JSON.stringify({ payload: payloadWithNonce, payload_hash: payloadHash })
  const displayBlob = await aes256gcmEncrypt(plaintext, derivedKey, nonce)

  // 3. hash chain
  const previousProof = await findLatestProof(groupKey)
  const proof = await computeProof(payloadHash, previousProof)

  // 4. 存 D1（不存 passcode、不存 derivedKey、不存 payloadHash）
  await db.insert(events).values({
    display_blob: displayBlob,
    proof: proof,
    previous_proof: previousProof,
    ...
  })

  // 5. 回傳 proof + previous_proof — client 立即存本地
  //    這份 hash 可在 anchor 空窗期做為證據（§5.3）
  return {
    proof,
    previous_proof: previousProof,
    chain_position: event.chain_position,
  }

  // 6. display_blob 將在每日 cron 時隨 batch 上 Polygon
}
```

### 6.3 讀取流程

```typescript
async function handleRead(eventId: string, passcode: string) {
  const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
  if (!event) return 404

  // 1. 從 passcode 重建 derived_key（Argon2id）
  const derivedKey = await deriveKey(passcode)
  const { payload, payload_hash } = JSON.parse(
    await aes256gcmDecrypt(event.display_blob, derivedKey, event.nonce)
  )
  // payload 包含 event_nonce，可用於重建 payload_hash 驗證

  // 2. 驗證 hash chain
  const computedProof = await computeProof(payload_hash, event.previous_proof)
  if (computedProof !== event.proof) {
    return { verified: false, message: 'hash chain broken' }
  }

  // 3. 驗證 merkle（如果有 anchored）
  // ...

  // 4. 回傳結果
  return { verified: true, payload, proof: event.proof }
}
```

### 6.4 使用者遺失 passcode

**資料永久遺失。無法救援。** 這是設計取捨：平台也無法讀取，代表平台也無法救援。

---

## 7. File Upload 策略

### 7.1 什麼存哪裡

| 什麼 | 存在哪 |
|------|--------|
| 原始檔案 (PDF, doc, 照片) | 客戶自行保管 |
| file_hash（檔案 SHA-256，PHI 情境由前端計算） | 進入 payload → 進入 display_blob（加密） |
| event_type、metadata、action、params 等 | 進入 payload → 進入 display_blob（加密） |
| payload_hash（SHA-256 of payload JSON） | 存在 display_blob 裡（加密後） |
| passcode | 不存在任何地方，由使用者記憶 |
| display_blob | D1 + Polygon event log（AES 加密後的 payload + payload_hash） |
| proof、case_ref、source、timestamp | D1 明文 |

**D1 明文不存的：** payload_hash、passcode、file_hash、event_type、action、params、metadata。這些全部進 display_blob，AES 加密後才存。

### 7.2 File Hash 計算方式

```
Track H (Dashboard) — PHI 情境（預設）:
  Browser Web Crypto API: SHA-256(file) = file_hash（原始檔案不進網路）
  → POST { file_hash, event_type, metadata } 到 Server
  → Server 從未接收原始檔案
  → 目的：避免 HIPAA Business Associate 身份（不構成 "receives"）

Track H (Dashboard) — Non-PHI 情境（fallback）:
  User upload 檔案 → Backend 接收 → SHA-256(file) → 立即丟棄
  → 適用於非醫療/非法律敏感資料

Track M (API):
  Source system POST { source, action, params, metadata }
  → 無檔案上傳，只有結構化 JSON
```

### 7.3 Dashboard 顯示

```
List view（不需 passcode）:
  只顯示：timestamp、proof 前 8 碼、case_ref / source

Detail view（需 passcode + TOTP re-verify）:
  Server 解密 display_blob → 回傳完整 payload
  包含 event_type、file_hash、metadata、action、params
```

---

## 8. Database Schema

### 8.1 users

```sql
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  role              TEXT NOT NULL,             -- 'writer' | 'reader'
  stripe_customer_id TEXT,
  plan_expires_at   TEXT,
  events_used       INTEGER NOT NULL DEFAULT 0,
  api_calls_read    INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 8.2 api_keys

```sql
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  key_hash      TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  machine_only  INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 8.3 events

```sql
CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  log_type        TEXT NOT NULL,             -- 'human' | 'machine'
  case_ref        TEXT,                      -- Track H 分組
  source          TEXT,                      -- Track M 分組
  session_id      TEXT,                      -- Track M 可選
  display_blob    TEXT NOT NULL,             -- AES-256-GCM({ payload, payload_hash }, derived_key)
  nonce           TEXT NOT NULL,             -- AES nonce（搭配 display_blob）
  event_nonce     TEXT NOT NULL,             -- 隨機 UUID，加入 payload 後才算 hash chain（防 dictionary attack）
  proof           TEXT NOT NULL UNIQUE,
  previous_proof  TEXT,
  chain_position  INTEGER NOT NULL,
  merkle_proof    TEXT,                      -- JSON path，cron 後設定
  merkle_root     TEXT,
  anchored        INTEGER NOT NULL DEFAULT 0,
  tx_hash         TEXT,
  timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_owner ON events(owner_id);
CREATE INDEX idx_events_case_ref ON events(case_ref) WHERE log_type = 'human';
CREATE INDEX idx_events_source ON events(source) WHERE log_type = 'machine';
CREATE INDEX idx_events_proof ON events(proof);
```

### 8.4 cases

```sql
CREATE TABLE cases (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  case_ref        TEXT NOT NULL UNIQUE,
  title           TEXT,
  event_count     INTEGER NOT NULL DEFAULT 0,
  first_event     TEXT,
  last_event      TEXT,
  chain_integrity INTEGER NOT NULL DEFAULT 1,
  merkle_root     TEXT,
  last_anchored   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 8.5 merkle_anchors

```sql
CREATE TABLE merkle_anchors (
  id              TEXT PRIMARY KEY,
  anchor_type     TEXT NOT NULL DEFAULT 'polygon',
  merkle_root     TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  block_number    INTEGER,
  proof_count     INTEGER NOT NULL,
  event_count     INTEGER NOT NULL,
  anchor_date     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  block_confirmations INTEGER DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 8.6 shares

```sql
CREATE TABLE shares (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  proof           TEXT NOT NULL,
  recipient_email TEXT,
  token_hash      TEXT NOT NULL,
  expires_at      TEXT,
  max_uses        INTEGER DEFAULT 0,
  use_count       INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 9. Dashboard Pages

### 9.1 Route 對照

| Route | Page | Auth |
|-------|------|------|
| `/login` | Login + TOTP | 未登入 |
| `/signup` | Signup + payment | 未登入 |
| `/` | Overview（usage stats） | writer / reader |
| `/events` | Track H list（Create / Read） | writer |
| `/records` | Track M list（Read only） | writer |
| `/case/:ref` | Case chain visualization | writer（own）|
| `/billing` | Plan + usage + invoice | writer / reader |
| `/api-keys` | API key management | writer |
| `/shares` | Share management | writer |

### 9.2 Public Route

| Route | Page | Auth |
|-------|------|------|
| `/verify/shared/<token>` | Evidence verification + passcode input | 只驗 token |

---

## 10. Verification Flow UX

### 10.1 完整流程

```
Writer 在 dashboard 點擊 "Share"
  → 選擇要分享的 proof
  → 產生 share URL

Verifier 打開 URL → 輸入 passcode:

  ┌─────────────────────────────────────┐
  │         ✅ VERIFIED                  │
  │                                      │
  │   Case:  INS-CLM-042                 │
  │   Timestamp: 2026-07-18 10:00 UTC   │
  │                                      │
  │   ✓ Hash chain intact                │
  │   ✓ Merkle proof valid               │
  │   ✓ Polygon anchor confirmed         │
  │     Block: 12,345,678                │
  │                                      │
  │   [Print Report]                     │
  └─────────────────────────────────────┘
```

### 10.2 設計原則

1. **Zero installation** — 任何瀏覽器可開
2. **Zero crypto knowledge** — 只需輸入 passcode
3. **Immediate visual** — 綠色 ✅ 或紅色 ❌
4. **Printable** — `@media print` 樣式

---

## 11. Security Threat Model

| 攻擊向量 | 保護層 | 突破條件 | 風險等級 |
|---------|--------|---------|---------|
| JWT theft | Passcode-derived key | 需同時有 JWT + passcode | 🟡 Medium（passcode 不在 HTTP request header） |
| D1 SQL injection / dump | display_blob AES 加密 + Argon2id KDF | 需 passcode；離線暴力破解受 Argon2id cost + high-entropy passcode 保護 | 🟡 Medium（Argon2id 大幅提高成本，但仍非零風險） |
| Server RCE | Passcode 不持久儲存 | 需在讀取請求時攔截 in-memory key | 🟢 Low |
| Polygon tx public | display_blob AES 加密；proof 含 per-event nonce | 無 passcode 無法解密；nonce 防止 dictionary attack | 🟢 Low |
| API key leak | API key write-only | 只能寫不能讀 | 🟢 Low |
| Platform admin abuse | 無 passcode | 無法解密 | 🟢 Low |
| Brute force passcode | Rate limit (5 次/分鐘 per account) + Argon2id + high-entropy passcode | 線上百萬年；離線受 Argon2id cost 保護 | 🟢 Low |
| Proof dictionary attack | event_nonce 隨機 salt 在 display_blob 加密保護 | Polygon 上 proof 無法反向對應 payload | 🟢 Low |
| Refresh token theft | httpOnly cookie + rotation | 無法 JS 讀取，使用一次後作廢 | 🟢 Low |
| API key abuse (rate) | Rate limit (100 req/min per API key via CF Rate Limiting binding) | 超過配額暫時封鎖 | 🟢 Low |
| D1 儲存配額耗盡 | 6 個月 payload TTL；hash/proof/tx_hash 永久保留；到期 payload 歸檔 R2 | 長期高用量客戶需注意 | 🟢 Low |
| D1 資料遺失 | 每日 SQLite dump 到 R2（`wrangler d1 backup`） | 還原點最多落後 24h | 🟡 Medium |

---

## 12. Polygon 合約部署

### 12.1 合約

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ODAnchor {
    address public owner;

    event AnchorBatch(
        bytes32 indexed merkleRoot,
        bytes32[] proofs,
        bytes[]   displayBlobs,       // AES-256-GCM 加密的 payload，每 event 一個
        uint256   eventCount,
        uint256   blockNumber,
        uint256   timestamp
    );

    constructor() {
        owner = msg.sender;
    }

    function anchor(
        bytes32 _root,
        bytes32[] calldata _proofs,
        bytes[] calldata _displayBlobs
    ) external {
        require(msg.sender == owner, "only owner");
        emit AnchorBatch(_root, _proofs, _displayBlobs, _proofs.length, block.number, block.timestamp);
    }
}
```

### 12.2 部署指令

```bash
# 安裝 Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# 編譯
forge build

# Step 1: 部署到 Polygon Amoy testnet（dry run）
forge create ODAnchor \
  --rpc-url https://polygon-amoy.g.alchemy.com/v2/$ALCHEMY_KEY \
  --private-key $TESTNET_PRIVATE_KEY

# Step 2: 確認 testnet 跑通後，部署到 Polygon PoS 主網
forge create ODAnchor \
  --rpc-url https://polygon-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY \
  --private-key $DEPLOYER_PRIVATE_KEY
```

### 12.3 選擇 Polygon PoS（非 zkEVM）

| 因素 | Polygon PoS | Polygon zkEVM |
|------|------------|---------------|
| Gas 成本 | 低 (~0.1-0.5 Gwei) | 較高 |
| 鏈上資料敏感度 | display_blob 已 AES 加密，公開無風險 | zk 的隱私優勢對已加密資料無額外價值 |
| Tooling 成熟度 | Foundry 原生支援，Alchemy 完善 | 較新，出塊時間較長 |
| **結論** | ✅ 適合 | ❌ 殺雞用牛刀 |

### 12.5 環境變數

```toml
# wrangler.toml
[vars]
POLYGON_RPC_URL = "https://polygon-mainnet.g.alchemy.com/v2/your-key"
POLYGON_PRIVATE_KEY = "0x..."
POLYGON_CONTRACT_ADDRESS = "0x..."
```

建議 RPC Provider：**Alchemy free tier**（每日一筆 tx，配額用不到 1%）。

---

## 13. Dev Seed Route

用來在正式環境建立測試帳號，跳過 Stripe 付款。只在 `wrangler.toml` 設定 `SEED_SECRET` 後才啟用。

### 13.1 用法

```bash
curl -X POST https://od.workers.dev/__dev/seed \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "<SEED_SECRET>",
    "accounts": [
      { "username": "test-writer", "password": "test123", "role": "writer" },
      { "username": "test-reader", "password": "test456", "role": "reader" }
    ]
  }'
```

### 13.2 回傳

```json
{
  "created": ["test-writer", "test-reader"],
  "plan_expires": "2099-12-31T23:59:59Z",
  "warning": "Remove this route before production. These accounts skip Stripe payment."
}
```

### 13.3 安全注意

完成後刪除此 route file，不要留在 production 程式碼中。

---

## 14. Build Order

### Phase 0: Init (1 day)

- npm workspaces 初始化
- `wrangler.toml` 設定（D1 binding、compatibility flags）
- Drizzle schema 定義（全部 6 個 table）
- D1 database create + migration 腳本
- Hono app skeleton + error middleware + CORS

### Phase 1: Auth (1.5 days)

- POST /signup（含 Stripe 付款）
- POST /login + refresh token rotation
- TOTP setup + verify
- JWT middleware（access + refresh）
- API key CRUD
- Dev seed route

### Phase 2: Core Track H (2 days)

- POST /event — passcode input + hash chain linking
- GET /case/:ref/chain
- Usage tracking + plan enforcement

### Phase 3: Core Track M (1 day)

- POST /record — API/MCP only 強制
- Source grouping + session support
- machine_only API key 驗證

### Phase 4: Encryption (1 day)

- Passcode-derived key (Argon2id) logic
- Per-event nonce generation + injection
- AES-256-GCM encrypt/decrypt
- display_blob computation
- Frontend Web Crypto SHA-256（PHI 情境）

### Phase 5: Polygon (1.5 days)

- Merkle tree buildMerkleTree()
- generateMerkleProof()
- anchor cron（含 display_blobs[] 上鏈）
- Gas 失敗重試（fee-bumped retry with same nonce, DB status tracking）
- Anchor gap client return（POST /event 回傳 proof + previous_proof）
- Foundry 部署合約（Amoy testnet → Polygon PoS mainnet）
- 環境變數設定（RPC URL、private key、contract address）

### Phase 6: Verify (1 day)

- GET /verify/:proof（需 passcode）
- GET /verify/shared/:token（需 passcode input UI）
- Share token generation + validation

### Phase 7: PDF (1 day)

- @cloudflare/puppeteer
- Chain-of-custody report template
- QR code + share URL embed
- GET /case/:ref/export

### Phase 8: Dashboard (2 days)

- Login / Signup 頁面
- Events list 頁面（Track H）
- Records list 頁面（Track M read-only）
- Case chain 可視化頁面
- Billing 頁面
- API keys 管理頁面
- Shares 管理頁面

### Phase 9: Deploy + Operations (ongoing)

- Custom domain + SSL
- Workers production deploy
- Landing page (outside-docker.com)
- SEO
- Cold email law firms + robotics companies
- Monitoring + alerting（anchor failure, payment failure, error rate > 1%）
- Storage TTL cron（6 個月 payload 歸檔到 R2）
- D1 daily backup cron（SQLite dump → R2, 7 天保留）
- Docs: curl examples, MCP agent integration guide

## 15. EU AI Act Compliance

OD 的技術設計對應歐盟 AI Act 的關鍵條文：

| Article | 要求 | OD 對應 |
|---------|------|---------|
| Art. 12(3) | 防止未經授權的修改 | Layer 3 Polygon anchor 提供不可變時間戳 |
| Art. 19 | 6 個月日誌保留 | D1 storage + 6-month TTL + R2 archive |
| Art. 19(2) | 主管機關可取用日誌 | Share token + passcode model，zero-install 驗證頁面 |
| Art. 20 | 糾正措施 | Hash chain 可檢測竄改；違反 integrity 時 report 標示 |
| GDPR Art. 17 | 刪除權（被遺忘權） | display_blob 加密設計：刪除 passcode 等於資料永久不可讀，不需實體刪除 D1 row |
| Art. 50(1) | 透明度義務 | 驗證結果（chain integrity、anchored、Polygon tx）皆在 PDF 上可見 |

---

> *This document synthesizes the product spec (od.md) and subsequent architectural discussions into an actionable build blueprint.*
