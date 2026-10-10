import { handle } from '@astrojs/cloudflare/handler';
import { DurableObject } from 'cloudflare:workers';
import { api } from './lib/api';
import { clearRoom, sweep, type Bindings, type Room } from './lib/core';

export class RoomTimer extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', {status: 405});
    const value = await request.json() as {roomId?: string; at?: number};
    if (!value.roomId || !/^[0-9a-f-]{36}$/.test(value.roomId) || !Number.isFinite(value.at))
      return new Response('Invalid timer', {status: 400});
    await this.ctx.storage.put('roomId', value.roomId);
    const previous = await this.ctx.storage.getAlarm();
    if (previous === null || value.at! < previous) await this.ctx.storage.setAlarm(value.at!);
    return new Response('ok');
  }

  async alarm(): Promise<void> {
    const roomId = await this.ctx.storage.get<string>('roomId');
    if (!roomId) { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return; }
    const room = await this.env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(roomId).first<Room>();
    if (!room) { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return; }
    const now = Date.now();
    const roomDeadline = room.status === 'active' ? room.expires_at
      : room.status === 'inviting' ? room.invite_expires_at
      : room.status === 'pending_payment' ? room.created_at + 24*60*60*1000 : now;
    if (roomDeadline !== null && roomDeadline <= now) {
      await clearRoom(this.env, room);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    const expired = await this.env.DB.prepare('SELECT id,r2_key FROM media WHERE room_id=? AND expires_at<=? LIMIT 100')
      .bind(roomId, now).all<{id:string;r2_key:string}>();
    for (const item of expired.results) {
      await this.env.MEDIA.delete(item.r2_key);
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM messages WHERE media_id=?').bind(item.id),
        this.env.DB.prepare('DELETE FROM media WHERE id=?').bind(item.id)
      ]);
    }
    const nextMedia = await this.env.DB.prepare('SELECT MIN(expires_at) next_at FROM media WHERE room_id=?')
      .bind(roomId).first<{next_at:number|null}>();
    const next = Math.min(roomDeadline ?? Infinity, nextMedia?.next_at ?? Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); }
  }
}

export default {
  async fetch(request: Request, env: Bindings, context: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    const response = path.startsWith('/api/') ? await api(request, env) : await handle(request, env, context);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    if (!path.startsWith('/api/')) response.headers.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return response;
  },
  async scheduled(_event: ScheduledEvent, env: Bindings): Promise<void> { await sweep(env); }
};
