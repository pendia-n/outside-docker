const Brand = () => (
  <a class="brand" href="/" aria-label="Outdock home">
    <img class="brand-logo" src="/od.svg" alt="" />
    <span>Outdock</span>
  </a>
)

export const LandingPage = () => (
  <main data-page="landing">
    <nav class="nav" aria-label="Primary navigation">
      <Brand />
      <div class="nav-links">
        <a href="#how">How it works</a>
        <a href="#tracks">Tracks</a>
        <a href="/verify">Verify</a>
        <a href="#faq">FAQ</a>
        <a class="nav-login" href="#login-card">Sign in</a>
        <a class="button button-small" href="#register-card">Get started</a>
      </div>
    </nav>

    <section id="top" class="hero-wrap">
      <div class="hero-copy">
        <p class="eyebrow">EVENT-CHAIN INTEGRITY FOR THE REAL WORLD</p>
        <h1>Make every record<br /><em>defensible.</em></h1>
        <p class="hero-lede">Outdock preserves the integrity of human documents and machine logs without storing the original content by default. Capture what happened. Prove what changed. Show the chain.</p>
        <div class="hero-actions">
          <a class="button" href="#register-card">Create your account <span>→</span></a>
          <a class="text-link" href="/verify">Verify a shared proof <span>↗</span></a>
        </div>
        <p class="micro-note"><span class="status-dot"></span> Local commitments · signed receipts · Base batch anchors</p>
      </div>
      <div class="hero-art" aria-label="An intact four-event proof chain">
        <div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
        <div class="proof-card">
          <div class="proof-top"><span class="live-dot"></span><span>CHAIN STATUS</span><strong>INTACT</strong></div>
          <div class="proof-line"><span class="node active"></span><span class="line"></span><span class="node active"></span><span class="line"></span><span class="node active"></span><span class="line"></span><span class="node active"></span></div>
          <div class="proof-meta"><span>CAPTURED</span><span>LINKED</span><span>RECEIPTED</span><span>ANCHORED</span></div>
          <div class="proof-hash">sha256 · receipt · merkle · base</div>
        </div>
      </div>
    </section>

    <section class="trust-strip"><span>BUILT FOR EVIDENCE THAT NEEDS TO LAST</span><div><span>LEGAL &amp; COMPLIANCE</span><span>INSURANCE</span><span>ROBOTICS</span><span>INVESTIGATIONS</span></div></section>

    <section id="how" class="section">
      <div class="section-intro"><p class="eyebrow">ONE RECORD. THREE LAYERS.</p><h2>Integrity you can explain<br />to anyone.</h2><p>Outdock separates content equality, sequence integrity, and independent anchoring so every result can show exactly what passed or failed.</p></div>
      <div class="feature-grid">
        <article class="feature-card"><span class="feature-number">01</span><h3>Capture privately</h3><p>Your browser or gateway hashes exact bytes or canonical JSON. Original content remains under your control.</p></article>
        <article class="feature-card"><span class="feature-number">02</span><h3>Link the sequence</h3><p>A Durable Object assigns every position and previous proof, preventing concurrent appends from forking a chain.</p></article>
        <article class="feature-card"><span class="feature-number">03</span><h3>Anchor independently</h3><p>Signed receipts arrive immediately. Merkle batches later add a Base transaction and independently verifiable membership proof.</p></article>
      </div>
    </section>

    <section id="tracks" class="split-section">
      <div class="split-panel terracotta"><p class="eyebrow light">TRACK H · HUMAN RECORDS</p><h2>For documents that may matter later.</h2><p>Create a case, hash a local file, append corrections without overwriting history, and download a passcode-protected proof package.</p><a class="light-link" href="#register-card">Start Track H <span>→</span></a></div>
      <div class="split-panel sage"><p class="eyebrow">TRACK M · MACHINE RECORDS</p><h2>For systems that never stop producing data.</h2><p>Create scoped API keys and stable sources in the dashboard. Gateways submit idempotent machine records; the dashboard remains read-only.</p><a class="dark-link" href="#register-card">Start Track M <span>→</span></a></div>
    </section>

    <section class="section steps-section">
      <div class="section-intro"><p class="eyebrow">FROM CAPTURE TO PROOF</p><h2>A clear record of<br />what happened.</h2></div>
      <div class="steps">
        <div><span>1</span><h3>Commit</h3><p>Generate a content hash, random record salt, and domain-separated commitment locally.</p></div>
        <div><span>2</span><h3>Receive</h3><p>Receive an Ed25519-signed receipt and build the encrypted <code>.odproof</code> locally.</p></div>
        <div><span>3</span><h3>Verify</h3><p>Validate receipt, hash-chain, Merkle membership, and anchor without exposing unrelated records.</p></div>
      </div>
    </section>

    <section id="access" class="access-section">
      <div><p class="eyebrow light">READY WHEN YOU ARE</p><h2>Start with a private<br />integrity record.</h2><p>Accounts activate immediately. Verifier access activates only after a server-verified Stripe payment for the selected event type and time window.</p></div>
      <div class="access-card">
        <div class="access-tabs" role="tablist"><a class="active" href="#register-card" role="tab">Create account</a><a href="#login-card" role="tab">Sign in</a></div>
        <section id="register-card">
          <form id="register" novalidate>
            <label>Username<input name="username" required pattern="[a-z0-9_-]{3,32}" autocomplete="username" /></label><p id="availability" class="hint" aria-live="polite"></p>
            <label>Password<input name="password" type="password" required minLength={7} maxLength={18} autocomplete="new-password" /></label><p id="password-validity" class="hint" aria-live="polite">Use 7–18 characters with at least one letter and one number.</p>
            <label>Email <span class="optional">optional Gmail or Hotmail recovery</span><input name="email" type="email" autocomplete="email" /></label>
            <label>Role<select name="role"><option value="supplier">Supplier</option><option value="verifier">Verifier</option></select></label>
            <div id="supplier-fields">
              <label>Initial mode<select name="initial_mode"><option value="H">Track H</option><option value="M">Track M</option><option value="both">Both</option></select></label>
              <p class="field-note">Choose the records this Supplier account can create. Organization and billing details are completed after sign-in.</p>
            </div>
            <div id="verifier-fields" hidden><p class="field-note">Create your Verifier account first. Invitations, event selection, and payment happen inside your workspace.</p></div>
            <button class="button" type="submit">Continue securely <span>→</span></button>
          </form>
          <div id="register-result" class="form-result" aria-live="polite"></div>
        </section>
        <section id="login-card" class="login-panel">
          <h3>Welcome back</h3>
          <form id="login"><label>Username<input name="username" required autocomplete="username" /></label><label>Password<input name="password" type="password" required autocomplete="current-password" /></label><label id="totp-login-field" hidden>Authenticator or recovery code<input name="totp_code" autocomplete="one-time-code" /></label><button class="button" type="submit">Sign in <span>→</span></button></form>
          <div id="login-result" class="form-result" aria-live="polite"></div>
        </section>
      </div>
    </section>

    <section id="faq" class="faq-section">
      <div class="section-intro"><p class="eyebrow">QUESTIONS, ANSWERED</p><h2>Good records deserve<br />clear explanations.</h2></div>
      <div class="faq-list">
        <details open><summary>Does Outdock store my original file?</summary><p>No, not by default. Track H hashes the selected file in your browser. Track M accepts hashes or ephemeral structured content; original files are never retained by the evidence API.</p></details>
        <details><summary>Does a valid proof mean the content is true?</summary><p>No. It proves capture and post-capture integrity. Truthfulness, authorship, and capture quality remain separate questions.</p></details>
        <details><summary>What is paid and what is free?</summary><p>Supplier writing requires an active plan. A Verifier can buy a fixed historical range in seven-day units or subscribe for a 30-day lookback plus 28 days of live access. Anyone can validate a deliberately shared portable proof for free.</p></details>
        <details><summary>What happens before Base confirmation?</summary><p>The signed receipt and hash chain are valid immediately and clearly marked pending. Anchoring later adds Merkle and Base evidence.</p></details>
      </div>
    </section>

    <footer class="footer"><Brand /><p>Integrity infrastructure for human and machine records.</p><div><a href="mailto:pendia-community@protonmail.com">pendia-community@protonmail.com</a><a href="mailto:earthlyfirely@gmail.com">earthlyfirely@gmail.com</a></div><small>© 2026 Outdock · Integrity preservation, not a truth guarantee.</small></footer>
  </main>
)

const AppPanel = ({ id, title, eyebrow, children, active = false }: { id: string; title: string; eyebrow: string; children: any; active?: boolean }) => (
  <section class={`app-view${active ? ' active' : ''}`} id={`view-${id}`} data-view={id}>
    <header class="view-header"><div><p class="eyebrow">{eyebrow}</p><h1>{title}</h1></div><p class="view-context" id={`${id}-context`}></p></header>
    {children}
  </section>
)

export const ApplicationPage = ({ role, supplierMode }: { role: 'supplier' | 'verifier'; supplierMode?: 'H' | 'M' | 'both' | null }) => (
  <main class="app-shell" data-page="app" data-role={role}>
    <aside class="app-sidebar">
      <Brand />
      <nav class="app-nav" aria-label="Application">
        <button class="active" data-target="overview">Overview</button>
        {role === 'supplier' && (supplierMode === 'H' || supplierMode === 'both') && <button data-target="human" data-mode="H">Track H</button>}
        {role === 'supplier' && (supplierMode === 'M' || supplierMode === 'both') && <button data-target="machine" data-mode="M">Track M</button>}
        {role === 'verifier' && <button data-target="verifier">Event access</button>}
        {role === 'supplier' && <button data-target="proofs">Proofs &amp; sharing</button>}
        <button data-target="billing">Billing</button>
        <button data-target="security">Security</button>
      </nav>
      <div class="sidebar-foot"><span id="environment-badge" class="env-badge">loading</span><button id="logout" class="quiet-button">Sign out</button></div>
    </aside>
    <div class="app-main">
      <div id="app-notice" class="app-notice" hidden aria-live="polite"></div>

      <AppPanel id="overview" title="Integrity workspace" eyebrow="CURRENT STATE" active>
        <div class="metric-grid"><article><span>Cases</span><strong id="metric-cases">—</strong></article><article><span>Sources</span><strong id="metric-sources">—</strong></article><article><span>Events</span><strong id="metric-events">—</strong></article><article><span>Anchor health</span><strong id="metric-anchors">—</strong></article></div>
        <div class="dashboard-grid"><section class="surface"><h2>Recent receipts</h2><div id="recent-receipts" class="empty-state">No receipts loaded.</div></section><section class="surface"><h2>Access</h2><div id="account-summary" class="key-value"></div></section></div>
      </AppPanel>

      {role === 'supplier' && (supplierMode === 'H' || supplierMode === 'both') && <AppPanel id="human" title="Human evidence" eyebrow="TRACK H">
        <div class="dashboard-grid human-grid">
          <section class="surface"><div class="surface-title"><h2>Cases</h2><button class="quiet-button" data-dialog="case-form">New case</button></div><form id="case-form" class="compact-form" hidden><label>Case reference<input name="case_ref" required /></label><label>Title<input name="title" required /></label><label>Category<input name="category" /></label><label>Description<textarea name="description" rows={3}></textarea></label><button class="button button-small">Create case</button></form><div id="case-list" class="record-list"></div></section>
          <section class="surface"><div class="surface-title"><h2 id="case-title">Select a case</h2><button class="quiet-button" data-dialog="event-form" disabled id="add-event-button">Add record</button></div><form id="event-form" class="compact-form" hidden><label>Event type<select name="event_type_ref" class="event-type-select" required></select></label><label>Action / status<input name="event_type" required placeholder="DELIVERED" /></label><label>Occurred at<input name="occurred_at" type="datetime-local" /></label><label>Local file <span class="optional">never uploaded</span><input name="file" type="file" /></label><label>Or structured note<textarea name="structured_text" rows={3}></textarea></label><label>Portable-proof passcode<input name="passcode" type="password" required autocomplete="new-password" /></label><label>Corrects event <span class="optional">optional ID</span><input name="corrects_event_id" /></label><button class="button button-small">Hash and append</button></form><div id="case-timeline" class="timeline empty-state">Select a case to inspect its append-only timeline.</div></section>
        </div>
      </AppPanel>}

      {role === 'supplier' && (supplierMode === 'M' || supplierMode === 'both') && <AppPanel id="machine" title="Machine records" eyebrow="TRACK M · API OPERATIONS">
        <div class="dashboard-grid"><section class="surface"><div class="surface-title"><h2>API keys</h2><button class="quiet-button" data-dialog="api-key-form">Create key</button></div><form id="api-key-form" class="compact-form" hidden><label>Label<input name="label" required /></label><fieldset><legend>Scopes</legend><label class="check-row"><input type="checkbox" name="scopes" value="source:write" checked /> source:write</label><label class="check-row"><input type="checkbox" name="scopes" value="record:write" checked /> record:write</label><label class="check-row"><input type="checkbox" name="scopes" value="record:batch" /> record:batch</label><label class="check-row"><input type="checkbox" name="scopes" value="receipt:read" checked /> receipt:read</label><label class="check-row"><input type="checkbox" name="scopes" value="usage:read" checked /> usage:read</label></fieldset><button class="button button-small">Create once-visible key</button></form><div id="api-key-result" class="secret-result" hidden></div><div id="api-key-list" class="record-list"></div></section><section class="surface"><div class="surface-title"><h2>Sources</h2><button class="quiet-button" data-dialog="source-form">Register source</button></div><form id="source-form" class="compact-form" hidden><label>Source reference<input name="source_id" required placeholder="drone-07" /></label><label>Label<input name="label" required /></label><label>Sequence policy<select name="out_of_order_policy"><option value="strict">Strict</option><option value="accept_and_flag">Accept and flag</option></select></label><button class="button button-small">Register source</button></form><div id="source-list" class="record-list"></div></section></div>
        <section class="surface app-wide"><div class="surface-title"><h2>Machine event stream</h2><span id="machine-usage" class="hint">Submitted only through the API</span></div><div id="machine-events" class="timeline empty-state">No machine records loaded.</div></section>
      </AppPanel>}

      {role === 'verifier' && <AppPanel id="verifier" title="Purchased event access" eyebrow="VERIFIER WORKSPACE">
        <div class="dashboard-grid">
          <section class="surface"><h2>Accept Supplier invitation</h2><form id="invitation-accept-form" class="compact-form"><label>Invitation token<input name="token" required autocomplete="off" /></label><button class="button button-small">Accept invitation</button></form><h2 class="subsection-title">Available event access</h2><div id="verifier-offer-list" class="record-list"></div></section>
          <section class="surface"><h2 id="verifier-purchase-title">Select an event offer</h2><form id="verifier-purchase-form" class="compact-form" hidden><input name="offer_id" type="hidden" /><input name="access_model" type="hidden" /><div id="verifier-range-fields"><label>Range starts (your local time)<input name="range_start" type="datetime-local" /></label><label>Range ends, exclusive (your local time)<input name="range_end" type="datetime-local" /></label></div><button type="button" id="verifier-quote" class="quiet-button">Calculate exact price</button><div id="verifier-quote-result" class="secret-result" hidden></div><button class="button button-small" disabled id="verifier-checkout">Continue to Stripe</button></form><p class="hint">One-time: $25 per started 7-day unit; the seventh and later units are 50% off. Subscription: $88 for a 30-day lookback and 28 days of live access.</p></section>
        </div>
        <section class="surface app-wide"><div class="surface-title"><h2>Active and previous grants</h2><span class="hint">Web review only · no download</span></div><div id="verifier-grant-list" class="record-list"></div><div id="verifier-grant-detail" class="timeline empty-state">Choose an active grant to inspect its events.</div></section>
      </AppPanel>}

      {role === 'supplier' && <AppPanel id="proofs" title="Proofs and controlled sharing" eyebrow="SUPPLIER EVIDENCE">
        <div class="dashboard-grid"><section class="surface"><h2>Verify locally</h2><form id="workspace-verify-form" class="compact-form"><label>.odproof package<input name="proof_file" type="file" accept=".odproof,application/json" required /></label><label>Passcode<input name="passcode" type="password" /></label><label>Original file <span class="optional">optional comparison</span><input name="original_file" type="file" /></label><button class="button button-small">Verify every layer</button></form><div id="workspace-verify-result" class="verification-result"></div></section><section class="surface"><div class="surface-title"><h2>Shares</h2><button class="quiet-button" data-dialog="share-form">New share</button></div><form id="share-form" class="compact-form" hidden><label>Evidence scope<select name="scope_id" id="share-scope-select"></select></label><label>Expires in days<input name="expires_days" type="number" min="1" max="365" value="30" /></label><button class="button button-small">Create share link</button></form><div id="share-result" class="secret-result" hidden></div><div id="share-list" class="record-list"></div></section></div>
        <div class="dashboard-grid app-wide"><section class="surface"><div class="surface-title"><h2>Event types</h2><button class="quiet-button" data-dialog="event-type-form">New type</button></div><form id="event-type-form" class="compact-form" hidden><label>Stable reference<input name="event_type_ref" required placeholder="food-delivery" /></label><label>Display name<input name="name" required placeholder="Made Food Delivery" /></label><label>Description<textarea name="description" rows={2}></textarea></label><button class="button button-small">Create event type</button></form><div id="event-type-list" class="record-list"></div></section><section class="surface"><h2>Invite a Verifier</h2><form id="supplier-invitation-form" class="compact-form"><label>Event type<select name="event_type_ref" id="invitation-event-type" required></select></label><button class="button button-small">Create private invitation</button></form><div id="supplier-invitation-result" class="secret-result" hidden></div><p class="hint">The token grants no data by itself. The Verifier must accept it and complete Stripe Checkout.</p></section></div>
      </AppPanel>}

      <AppPanel id="billing" title={role === 'supplier' ? 'Supplier plan' : 'Purchases and access'} eyebrow="BILLING">
        <div class="dashboard-grid"><section class="surface"><h2>Current entitlements</h2><div id="entitlement-list" class="record-list"></div></section>{role === 'supplier' ? <section class="surface" id="supplier-billing-controls"><h2>Manage plan</h2><p>Production checkout is hosted by Stripe. Payment methods are selected dynamically from your Stripe settings.</p><form id="billing-checkout" class="compact-form"><label>Plan<select name="plan_code"><option value="A">A · $99/month</option><option value="B">B · $299/month</option><option value="C">C · $799/month</option><option value="D">D · $1,999/month</option></select></label><button class="button button-small">Open secure checkout</button></form><button id="billing-portal" class="quiet-button">Open customer portal</button></section> : <section class="surface" id="verifier-billing-note"><h2>No active invitation selected</h2><p>Accept a Supplier invitation, choose an event and time range, then review the server-calculated price before Stripe Checkout.</p></section>}</div>
      </AppPanel>

      <AppPanel id="security" title="Account security" eyebrow="SECURITY">
        <div class="dashboard-grid"><section class="surface"><h2>Authenticator app</h2><div id="totp-state"></div><form id="totp-start"><button class="button button-small">Start TOTP enrollment</button></form><div id="totp-enrollment" hidden><p>Scan this QR code in an authenticator app or enter the manual secret.</p><img id="totp-qr" class="totp-qr" alt="TOTP enrollment QR code" hidden /><code id="totp-uri"></code><form id="totp-confirm" class="compact-form"><label>Six-digit code<input name="code" inputmode="numeric" required /></label><button class="button button-small">Confirm and enable</button></form><div id="recovery-codes" class="secret-result"></div></div></section><section class="surface"><h2>Session</h2><p>Protected requests recheck account, role, environment, session version, and entitlement state.</p><button id="revoke-sessions" class="quiet-button">Revoke other sessions</button></section></div>
      </AppPanel>
    </div>
  </main>
)

export const VerifyPage = ({ shareToken = '' }: { shareToken?: string }) => (
  <main class="verify-shell" data-page="verify" data-share-token={shareToken}>
    <nav class="nav"><Brand /><div class="nav-links"><a href="/">Product</a><a class="button button-small" href="/#login-card">Sign in</a></div></nav>
    <section class="verify-hero"><p class="eyebrow">FREE SHARED VERIFICATION</p><h1>Inspect the proof,<br /><em>not a black box.</em></h1><p>Verification happens in this browser. A shared artifact grants no access to unrelated supplier data.</p></section>
    <section class="verify-workspace">
      <form id="public-verify-form" class="surface compact-form"><label>.odproof package<input name="proof_file" type="file" accept=".odproof,application/json" /></label><label>Passcode <span class="optional">if encrypted</span><input name="passcode" type="password" /></label><label>Original file <span class="optional">optional content comparison</span><input name="original_file" type="file" /></label><button class="button">Verify proof <span>→</span></button></form>
      <section id="public-verify-result" class="surface verification-result"><div class="empty-state">Choose a portable proof or open a supplier share link.</div></section>
    </section>
    <section class="verification-explainer"><article><span>1</span><h2>Receipt</h2><p>Checks the public-key signature over the exact canonical receipt.</p></article><article><span>2</span><h2>Sequence</h2><p>Recomputes content and event proofs from the included chain material.</p></article><article><span>3</span><h2>Anchor</h2><p>Checks Merkle membership and the published Base batch reference when available.</p></article></section>
  </main>
)

export const CheckoutStatusPage = ({ state }: { state: 'success' | 'cancelled' }) => (
  <main class="status-page" data-page="checkout-status"><section class="surface"><Brand /><p class="eyebrow">{state === 'success' ? 'PAYMENT RECEIVED' : 'CHECKOUT CANCELLED'}</p><h1>{state === 'success' ? 'Activation is being confirmed.' : 'Nothing was charged.'}</h1><p>{state === 'success' ? 'Stripe will send a signed webhook. Your account or entitlement becomes active only after that webhook is processed.' : 'You can return and restart checkout whenever you are ready.'}</p><a class="button" href={state === 'success' ? '/#login-card' : '/#register-card'}>{state === 'success' ? 'Continue to sign in' : 'Return to registration'}</a></section></main>
)
