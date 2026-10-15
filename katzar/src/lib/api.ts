import { armRoom, b64, clearCookie, clearRoom, cookie, currentUser, error, json, mutationAllowed, passwordHash, passwordStrong, roomForUser, sha256, signSession, unb64, type Bindings, type Room } from './core';

const HOUR=3600_000;
const REWARD_WINDOW=5*24*HOUR;
const MAX_MEDIA=5_000_000 + 32;
const allowedExtensions=new Set(['pdf','png','docx','pages','jpg','jpeg','gif','xls','xlsx','csv']);
type User={id:string;username:string;sid:string};

async function body(request:Request):Promise<any> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
  if (Number(request.headers.get('content-length')||0)>20000) throw new Error('Request too large');
  const value=await request.json();
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid request');
  return value;
}
async function rate(env:Bindings,request:Request,scope:string,limit:number):Promise<boolean> {
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  const key=await sha256(`${env.KATZAR_JWT_SECRET}:${scope}:${ip}`);
  const window=Math.floor(Date.now()/HOUR)*HOUR;
  await env.DB.prepare(`INSERT INTO rate_limits(key,window_start,hits) VALUES(?,?,1)
    ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN window_start=? THEN hits+1 ELSE 1 END,
    window_start=?`).bind(key,window,window,window).run();
  const row=await env.DB.prepare('SELECT hits FROM rate_limits WHERE key=?').bind(key).first<{hits:number}>();
  return (row?.hits||0)<=limit;
}
function secure(request:Request):boolean{return new URL(request.url).protocol==='https:';}
function validUser(value:unknown):value is string{return typeof value==='string' && /^[A-Za-z][A-Za-z0-9_]{2,23}$/.test(value);}
function id():string{return crypto.randomUUID();}
function member(room:Room,user:User):boolean{return room.creator_id===user.id || room.recipient_id===user.id;}
function available(room:Room,user:User):boolean{
  return member(room,user) && room.status==='active' && !!room.expires_at && room.expires_at>Date.now() && !(room.recipient_id===user.id && room.recipient_left_at);
}
function roomView(room:Room,user:User){
  return {id:room.id,role:room.creator_id===user.id?'creator':'recipient',tier:room.tier,status:room.status,
    recipientJoined:!!room.recipient_id,recipientLeft:!!room.recipient_left_at,
    createdAt:room.created_at,inviteExpiresAt:room.invite_expires_at,
    joinedAt:room.joined_at,expiresAt:room.expires_at,durationSeconds:room.duration_seconds};
}
async function requireUser(request:Request,env:Bindings):Promise<User|Response>{return await currentUser(request,env)||error('Sign in required',401);}
async function handleAuth(request:Request,env:Bindings,part:string):Promise<Response>{
  if(part==='me' && request.method==='GET'){
    const user=await currentUser(request,env);
    return user?json({user:{id:user.id,username:user.username}}):error('Sign in required',401);
  }
  if(!mutationAllowed(request)) return error('Invalid origin',403);
  if(part==='logout' && request.method==='POST'){
    const user=await currentUser(request,env);
    if(user) await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(Date.now(),user.sid).run();
    return json({ok:true},200,{'set-cookie':clearCookie(secure(request))});
  }
  if(!['signup','signin'].includes(part)||request.method!=='POST')return error('Not found',404);
  if(!await rate(env,request,part,part==='signup'?12:30))return error('Try again later',429);
  const input=await body(request);
  if(!validUser(input.username)||typeof input.password!=='string')return error('Invalid username or password');
  const username=input.username.trim();
  const usernameKey=username.toLowerCase();
  let userId:string;
  if(part==='signup'){
    if(!passwordStrong(input.password))return error('Password needs 12–128 characters, uppercase, lowercase, number, and symbol');
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const hash=await passwordHash(input.password,salt);
    userId=id();
    try{await env.DB.prepare('INSERT INTO users(id,username,username_key,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .bind(userId,username,usernameKey,b64(salt),hash,Date.now()).run();}
    catch{return error('Username unavailable',409);}
  }else{
    const row=await env.DB.prepare('SELECT id,password_salt,password_hash FROM users WHERE username_key=?')
      .bind(usernameKey).first<{id:string;password_salt:string;password_hash:string}>();
    if(!row)return error('Invalid username or password',401);
    const attempt=await passwordHash(input.password,unb64(row.password_salt));
    if(attempt!==row.password_hash)return error('Invalid username or password',401);
    userId=row.id;
  }
  const sid=id(),expires=Date.now()+23*HOUR;
  await env.DB.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').bind(sid,userId,expires).run();
  const jwt=await signSession(env.KATZAR_JWT_SECRET,sid,userId);
  return json({ok:true},200,{'set-cookie':cookie(jwt,secure(request))});
}

async function checkout(env:Bindings,request:Request,roomId:string):Promise<string>{
  if(!env.STRIPE_API_KEY||!env.STRIPE_WEBHOOK_SECRET)throw new Error('Paid rooms are not configured');
  const origin=new URL(request.url).origin;
  const params=new URLSearchParams({mode:'payment',success_url:`${origin}/chats?payment=return`,
    cancel_url:`${origin}/chats?payment=cancel&room_id=${encodeURIComponent(roomId)}`,client_reference_id:roomId,
    'metadata[room_id]':roomId,
    'line_items[0][price_data][currency]':'usd',
    'line_items[0][price_data][unit_amount]':'200',
    'line_items[0][price_data][product_data][name]':'Katzar Full room',
    'line_items[0][quantity]':'1'});
  const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',
    headers:{Authorization:`Bearer ${env.STRIPE_API_KEY}`,'Content-Type':'application/x-www-form-urlencoded',
      'Idempotency-Key':`katzar-room-${roomId}`},body:params});
  if(!response.ok)throw new Error('Checkout could not start');
  const session=await response.json() as {id?:string;url?:string};
  if(!session.id||!session.url)throw new Error('Checkout could not start');
  await env.DB.prepare('UPDATE rooms SET checkout_session_id=? WHERE id=?').bind(session.id,roomId).run();
  return session.url;
}
async function expirePendingCheckout(env:Bindings,room:Room):Promise<boolean>{
  if(!env.STRIPE_API_KEY||!room.checkout_session_id)return false;
  const url=`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(room.checkout_session_id)}`;
  const headers={Authorization:`Bearer ${env.STRIPE_API_KEY}`};
  try{
    let response=await fetch(url,{headers});
    if(!response.ok)return false;
    let session=await response.json() as {id?:string;status?:string;payment_status?:string};
    if(session.id!==room.checkout_session_id||session.payment_status==='paid')return false;
    if(session.status==='expired')return true;
    if(session.status!=='open')return false;
    response=await fetch(`${url}/expire`,{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:''});
    if(response.ok){
      session=await response.json() as {id?:string;status?:string;payment_status?:string};
      return session.id===room.checkout_session_id&&session.status==='expired'&&session.payment_status!=='paid';
    }
    // Payment can complete between retrieval and expiration. Confirm the final state.
    response=await fetch(url,{headers});
    if(!response.ok)return false;
    session=await response.json() as {id?:string;status?:string;payment_status?:string};
    return session.id===room.checkout_session_id&&session.status==='expired'&&session.payment_status!=='paid';
  }catch{return false;}
}
async function webhook(request:Request,env:Bindings):Promise<Response>{
  if(!env.STRIPE_WEBHOOK_SECRET)return error('Webhook unavailable',503);
  const signature=request.headers.get('Stripe-Signature')||'';
  const timestamp=/\bt=(\d+)\b/.exec(signature)?.[1];
  const signatures=[...signature.matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map(x=>x[1]);
  if(!timestamp||Math.abs(Date.now()/1000-Number(timestamp))>300||signatures.length===0)return error('Invalid signature',400);
  const raw=await request.text();
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${raw}`)));
  const expected=Array.from(mac,b=>b.toString(16).padStart(2,'0')).join('');
  if(!signatures.some(sig=>sig.length===expected.length && sig===expected))return error('Invalid signature',400);
  const event=JSON.parse(raw) as {id:string;type:string;data:{object:any}};
  if(!event.id||!event.data?.object)return error('Invalid event',400);
  const session=event.data.object;
  if(event.type==='checkout.session.expired'){
    const roomId=session.client_reference_id;
    if(session.mode!=='payment'||session.status!=='expired'||session.payment_status==='paid'||!roomId||session.metadata?.room_id!==roomId)return json({ok:true});
    const room=await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(roomId).first<Room>();
    if(room&&room.tier==='full'&&room.status==='pending_payment'&&room.checkout_session_id===session.id)await clearRoom(env,room);
    return json({ok:true});
  }
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return json({ok:true});
  if(session.mode!=='payment'||session.payment_status!=='paid'||session.amount_total!==200||session.currency!=='usd')return json({ok:true});
  const roomId=session.client_reference_id;
  if(!roomId||session.metadata?.room_id!==roomId)return json({ok:true});
  const room=await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(roomId).first<Room>();
  if(!room||room.tier!=='full'||room.checkout_session_id&&room.checkout_session_id!==session.id)return json({ok:true});
  const purchasedAt=Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO payment_events(stripe_event_id,received_at) VALUES(?,?)').bind(event.id,Date.now()),
    env.DB.prepare("UPDATE rooms SET status='inviting',checkout_session_id=? WHERE id=? AND tier='full' AND creator_id=? AND status='pending_payment'").bind(session.id,roomId,room.creator_id),
    env.DB.prepare(`INSERT OR IGNORE INTO paid_room_purchases(room_id,user_id,purchased_at)
      SELECT id,creator_id,? FROM rooms WHERE id=? AND tier='full' AND creator_id=? AND checkout_session_id=? AND status='inviting'`)
      .bind(purchasedAt,roomId,room.creator_id,session.id),
    env.DB.prepare(`INSERT OR IGNORE INTO paid_room_rewards(trigger_room_id,user_id,granted_at,credits)
      SELECT ?,?,?,8 WHERE (SELECT COUNT(*) FROM paid_room_purchases
        WHERE user_id=? AND purchased_at>=? AND purchased_at>COALESCE(
          (SELECT MAX(granted_at) FROM paid_room_rewards WHERE user_id=?),0))>=3`)
      .bind(roomId,room.creator_id,purchasedAt,room.creator_id,purchasedAt-REWARD_WINDOW,room.creator_id),
    env.DB.prepare(`INSERT INTO full_room_credit_balances(user_id,credits,updated_at)
      SELECT ?,8,? WHERE changes()=1
      ON CONFLICT(user_id) DO UPDATE SET credits=credits+excluded.credits,updated_at=excluded.updated_at`)
      .bind(room.creator_id,purchasedAt)
  ]);
  return json({ok:true});
}

export async function api(request:Request,env:Bindings):Promise<Response>{
  try{
    const path=new URL(request.url).pathname;
    if(path==='/api/stripe/webhook'&&request.method==='POST')return webhook(request,env);
    if(path==='/api/capabilities'&&request.method==='GET'){
      const account=await currentUser(request,env);
      const credits=account?await env.DB.prepare('SELECT credits FROM full_room_credit_balances WHERE user_id=?').bind(account.id).first<{credits:number}>():null;
      return json({fullAvailable:!!(env.STRIPE_API_KEY&&env.STRIPE_WEBHOOK_SECRET)||(credits?.credits||0)>0,fullCredits:credits?.credits||0});
    }
    const auth=/^\/api\/auth\/(signup|signin|logout|me)$/.exec(path);
    if(auth)return handleAuth(request,env,auth[1]);
    if(path==='/api/auth/username-availability'&&request.method==='GET'){
      if(!await rate(env,request,'username-availability',120))return error('Try again later',429);
      const username=new URL(request.url).searchParams.get('username')||'';
      if(!validUser(username))return json({valid:false,available:false});
      const row=await env.DB.prepare('SELECT id FROM users WHERE username_key=?').bind(username.toLowerCase()).first<{id:string}>();
      return json({valid:true,available:!row});
    }
    const user=await requireUser(request,env);
    if(user instanceof Response)return user;
    if(path==='/api/rooms'&&request.method==='GET'){
      const rows=await env.DB.prepare(`SELECT * FROM rooms WHERE creator_id=? OR recipient_id=? ORDER BY created_at DESC LIMIT 100`).bind(user.id,user.id).all<Room>();
      const balance=await env.DB.prepare('SELECT credits FROM full_room_credit_balances WHERE user_id=?').bind(user.id).first<{credits:number}>();
      return json({rooms:rows.results.map(room=>roomView(room,user)),fullCredits:balance?.credits||0});
    }
    if(path==='/api/rooms'&&request.method==='POST'){
      if(!mutationAllowed(request))return error('Invalid origin',403);
      if(!await rate(env,request,`room:${user.id}`,30))return error('Room limit reached',429);
      const input=await body(request);
      if(!['free','full'].includes(input.tier)||typeof input.inviteToken!=='string'||input.inviteToken.length<40)return error('Invalid room');
      const duration=input.tier==='free'?7200:Number(input.durationSeconds);
      if(input.tier==='full'&&(!Number.isInteger(duration)||duration<3600||duration>259200))return error('Invalid duration');
      const roomId=id(),now=Date.now();
      if(input.tier==='full'){
        const used=await env.DB.batch([
          env.DB.prepare('UPDATE full_room_credit_balances SET credits=credits-1,updated_at=? WHERE user_id=? AND credits>0').bind(now,user.id),
          env.DB.prepare(`INSERT INTO rooms(id,creator_id,invite_token_hash,tier,duration_seconds,status,created_at,invite_expires_at)
            SELECT ?,?,?, 'full',?, 'inviting',?,? WHERE changes()=1`)
            .bind(roomId,user.id,await sha256(input.inviteToken),duration,now,now+24*HOUR)
        ]);
        if(used[1].meta.changes===1){
          try{await armRoom(env,roomId,now+24*HOUR);}catch{}
          const balance=await env.DB.prepare('SELECT credits FROM full_room_credit_balances WHERE user_id=?').bind(user.id).first<{credits:number}>();
          return json({id:roomId,status:'inviting',promoCreditUsed:true,fullCredits:balance?.credits||0});
        }
      }
      const status=input.tier==='full'?'pending_payment':'inviting';
      await env.DB.prepare(`INSERT INTO rooms(id,creator_id,invite_token_hash,tier,duration_seconds,status,created_at,invite_expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(roomId,user.id,await sha256(input.inviteToken),input.tier,duration,status,now,now+24*HOUR).run();
      try { await armRoom(env,roomId,now+24*HOUR); } catch {}
      if(input.tier==='full'){
        try{return json({id:roomId,status,checkoutUrl:await checkout(env,request,roomId)});}
        catch{await env.DB.prepare("DELETE FROM rooms WHERE id=? AND status='pending_payment'").bind(roomId).run();return error('Paid checkout unavailable',503);}
      }
      return json({id:roomId,status});
    }
    const invite=/^\/api\/invite\/([0-9a-f-]{36})$/.exec(path);
    if(invite&&request.method==='GET'){
      const room=await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(invite[1]).first<Room>();
      if(room?.recipient_id===user.id && room.status==='active' && !!room.expires_at && room.expires_at>Date.now() && !room.recipient_left_at)
        return json({id:room.id,tier:room.tier,durationSeconds:room.duration_seconds,alreadyJoined:true});
      if(!room||room.status!=='inviting'||room.invite_expires_at<=Date.now()||room.creator_id===user.id||room.recipient_id)return error('Invitation unavailable',404);
      return json({id:room.id,tier:room.tier,durationSeconds:room.duration_seconds});
    }
    if(invite&&request.method==='POST'){
      if(!mutationAllowed(request))return error('Invalid origin',403);
      const input=await body(request);
      if(typeof input.token!=='string')return error('Invalid invitation');
      const now=Date.now();
      const offered=await env.DB.prepare("SELECT duration_seconds FROM rooms WHERE id=? AND status='inviting'").bind(invite[1]).first<{duration_seconds:number}>();
      if(!offered)return error('Invitation unavailable',409);
      const result=await env.DB.prepare(`UPDATE rooms SET recipient_id=?,joined_at=?,expires_at=?,status='active'
        WHERE id=? AND status='inviting' AND recipient_id IS NULL AND creator_id!=?
        AND invite_expires_at>? AND invite_token_hash=?`)
        .bind(user.id,now,now+offered.duration_seconds*1000,
          invite[1],user.id,now,await sha256(input.token)).run();
      if(result.meta.changes===1)try{await armRoom(env,invite[1],now+offered.duration_seconds*1000);}catch{}
      return result.meta.changes===1?json({ok:true}):error('Invitation unavailable',409);
    }
    const roomRoute=/^\/api\/rooms\/([0-9a-f-]{36})(?:\/(messages|media|quit|cancel-payment))?(?:\/([0-9a-f-]{36}))?$/.exec(path);
    if(!roomRoute)return error('Not found',404);
    const action=roomRoute[2]||'';
    const room=await roomForUser(env,roomRoute[1],user.id);
    if(!room)return action==='cancel-payment'?json({cancelled:true,pending:false}):error('Room unavailable',404);
    if(action==='cancel-payment'&&request.method==='POST'){
      if(!mutationAllowed(request))return error('Invalid origin',403);
      if(room.creator_id!==user.id||room.tier!=='full')return error('Room unavailable',404);
      if(room.status!=='pending_payment')return json({cancelled:false,pending:false});
      if(!await expirePendingCheckout(env,room))return json({cancelled:false,pending:true});
      await clearRoom(env,room);
      return json({cancelled:true,pending:false});
    }
    if(room.status==='ended'||room.status==='active'&&room.expires_at!==null&&room.expires_at<=Date.now()||room.status==='inviting'&&room.invite_expires_at<=Date.now()){
      await clearRoom(env,room);
      return error('Room ended',410);
    }
    if(!action&&request.method==='GET')return json({room:roomView(room,user)});
    if(action==='quit'&&request.method==='POST'){
      if(!mutationAllowed(request))return error('Invalid origin',403);
      if(room.creator_id===user.id)await clearRoom(env,room);
      else await env.DB.prepare('UPDATE rooms SET recipient_left_at=? WHERE id=? AND recipient_id=? AND recipient_left_at IS NULL').bind(Date.now(),room.id,user.id).run();
      return json({ok:true});
    }
    if(!available(room,user))return error('Room ended or access revoked',410);
    if(action==='messages'&&request.method==='GET'){
      const rows=await env.DB.prepare(`SELECT id,sender_id,kind,ciphertext,iv,media_id,sent_at,expires_at FROM messages
        WHERE room_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY sent_at ASC LIMIT 500`).bind(room.id,Date.now()).all();
      return json({messages:rows.results});
    }
    if(action==='messages'&&request.method==='POST'){
      if(!mutationAllowed(request))return error('Invalid origin',403);
      if(room.recipient_left_at)return error('Recipient left',410);
      if(!await rate(env,request,`message:${user.id}`,600))return error('Message limit reached',429);
      const input=await body(request);
      if(typeof input.ciphertext!=='string'||input.ciphertext.length>16000||typeof input.iv!=='string'||input.iv.length>50)return error('Invalid message');
      await env.DB.prepare("INSERT INTO messages(id,room_id,sender_id,kind,ciphertext,iv,sent_at) VALUES(?,?,?,'text',?,?,?)")
        .bind(id(),room.id,user.id,input.ciphertext,input.iv,Date.now()).run();
      return json({ok:true});
    }
    if(action==='media'&&request.method==='GET'&&roomRoute[3]){
      const item=await env.DB.prepare('SELECT * FROM media WHERE id=? AND room_id=? AND expires_at>?').bind(roomRoute[3],room.id,Date.now()).first<{r2_key:string}>();
      if(!item)return error('Media unavailable',404);
      const object=await env.MEDIA.get(item.r2_key);
      if(!object)return error('Media unavailable',404);
      return new Response(object.body,{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="encrypted.bin"','cache-control':'no-store','x-content-type-options':'nosniff'}});
    }
    if(action==='media'&&request.method==='POST'){
      if(!mutationAllowed(request))return error('Invalid origin',403);
      if(room.tier!=='full'||room.recipient_left_at)return error('Media unavailable',403);
      const kind=request.headers.get('X-Katzar-Kind');
      const ext=(request.headers.get('X-Katzar-Extension')||'').toLowerCase();
      const iv=request.headers.get('X-Katzar-Iv')||'';
      const metadata=request.headers.get('X-Katzar-Metadata')||'';
      if(!['file','audio'].includes(kind||'')||(kind==='file'&&!allowedExtensions.has(ext))||iv.length>50||metadata.length>3000)return error('Invalid media');
      if(Number(request.headers.get('content-length')||0)>MAX_MEDIA)return error('File exceeds 5 MB',413);
      const bytes=await request.arrayBuffer();
      if(bytes.byteLength<1||bytes.byteLength>MAX_MEDIA)return error('File exceeds 5 MB',413);
      const mediaId=id(),messageId=id(),now=Date.now(),expiry=kind==='audio'?Math.min(room.expires_at!,now+8*HOUR):room.expires_at!;
      const key=`${room.id}/${mediaId}`;
      await env.MEDIA.put(key,bytes,{httpMetadata:{contentType:'application/octet-stream'}});
      try{
        await env.DB.batch([
          env.DB.prepare('INSERT INTO media(id,room_id,r2_key,kind,size_bytes,expires_at) VALUES(?,?,?,?,?,?)').bind(mediaId,room.id,key,kind,bytes.byteLength,expiry),
          env.DB.prepare('INSERT INTO messages(id,room_id,sender_id,kind,ciphertext,iv,media_id,sent_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
            .bind(messageId,room.id,user.id,kind,metadata,iv,mediaId,now,kind==='audio'?expiry:null)
        ]);
      }catch{await env.MEDIA.delete(key);throw new Error('Upload failed');}
      if(kind==='audio')try{await armRoom(env,room.id,expiry);}catch{}
      return json({ok:true});
    }
    return error('Not found',404);
  }catch(e){
    const message=e instanceof Error?e.message:'Request failed';
    if(['Expected JSON','Request too large','Invalid request'].includes(message))return error(message);
    return error('Request failed',500);
  }
}
