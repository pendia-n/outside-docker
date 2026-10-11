export interface Bindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  ROOM_TIMER: DurableObjectNamespace;
  KATZAR_JWT_SECRET: string;
  STRIPE_API_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ASSETS: Fetcher;
}

export const SESSION_MS = 23 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export function b64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function unb64(value: string): Uint8Array {
  const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
export function randomToken(size = 32): string { return b64(crypto.getRandomValues(new Uint8Array(size))); }
export async function sha256(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
export async function signSession(secret: string, sessionId: string, userId: string): Promise<string> {
  const part = b64(encoder.encode(JSON.stringify({ sid: sessionId, sub: userId, exp: Math.floor((Date.now() + SESSION_MS) / 1000) })));
  const body = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${part}`;
  return `${body}.${b64(await hmac(secret, body))}`;
}
export async function currentUser(request: Request, env: Bindings): Promise<{id: string; username: string; sid: string} | null> {
  const token = /(?:^|;\s*)katzar_session=([^;]+)/.exec(request.headers.get('Cookie') || '')?.[1];
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    if (!equal(unb64(parts[2]), await hmac(env.KATZAR_JWT_SECRET, `${parts[0]}.${parts[1]}`))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
    if (!payload.sid || !payload.sub || payload.exp <= Date.now() / 1000) return null;
    const row = await env.DB.prepare(`SELECT users.id, users.username, sessions.id sid FROM sessions
      JOIN users ON users.id=sessions.user_id WHERE sessions.id=? AND sessions.user_id=?
      AND sessions.revoked_at IS NULL AND sessions.expires_at>?`).bind(payload.sid, payload.sub, Date.now()).first<{id:string;username:string;sid:string}>();
    return row || null;
  } catch { return null; }
}
export function cookie(token: string, secure: boolean): string {
  return `katzar_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=82800${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure: boolean): string {
  return `katzar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
export async function passwordHash(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  // Workers Web Crypto rejects iteration counts above 100,000.
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new Uint8Array(salt), iterations: 100000, hash: 'SHA-256' }, key, 256)));
}
export function passwordStrong(value: string): boolean {
  return value.length >= 12 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
}
export function json(value: unknown, status = 200, headers: Record<string,string> = {}): Response {
  return new Response(JSON.stringify(value), {status, headers: {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers}});
}
export function error(message: string, status = 400): Response { return json({error:message}, status); }
export function mutationAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !!origin && origin === new URL(request.url).origin;
}
export interface Room {
  id:string; creator_id:string; recipient_id:string|null; invite_token_hash:string;
  tier:'free'|'full'; duration_seconds:number; status:'pending_payment'|'inviting'|'active'|'ended';
  created_at:number; invite_expires_at:number; joined_at:number|null; expires_at:number|null;
  recipient_left_at:number|null; ended_at:number|null; checkout_session_id:string|null;
}
export async function roomForUser(env: Bindings, id: string, userId: string): Promise<Room|null> {
  const room = await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(id).first<Room>();
  if (!room || (room.creator_id !== userId && room.recipient_id !== userId)) return null;
  return room;
}
export async function clearRoom(env: Bindings, room: Room): Promise<void> {
  await env.DB.prepare("UPDATE rooms SET status='ended', ended_at=COALESCE(ended_at,?) WHERE id=? AND status!='ended'").bind(Date.now(),room.id).run();
  const media = await env.DB.prepare('SELECT r2_key FROM media WHERE room_id=?').bind(room.id).all<{r2_key:string}>();
  for (const item of media.results) await env.MEDIA.delete(item.r2_key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE room_id=?').bind(room.id),
    env.DB.prepare('DELETE FROM media WHERE room_id=?').bind(room.id)
  ]);
  await env.DB.prepare('DELETE FROM rooms WHERE id=?').bind(room.id).run();
}
export async function armRoom(env: Bindings, roomId: string, at: number): Promise<void> {
  const stub = env.ROOM_TIMER.get(env.ROOM_TIMER.idFromName(roomId));
  const response = await stub.fetch('https://room-timer.internal/arm', {
    method: 'POST', body: JSON.stringify({roomId, at})
  });
  if (!response.ok) throw new Error('Unable to schedule room expiry');
}
export async function sweep(env: Bindings): Promise<void> {
  const now=Date.now();
  const rooms=await env.DB.prepare("SELECT * FROM rooms WHERE (status='active' AND expires_at<=?) OR (status='inviting' AND invite_expires_at<=?) OR (status='pending_payment' AND created_at<=?) OR status='ended' LIMIT 100").bind(now,now,now-24*60*60*1000).all<Room>();
  for(const room of rooms.results) await clearRoom(env,room);
  const media=await env.DB.prepare('SELECT id,r2_key FROM media WHERE expires_at<=? LIMIT 100').bind(now).all<{id:string;r2_key:string}>();
  for(const item of media.results){ await env.MEDIA.delete(item.r2_key); await env.DB.batch([env.DB.prepare('DELETE FROM messages WHERE media_id=?').bind(item.id),env.DB.prepare('DELETE FROM media WHERE id=?').bind(item.id)]); }
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now).run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start<?').bind(now-2*60*60*1000).run();
}
