import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { renderer } from './renderer'
import { contentCommitment, eventProof, passwordHash, randomHex, signJwt, verifyJwt, verifyPassword } from './crypto'
import type { Env, Role, SessionClaims } from './types'

const app = new Hono<{ Bindings: Env }>()
app.onError((error, c) => {
  console.error(error)
  return c.json({ error: c.env.ENV === 'dev' ? error.message : 'Internal Server Error' }, 500)
})
app.use(renderer)

function db(c: { env: Env }): D1Database {
  return c.env.ENV === 'prod' ? c.env.DB_PROD : c.env.DB_DEV
}
function contractAddress(c: { env: Env }): string {
  return c.env.ENV === 'prod' ? c.env.POLYGON_CONTRACT_ADDRESS_PROD : c.env.POLYGON_CONTRACT_ADDRESS_DEV
}

const USERNAME = /^[a-z0-9_-]{3,32}$/
const PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{7,}$/

function nowSeconds() { return Math.floor(Date.now() / 1000) }
function normalizeUsername(value: string) { return value.trim().toLowerCase() }
function jsonError(c: any, message: string, status = 400) { return c.json({ error: message }, status) }

async function session(c: any): Promise<SessionClaims | null> {
  const token = getCookie(c, 'od_session')
  return token ? verifyJwt(token, c.env.JWT_SECRET) : null
}

app.get('/health', (c) => c.json({ ok: true, app: 'outside-docker', env: c.env.ENV, db: Boolean(db(c)), polygon_chain_id: c.env.POLYGON_CHAIN_ID }))

app.get('/api/username/:username', async (c) => {
  const username = normalizeUsername(c.req.param('username'))
  if (!USERNAME.test(username)) return c.json({ available: false, reason: 'invalid' })
  const row = await db(c).prepare('SELECT 1 FROM users WHERE username = ? LIMIT 1').bind(username).first()
  return c.json({ available: !row })
})

app.post('/api/register', async (c) => {
  if (c.env.ENV !== 'dev') return jsonError(c, 'Production registration requires payment webhook; not enabled in Phase 1', 402)
  const body = await c.req.json<Partial<{ username: string; password: string; email: string; role: Role; organization: string; address_line1: string; city: string; postal_code: string; country: string }>>()
  const username = normalizeUsername(body.username ?? '')
  const password = body.password ?? ''
  const role = body.role
  if (!USERNAME.test(username)) return jsonError(c, 'Username must be 3-32 lowercase letters, numbers, _ or -')
  if (!PASSWORD.test(password)) return jsonError(c, 'Password requires upper, lower, digit, symbol and minimum length 7')
  if (role !== 'supplier' && role !== 'verifier') return jsonError(c, 'Role must be supplier or verifier')
  if (role === 'supplier' && (!body.organization || !body.address_line1 || !body.city || !body.postal_code || !body.country)) return jsonError(c, 'Supplier organization and address are required')
  const exists = await db(c).prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()
  if (exists) return jsonError(c, 'Username is already registered', 409)
  const id = crypto.randomUUID()
  const hash = await passwordHash(password)
  const statements = [db(c).prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)').bind(id, username, body.email?.trim() || null, hash, role)]
  if (role === 'supplier') statements.push(db(c).prepare('INSERT INTO organizations (id, user_id, legal_name, address_line1, city, postal_code, country) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), id, body.organization, body.address_line1, body.city, body.postal_code, body.country))
  await db(c).batch(statements)
  return c.json({ created: true, username, role }, 201)
})

app.post('/api/login', async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>()
  const username = normalizeUsername(body.username ?? '')
  const user = await db(c).prepare('SELECT id, username, password_hash, role, is_active FROM users WHERE username = ?').bind(username).first<{ id: string; username: string; password_hash: string; role: Role; is_active: number }>()
  if (!user || !user.is_active || !(await verifyPassword(body.password ?? '', user.password_hash))) return jsonError(c, 'Invalid credentials', 401)
  const iat = nowSeconds()
  const claims: SessionClaims = { sub: user.id, username: user.username, role: user.role, type: 'session', iat, exp: iat + 28 * 24 * 60 * 60 }
  const token = await signJwt(claims, c.env.JWT_SECRET)
  setCookie(c, 'od_session', token, { httpOnly: true, secure: c.env.ENV === 'prod', sameSite: 'Strict', path: '/', maxAge: 28 * 24 * 60 * 60 })
  return c.json({ logged_in: true, username: user.username, role: user.role })
})

app.post('/api/logout', (c) => { deleteCookie(c, 'od_session', { path: '/' }); return c.json({ logged_out: true }) })

app.get('/api/session', async (c) => { const claims = await session(c); return claims ? c.json({ authenticated: true, claims }) : c.json({ authenticated: false }, 401) })

app.post('/api/commitment', async (c) => {
  const claims = await session(c)
  if (!claims) return jsonError(c, 'Login required', 401)
  const body = await c.req.json<{ track?: 'H' | 'M'; chain_ref?: string; commitment?: string; manifest_hash?: string; encrypted_capsule?: string }>()
  if (body.track !== 'H' && body.track !== 'M') return jsonError(c, 'track must be H or M')
  if (!body.chain_ref || !body.commitment || !body.manifest_hash) return jsonError(c, 'chain_ref, commitment and manifest_hash are required')
  const chain = await db(c).prepare('SELECT id, previous_proof, next_position FROM chains WHERE owner_id = ? AND track = ? AND external_ref = ?').bind(claims.sub, body.track, body.chain_ref).first<{ id: string; previous_proof: string | null; next_position: number }>()
  const chainId = chain?.id ?? crypto.randomUUID()
  const previousProof = chain?.previous_proof ?? null
  const position = chain?.next_position ?? 1
  const createdAt = new Date().toISOString()
  const proof = await eventProof(body.commitment, previousProof, position, createdAt)
  const eventId = crypto.randomUUID()
  const receipt = JSON.stringify({ version: '1', event_id: eventId, chain_id: chainId, position, commitment: body.commitment, manifest_hash: body.manifest_hash, previous_proof: previousProof, proof, created_at: createdAt })
  const signature = await signJwt({ sub: eventId, username: 'receipt', role: claims.role, type: 'session', iat: nowSeconds(), exp: nowSeconds() + 315360000 } as SessionClaims, c.env.JWT_SECRET)
  const statements = []
  if (!chain) statements.push(db(c).prepare('INSERT INTO chains (id, owner_id, track, external_ref, previous_proof, next_position) VALUES (?, ?, ?, ?, ?, ?)').bind(chainId, claims.sub, body.track, body.chain_ref, proof, 2))
  else statements.push(db(c).prepare('UPDATE chains SET previous_proof = ?, next_position = ? WHERE id = ?').bind(proof, position + 1, chainId))
  statements.push(db(c).prepare('INSERT INTO events (id, chain_id, owner_id, position, commitment, manifest_hash, encrypted_capsule, previous_proof, proof, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(eventId, chainId, claims.sub, position, body.commitment, body.manifest_hash, body.encrypted_capsule ?? null, previousProof, proof, createdAt))
  statements.push(db(c).prepare('INSERT INTO receipts (id, event_id, receipt_json, signature, signing_key_id) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), eventId, receipt, signature, 'dev-jwt-hs256'))
  await db(c).batch(statements)
  return c.json({ event_id: eventId, chain_id: chainId, position, proof, previous_proof: previousProof, receipt, signature, polygon_contract: contractAddress(c) })
})

app.get('/', (c) => c.render(
  <main>
    <nav class="nav"><a class="brand" href="#top"><img class="brand-logo" src="/od.svg" alt="Outside Docker logo"/><span>Outside Docker</span></a><div class="nav-links"><a href="#how">How it works</a><a href="#faq">FAQ</a><a href="mailto:pendia-community@protonmail.com">Contact</a><a class="nav-login" href="#access">Sign in</a><a class="button button-small" href="#access">Get started</a></div></nav>
    <section id="top" class="hero-wrap"><div class="hero-copy"><p class="eyebrow">EVENT-CHAIN INTEGRITY FOR THE REAL WORLD</p><h1>Make every record<br/><em>defensible.</em></h1><p class="hero-lede">Outside Docker preserves the integrity of human documents and machine logs without storing the original content. Capture what happened. Prove what changed. Show the chain.</p><div class="hero-actions"><a class="button" href="#access">Create your account <span>→</span></a><a class="text-link" href="#how">See how it works <span>↓</span></a></div><p class="micro-note"><span class="status-dot"></span> Client-side commitments · SHA-256 · Polygon anchoring</p></div><div class="hero-art" aria-label="Illustration of a protected event chain"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="proof-card"><div class="proof-top"><span class="live-dot"></span><span>CHAIN STATUS</span><strong>INTACT</strong></div><div class="proof-line"><span class="node active"></span><span class="line"></span><span class="node active"></span><span class="line"></span><span class="node active"></span><span class="line"></span><span class="node active"></span></div><div class="proof-meta"><span>EVENT 001</span><span>EVENT 002</span><span>EVENT 003</span><span>ANCHORED</span></div><div class="proof-hash">sha256 · 7f9c...a42e</div></div></div></section>
    <section class="trust-strip"><span>BUILT FOR EVIDENCE THAT NEEDS TO LAST</span><div><span>LEGAL &amp; COMPLIANCE</span><span>INSURANCE</span><span>ROBOTICS</span><span>INVESTIGATIONS</span></div></section>
    <section id="how" class="section"><div class="section-intro"><p class="eyebrow">ONE RECORD. THREE LAYERS.</p><h2>Integrity you can explain<br/>to anyone.</h2><p>OD does not ask people to trust a black box. Its proof model is simple enough to inspect and strong enough to preserve a sequence of events.</p></div><div class="feature-grid"><article class="feature-card"><span class="feature-number">01</span><h3>Capture privately</h3><p>Hash a document, image, JSON payload, or machine record. The original can remain in your own systems.</p></article><article class="feature-card"><span class="feature-number">02</span><h3>Link the sequence</h3><p>Each event is chained to the one before it. Insertion, deletion, and reordering become visible.</p></article><article class="feature-card"><span class="feature-number">03</span><h3>Anchor independently</h3><p>Merkle roots are anchored on Polygon so the integrity record remains checkable beyond the platform.</p></article></div></section>
    <section class="split-section"><div class="split-panel terracotta"><p class="eyebrow light">TRACK H · HUMAN RECORDS</p><h2>For documents that may matter later.</h2><p>Evidence packages, inspection reports, claims, internal investigations, and compliance records. Upload to hash, then keep the source under your own control.</p><a class="light-link" href="#access">Preserve a document <span>→</span></a></div><div class="split-panel sage"><p class="eyebrow">TRACK M · MACHINE RECORDS</p><h2>For systems that never stop producing data.</h2><p>Drones, robots, sensors, automation lines, and APIs can send structured records programmatically. The dashboard stays read-only; machines use the API.</p><a class="dark-link" href="#access">Prepare for machine data <span>→</span></a></div></section>
    <section class="section steps-section"><div class="section-intro"><p class="eyebrow">FROM CAPTURE TO PROOF</p><h2>A clear record of<br/>what happened.</h2></div><div class="steps"><div><span>1</span><h3>Commit</h3><p>Generate a content hash and client-side commitment without sending your passcode to OD.</p></div><div><span>2</span><h3>Receive</h3><p>Get a signed receipt and portable <code>.odproof</code> capsule for your own records.</p></div><div><span>3</span><h3>Verify</h3><p>Share a proof with a reviewer. A Read Pass opens the relevant event workspace for 30 days.</p></div></div></section>
    <section id="access" class="access-section"><div><p class="eyebrow light">READY WHEN YOU ARE</p><h2>Start with a private<br/>integrity record.</h2><p>Create a dev account to explore the workflow. Production access will be activated through the applicable plan or Read Pass.</p></div><div class="access-card"><div class="access-tabs"><a class="active" href="#register-card">Create account</a><a href="#login-card">Sign in</a></div><section id="register-card"><form id="register"><label>Username<input name="username" required pattern="[a-z0-9_-]{3,32}" /></label><p id="availability" class="hint"></p><label>Password<input name="password" type="password" required minLength={7} /></label><p class="hint">At least 7 characters: upper, lower, digit, symbol.</p><label>Role<select name="role"><option value="supplier">Supplier</option><option value="verifier">Verifier</option></select></label><label>Email <span class="optional">optional</span><input name="email" type="email" /></label><div id="org"><label>Organization<input name="organization" /></label><label>Address<input name="address_line1" /></label><div class="grid"><label>City<input name="city" /></label><label>Postal code<input name="postal_code" /></label></div><label>Country<input name="country" /></label></div><button class="button" type="submit">Create dev account <span>→</span></button></form><pre id="register-result"></pre></section><section id="login-card" class="login-panel"><h3>Welcome back</h3><form id="login"><label>Username<input name="username" required /></label><label>Password<input name="password" type="password" required /></label><button class="button" type="submit">Sign in <span>→</span></button></form><pre id="login-result"></pre></section></div></section>
    <section id="faq" class="faq-section"><div class="section-intro"><p class="eyebrow">QUESTIONS, ANSWERED</p><h2>Good records deserve<br/>clear explanations.</h2></div><div class="faq-list"><details open={true}><summary>Does Outside Docker store my original PDF or image?</summary><p>In the Phase 1 integrity workflow, OD stores hashes, commitments, chain proofs, and receipts—not the original content. You retain the source file in your own storage.</p></details><details><summary>Does a hash prove that the underlying content is true?</summary><p>No. It proves that the captured representation has not changed after capture. Truthfulness, authorship, and the quality of the capture process remain matters for the submitting organization and reviewer.</p></details><details><summary>What is the difference between Track H and Track M?</summary><p>Track H is for human-submitted documents and case-based evidence. Track M is for automated machine records submitted through an API key; its dashboard is designed for reading and monitoring, not manual data entry.</p></details><details><summary>Can someone verify a record without being a lawyer?</summary><p>Yes. A verifier is a reader of the integrity record, not a legal certification authority. The verifier can inspect the selected event scope and proof chain. Legal interpretation remains with qualified professionals.</p></details><details><summary>Who can I contact?</summary><p>For product questions, access, or partnership requests, email <a href="mailto:pendia-community@protonmail.com">pendia-community@protonmail.com</a> or <a href="mailto:earthlyfirely@gmail.com">earthlyfirely@gmail.com</a>.</p></details></div></section>
    <footer class="footer"><div class="brand"><img class="brand-logo" src="/od.svg" alt="Outside Docker logo"/><span>Outside Docker</span></div><p>Integrity infrastructure for human and machine records.</p><div><a href="mailto:pendia-community@protonmail.com">pendia-community@protonmail.com</a><a href="mailto:earthlyfirely@gmail.com">earthlyfirely@gmail.com</a></div><small>© 2026 Outside Docker · Integrity preservation, not a truth guarantee.</small></footer>
    <script dangerouslySetInnerHTML={{__html: `
      const reg=document.querySelector('#register'), role=reg.querySelector('[name=role]'), org=document.querySelector('#org'), out=document.querySelector('#register-result');
      role.onchange=()=>org.hidden=role.value!=='supplier'; org.hidden=false;
      let timer; reg.username.oninput=()=>{clearTimeout(timer); timer=setTimeout(async()=>{const v=reg.username.value.toLowerCase();const r=await fetch('/api/username/'+encodeURIComponent(v));const j=await r.json();document.querySelector('#availability').textContent=j.available?'✓ Available':j.reason==='invalid'?'Invalid username':'Already registered'},250)};
      reg.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(reg));const r=await fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});out.textContent=JSON.stringify(await r.json(),null,2)};
      document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});document.querySelector('#login-result').textContent=JSON.stringify(await r.json(),null,2)};
      const registerPanel=document.querySelector('#register-card'), loginPanel=document.querySelector('#login-card'), tabs=[...document.querySelectorAll('.access-tabs a')];
      const showAccess=mode=>{const login=mode==='login';registerPanel.style.display=login?'none':'block';loginPanel.style.display=login?'block':'none';tabs.forEach(tab=>tab.classList.toggle('active',login?tab.getAttribute('href')==='#login-card':tab.getAttribute('href')==='#register-card'));document.querySelector('#access').scrollIntoView({behavior:'smooth',block:'start'});};
      tabs.forEach(tab=>tab.addEventListener('click',e=>{e.preventDefault();showAccess(tab.getAttribute('href')==='#login-card'?'login':'register');history.replaceState(null,'',tab.getAttribute('href'));}));
      document.querySelectorAll('a[href="#login-card"]').forEach(link=>link.addEventListener('click',e=>{e.preventDefault();showAccess('login');history.replaceState(null,'','#login-card');}));
      if(location.hash==='#login-card') showAccess('login');
      window.addEventListener('hashchange',()=>{if(location.hash==='#login-card')showAccess('login');});
    `}} />
  </main>
))

export default app
