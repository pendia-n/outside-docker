# OD_TODO.md — Outside Docker 行動手冊
## 2026年7月 → 2027年6月 | 時間序列證據不可篡改存儲+驗證系統

---

# SWOT Analysis / SWOT 分析

## Strengths / 優勢
- **S1** — 零AI依賴，核心是密碼學（hash鏈 + 時間戳 + merkle root上鏈），不受AI市場波動影響
- **S2** — 差異化明確：可驗證的事件鏈（非單一文件戳記），修改任一個→整條鏈斷裂
- **S3** — 區塊鏈證據已在多國獲法院認可（中國最高法院2018、美國、EU、意大利、法國）
- **S4** — 與Omega共享核心密碼學引擎IP（hash鏈+merkle root+區塊鏈錨定），開發效率倍增

## Weaknesses / 劣勢
- **W1** — 概念階段，零repo，零代碼
- **W2** — 法律+技術雙重專業門檻高（需同時懂密碼學和證據法）
- **W3** — 客戶決策週期極長（律師事務所極度保守，採購週期6-18個月）
- **W4** — 單人開發，無法律背景

## Opportunities / 機會
- **O1** — Frontiers in Blockchain學術期刊2026年確認區塊鏈在民事訴訟中的證據價值
- **O2** — Bernstein.io已獲法院認可，市場教育已完成一部分
- **O3** — AI時代的信任赤字只會增加 → 時間序列證據需求指數級增長
- **O4** — Physical AI機器人部署 = 驗證需求從人類擴展到機器，市場天花板打開
- **O5** — 法律科技市場未被巨頭壟斷，缺口明確

## Threats / 威脅
- **T1** — Bernstein.io已有先發優勢和法院案例
- **T2** — DocuSign/Adobe Sign可能擴展功能覆蓋區塊鏈公證
- **T3** — 各國電子證據法規變動風險（例如某國突然不承認區塊鏈證據）
- **T4** — 自建門檻對大律師事務所不算太高（他們有IT部門）

---

# 四維行動要點 / Four-Dimension Action Points

---

## 一、政策 / Policy

### 2026年7-9月
- [ ] **P1** — 追蹤各國電子證據法最新動態（中國區塊鏈證據司法解釋更新、美國聯邦證據規則702條修正）
  - *EN: Track e-evidence law updates globally (China blockchain evidence rules, US FRE 702 amendments)*
- [ ] **P2** — 研究eIDAS 2.0（歐盟電子身分認證框架）對信任服務的影響
  - *EN: Research eIDAS 2.0 impact on trust services*

### 2026年10-12月
- [ ] **P3** — 建立法律合規文檔框架：chain of custody標準格式、hash證明模板、時間戳匯出規範
  - *EN: Build legal compliance doc framework: chain of custody format, hash proof template, timestamp export spec*
- [ ] **P4** — 確定目標市場的證據法要求（新加坡、美國、歐盟優先。中港澳為最低優先級市場，不列入）
  - *EN: Determine evidence law requirements in target markets (SG, US, EU first. CN/HK/MO deprioritized)*

### 2027年1-6月
- [ ] **P5** — 與1家律師事務所的合夥人做深度訪談，了解法庭實際接受的證據格式
  - *EN: Deep interview with 1 law firm partner on court-accepted evidence formats*
- [ ] **P6** — 準備一份「OD技術白皮書」用於向法律專業人士解釋技術原理（非技術語言）
  - *EN: Prepare OD technical whitepaper in non-technical language for legal professionals*

---

## 二、收入 / Revenue

### 2026年7-12月 — 不追求收入，專注驗證
- [ ] **R1** — 零收入預期。此階段唯一目標：確認律師事務所是否願意為此付費
  - *EN: Zero revenue expectation. Only goal: validate law firm willingness to pay*
- [ ] **R2** — 訪談3-5家律師事務所（合約/訴訟部門），記錄痛點和付費意願
  - *EN: Interview 3-5 law firms (contract/litigation depts), document pain points and WTP*

### 2027年1-6月 — 若驗證通過，開始MVP
- [ ] **R3** — 若有明確付費信號，開始MVP開發（密碼學hash + 時間戳 + 區塊鏈錨定）
  - *EN: If clear willingness-to-pay signal, begin MVP development*
- [ ] **R4** — 定價模型研究：$500-2000/月 SaaS 或 $50-200/次按量計費
  - *EN: Pricing model research: $500-2K/mo SaaS vs $50-200 per-use*
- [ ] **R5** — 目標：1家設計合作夥伴（design partner），不是付費客戶，是共同開發的早期採用者
  - *EN: Goal: 1 design partner — not paying client, but co-development early adopter*

---

## 三、流行與技能 / Popularity & Skills

### 2026年7-9月
- [ ] **S1** — 學習密碼學基礎：SHA-256、Merkle Tree、區塊鏈錨定機制
  - *EN: Learn crypto fundamentals: SHA-256, Merkle Tree, blockchain anchoring*
- [ ] **S2** — 學習證據法基礎：chain of custody定義、各國法院接受的證據格式
  - *EN: Learn evidence law basics: chain of custody, accepted formats across jurisdictions*

### 2026年10-12月
- [ ] **S3** — 建立OD概念驗證（CLI工具）：命令行輸入文件→輸出hash鏈+merkle root
  - *EN: Build OD proof-of-concept CLI: input file → output hash chain + merkle root*
- [ ] **S4** — 在LegalTech社群/論壇發布技術思路，收集回饋（非行銷，純技術驗證）
  - *EN: Post technical concept in LegalTech forums for feedback (not marketing)*

### 2027年1-6月
- [ ] **S5** — LegalTech展會觀察（不參展，只觀摩，了解市場成熟度）
  - *EN: Attend LegalTech conference as observer*
- [ ] **S6** — 評估是否將OD核心密碼學引擎開源（建立信任，降低客戶採用門檻）
  - *EN: Evaluate open-sourcing OD core crypto engine (build trust, lower adoption barrier)*

---

## 四、靈活對策 / Countermeasures

### 若律師事務所訪談顯示付費意願低
- **CM1** — 轉向保險公司（理賠時間線驗證）或電商平台（交易糾紛證據鏈）
  - *EN: Pivot to insurance (claims timeline) or e-commerce (dispute evidence chain)*
- **CM2** — 將OD降級為Omega的附屬功能，合併到驗證引擎LLC中不對外銷售
  - *EN: Downgrade OD to Omega accessory, merge into Verification Engine LLC, no external sales*

### 若開發進度慢
- **CM3** — MVP只做核心：hash鏈+時間戳。merkle root上鏈和chain of custody PDF推遲到v2
  - *EN: MVP core only: hash chain + timestamp. Defer merkle root anchoring and PDF export to v2*

### 若Bernstein.io佔據市場
- **CM4** — 差異化攻擊點：Bernstein只做單文件戳記，OD做事件鏈。強調「修改一個節點→整鏈斷裂」
  - *EN: Attack Bernstein's weakness: single-file stamping vs OD's chain-of-events integrity*

### 若某國不承認區塊鏈證據
- **CM5** — 不要鎖定單一市場。先在新加坡（普通法+科技友善）和歐盟（eIDAS 2.0框架）雙線布局。中港澳不列入
  - *EN: Don't single-market lock-in. Dual-track Singapore (common law+tech-friendly) and EU (eIDAS 2.0 framework). CN/HK/MO excluded*

---

## 時間線總覽 / Timeline Overview

```
2026 Jul ─ 密碼學+證據法學習
     Aug ─ LegalTech市場研究
     Sep ─ CLI概念驗證開始
     Oct ─ 律師事務所訪談開始（安排在高能量日）
     Nov ─ 訪談回饋整理
     Dec ─ 決定是否進入MVP階段

2027 Jan ─ 若Go：MVP開發開始
     Mar ─ 尋找design partner
     May ─ 若No Go：資源轉移到FM/SK
     Jun ─ H1結算：OD go/no-go最終決策
```

---

> **OD是地基地產品（土），但它的商業價值取決於律師事務所是否願意付錢。先問，再建。**
> *OD is foundational (earth), but its commercial value depends on lawyers paying. Ask first, build later.*
