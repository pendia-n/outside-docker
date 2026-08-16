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
  <main class="shell">
    <section class="hero"><p class="eyebrow">OUTSIDE DOCKER · PHASE 1 · DEV</p><h1>Record integrity without storing the original.</h1><p class="lede">Hono Worker · D1 · client-side commitment model · 28-day httpOnly JWT session.</p></section>
    <section class="card"><h2>Create dev account</h2><form id="register"><label>Username<input name="username" required pattern="[a-z0-9_-]{3,32}" /></label><p id="availability" class="hint"></p><label>Password<input name="password" type="password" required minLength={7} /></label><p class="hint">Minimum 7 characters: upper, lower, digit, symbol.</p><label>Role<select name="role"><option value="supplier">Supplier</option><option value="verifier">Verifier</option></select></label><label>Email (optional)<input name="email" type="email" /></label><div id="org"><label>Organization<input name="organization" /></label><label>Address<input name="address_line1" /></label><div class="grid"><label>City<input name="city" /></label><label>Postal code<input name="postal_code" /></label></div><label>Country<input name="country" /></label></div><button>Create account</button></form><pre id="register-result"></pre></section>
    <section class="card"><h2>Login</h2><form id="login"><label>Username<input name="username" required /></label><label>Password<input name="password" type="password" required /></label><button>Login</button></form><pre id="login-result"></pre></section>
    <script dangerouslySetInnerHTML={{__html: `
      const reg=document.querySelector('#register'), role=reg.querySelector('[name=role]'), org=document.querySelector('#org'), out=document.querySelector('#register-result');
      role.onchange=()=>org.hidden=role.value!=='supplier'; org.hidden=false;
      let timer; reg.username.oninput=()=>{clearTimeout(timer); timer=setTimeout(async()=>{const v=reg.username.value.toLowerCase();const r=await fetch('/api/username/'+encodeURIComponent(v));const j=await r.json();document.querySelector('#availability').textContent=j.available?'✓ Available':j.reason==='invalid'?'Invalid username':'Already registered'},250)};
      reg.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(reg));const r=await fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});out.textContent=JSON.stringify(await r.json(),null,2)};
      document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});document.querySelector('#login-result').textContent=JSON.stringify(await r.json(),null,2)};
    `}} />
  </main>
))

export default app
