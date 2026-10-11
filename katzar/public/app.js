const $=selector=>document.querySelector(selector);
const page=document.body.dataset.page;
const enc=new TextEncoder();
const dec=new TextDecoder();
const formatTime=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'Etc/GMT-3',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value))+' UTC+3';
function b64(bytes){let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
function unb64(value){const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));return Uint8Array.from(raw,x=>x.charCodeAt(0));}
function random(){return b64(crypto.getRandomValues(new Uint8Array(32)));}
async function api(path,options={}){
  const response=await fetch('/api'+path,{credentials:'same-origin',cache:'no-store',...options});
  const type=response.headers.get('content-type')||'';
  const result=type.includes('application/json')?await response.json():await response.arrayBuffer();
  if(!response.ok)throw new Error(result.error||'Request failed');
  return result;
}
function jsonPost(path,value){return api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});}
function keyFor(id){return localStorage.getItem('katzar-key-'+id);}
function tokenFor(id){return localStorage.getItem('katzar-token-'+id);}
function setKeys(id,key,token){localStorage.setItem('katzar-key-'+id,key);if(token)localStorage.setItem('katzar-token-'+id,token);}
function dropKeys(id){localStorage.removeItem('katzar-key-'+id);localStorage.removeItem('katzar-token-'+id);}
async function roomKey(id){const value=keyFor(id);if(!value)throw new Error('The room key is missing on this device. Open your original invitation link.');return crypto.subtle.importKey('raw',unb64(value),'AES-GCM',false,['encrypt','decrypt']);}
async function encrypt(id,plain){const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await roomKey(id),plain));return {iv:b64(iv),ciphertext:b64(ciphertext)};}
async function decrypt(id,iv,ciphertext){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},await roomKey(id),unb64(ciphertext)));}
const node=(tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;};
function setTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('katzar-theme',theme);}
setTheme(localStorage.getItem('katzar-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
$('#theme-toggle')?.addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
if(page==='home')api('/capabilities').then(value=>{if(!value.fullAvailable)$('#full-availability').textContent='Full rooms are not available until Stripe setup is complete.';}).catch(()=>{});

async function ensureUser(){
  try{return (await api('/auth/me')).user;}
  catch{sessionStorage.setItem('katzar-return',location.pathname+location.search+location.hash);location.href='/signin';return null;}
}
if(page==='signup'||page==='signin'){
  let availabilityTimer=null,availabilityRequest=0,usernameAvailability='idle';
  async function checkUsername(){
    const input=$('#username-input'),hint=$('#username-status'),value=input.value;
    if(!/^[A-Za-z][A-Za-z0-9_]{2,23}$/.test(value)){
      usernameAvailability='invalid';hint.textContent=value?'Use 3–24 characters: start with a letter, then letters, numbers, or _.':'';
      return {valid:false,available:false};
    }
    const requestId=++availabilityRequest;
    usernameAvailability='checking';hint.textContent='Checking username…';
    try{
      const result=await api('/auth/username-availability?username='+encodeURIComponent(value));
      if(requestId!==availabilityRequest||input.value!==value)return {valid:false,available:false};
      usernameAvailability=result.available?'available':'taken';
      hint.textContent=result.available?'Username is available.':'That username is already taken.';
      return result;
    }catch{
      if(requestId===availabilityRequest){usernameAvailability='error';hint.textContent='Could not check right now. We’ll check again when you submit.';}
      return {valid:true,available:false,error:true};
    }
  }
  if(page==='signup')$('#username-input').addEventListener('input',()=>{
    clearTimeout(availabilityTimer);availabilityRequest++;
    const input=$('#username-input'),hint=$('#username-status');
    if(!input.value){usernameAvailability='idle';hint.textContent='';return;}
    if(!/^[A-Za-z][A-Za-z0-9_]{2,23}$/.test(input.value)){
      usernameAvailability='invalid';hint.textContent='Use 3–24 characters: start with a letter, then letters, numbers, or _.';return;
    }
    usernameAvailability='checking';hint.textContent='Checking username…';
    availabilityTimer=setTimeout(checkUsername,350);
  });
  $('#auth-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const status=$('.form-status');
    const button=form.querySelector('button');
    button.disabled=true;status.textContent='';
    try{
      if(page==='signup'&&usernameAvailability!=='available'){
        clearTimeout(availabilityTimer);
        const result=await checkUsername();
        if(!result.available){button.disabled=false;return;}
      }
      await jsonPost('/auth/'+page,{username:form.elements.namedItem('username').value,password:form.elements.namedItem('password').value});
      const destination=sessionStorage.getItem('katzar-return')||'/chats';
      sessionStorage.removeItem('katzar-return');
      location.href=destination;
    }catch(error){status.textContent=error.message;button.disabled=false;}
  });
}
if(page==='chats')initChats();
async function initChats(){
  const user=await ensureUser();if(!user)return;
  $('#account-label').textContent='Signed in as '+user.username;
  const capabilities=await api('/capabilities');
  const fullOption=document.querySelector('[name=tier][value=full]');
  if(!capabilities.fullAvailable){fullOption.disabled=true;fullOption.parentElement.append(node('span','muted',' · unavailable until payment setup'));} 
  $('#logout').addEventListener('click',async()=>{await jsonPost('/auth/logout',{});location.href='/';});
  document.querySelectorAll('[name=tier]').forEach(radio=>radio.addEventListener('change',()=>{
    $('#duration-wrap').hidden=document.querySelector('[name=tier]:checked').value!=='full';
  }));
  $('#create-room').addEventListener('click',async()=>{
    const button=$('#create-room'),status=$('#create-status');
    button.disabled=true;status.textContent='';
    const tier=document.querySelector('[name=tier]:checked').value;
    const token=random(),key=random();
    try{
      const room=await jsonPost('/rooms',{tier,durationSeconds:Number($('#duration').value),inviteToken:token});
      setKeys(room.id,key,token);
      if(room.checkoutUrl){location.href=room.checkoutUrl;return;}
      location.href='/chats/'+room.id;
    }catch(error){status.textContent=error.message;button.disabled=false;}
  });
  await showRooms();
  setInterval(showRooms,10000);
}
async function showRooms(){
  try{
    const data=await api('/rooms');
    const container=$('#rooms-list');container.replaceChildren();
    if(!data.rooms.length){container.append(node('p','','No rooms yet. Start one above.'));return;}
    for(const room of data.rooms){
      const article=node('article');
      article.append(node('h3','',room.role==='creator'?'Your invitation':'Invited room'));
      const state=room.status==='pending_payment'?'Payment pending':room.status==='inviting'?'Waiting for recipient':room.status==='ended'||(room.expiresAt&&room.expiresAt<=Date.now())?'Ended':room.recipientLeft?'Recipient quit':'Active';
      article.append(node('p','',state+' · '+(room.tier==='full'?'Full':'Free')));
      if(room.expiresAt)article.append(node('p','','Ends '+formatTime(room.expiresAt)));
      const link=node('a','','Open room');link.href='/chats/'+room.id;article.append(link);container.append(article);
    }
  }catch(error){$('#rooms-list').textContent=error.message;}
}
if(page==='invite')initInvite();
async function initInvite(){
  const user=await ensureUser();if(!user)return;
  const id=location.pathname.split('/').pop();
  const params=new URLSearchParams(location.hash.slice(1));
  const token=params.get('t'),key=params.get('k');
  const status=$('#invite-status');
  if(!token||!key){status.textContent='This invitation is missing its private link details.';return;}
  try{
    const info=await api('/invite/'+id);
    $('#invite-details').textContent=(info.tier==='full'?'Full room':'Free text room')+' · '+Math.round(info.durationSeconds/3600)+' hour'+(info.durationSeconds===3600?'':'s')+' after you join.';
    $('#accept-invite').hidden=false;
    if(info.alreadyJoined){
      $('#accept-invite').textContent='Open your room';
      $('#accept-invite').addEventListener('click',()=>{setKeys(id,key);location.href='/chats/'+id;});
      return;
    }
    $('#accept-invite').addEventListener('click',async()=>{
      $('#accept-invite').disabled=true;status.textContent='';
      try{await jsonPost('/invite/'+id,{token});setKeys(id,key);location.href='/chats/'+id;}
      catch(error){status.textContent=error.message;$('#accept-invite').disabled=false;}
    });
  }catch(error){status.textContent=error.message;}
}
if(page==='room')initRoom();
async function initRoom(){
  const user=await ensureUser();if(!user)return;
  const id=location.pathname.split('/').pop();
  const status=$('#composer-status'),messages=$('#messages');
  let room=null,lastIds='',pollBusy=false;
  const setStatus=value=>{status.textContent=value;};
  const veil=()=>document.body.classList.add('veiled');
  $('#veil-toggle').textContent='Dim messages';
  $('#veil-toggle').addEventListener('click',()=>{
    const veiled=document.body.classList.toggle('veiled');
    $('#veil-toggle').textContent=veiled?'Show clearly':'Dim messages';
    $('#veil-toggle').setAttribute('aria-pressed',String(veiled));
  });
  window.addEventListener('blur',veil);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)veil();else refresh();});
  async function refresh(){
    if(pollBusy)return;pollBusy=true;
    try{
      room=(await api('/rooms/'+id)).room;
      if(room.status==='ended'||room.expiresAt&&room.expiresAt<=Date.now()||room.role==='recipient'&&room.recipientLeft){dropKeys(id);location.replace('/chats?ended=1');return;}
      $('#room-state').textContent=room.status==='pending_payment'?'Payment pending':room.status==='inviting'?'Invitation ready':'Active';
      $('#room-timer').textContent=room.expiresAt?'Ends '+formatTime(room.expiresAt):room.status==='pending_payment'?'Waiting for payment confirmation':'Starts when your recipient joins';
      $('#quit-room').hidden=room.status==='pending_payment'||room.status==='ended';
      $('#composer').hidden=room.status!=='active'||room.recipientLeft;
      $('#file-label').hidden=room.tier!=='full'||room.status!=='active';
      $('#record').hidden=room.tier!=='full'||room.status!=='active'||!navigator.mediaDevices?.getUserMedia;
      const inviteButton=$('#copy-invite');
      inviteButton.hidden=room.role!=='creator'||room.status!=='inviting'||!tokenFor(id)||!keyFor(id);
      $('#invite-note').textContent=room.role==='creator'&&room.status==='inviting'?'Share this link only with the one person you want to chat with.':'';
      if(room.status==='active'&&keyFor(id)){
        const result=await api('/rooms/'+id+'/messages');
        const ids=result.messages.map(item=>item.id).join(',');
        if(ids!==lastIds){lastIds=ids;await renderMessages(result.messages);}
      }
    }catch(error){if(error.message.includes('ended')||error.message.includes('revoked')||error.message.includes('unavailable')){dropKeys(id);location.replace('/chats?ended=1');}else setStatus(error.message);}
    finally{pollBusy=false;}
  }
  async function renderMessages(items){
    messages.replaceChildren();
    for(const item of items){
      const own=item.sender_id===user.id;
      const bubble=node('article','message'+(own?' own':''));
      try{
        if(item.kind==='text')bubble.append(node('p','',dec.decode(await decrypt(id,item.iv,item.ciphertext))));
        else{
          const metadata=JSON.parse(dec.decode(await decrypt(id,item.iv,item.ciphertext)));
          const button=node('button','media-action',item.kind==='audio'?'Play voice note':'Download '+metadata.name);
          button.type='button';
          button.addEventListener('click',async()=>{
            button.disabled=true;
            try{
              const encrypted=new Uint8Array(await api('/rooms/'+id+'/media/'+item.media_id));
              const iv=encrypted.slice(0,12),payload=encrypted.slice(12);
              const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv},await roomKey(id),payload);
              const blob=new Blob([bytes],{type:item.kind==='audio'?(metadata.type||'audio/webm'):'application/octet-stream'});
              const url=URL.createObjectURL(blob);
              if(item.kind==='audio'){
                const player=node('audio');player.controls=true;player.controlsList='nodownload';player.src=url;bubble.append(player);player.play().catch(()=>{});
                player.addEventListener('ended',()=>URL.revokeObjectURL(url),{once:true});
              }else{
                const link=node('a');link.href=url;link.download=(metadata.name||'attachment').split(/[\\/]/).pop();link.click();
                setTimeout(()=>URL.revokeObjectURL(url),30000);
              }
            }catch(error){setStatus(error.message);}finally{button.disabled=false;}
          });
          bubble.append(button);
        }
      }catch{bubble.append(node('p','','Unable to decrypt on this device.'));}
      bubble.append(node('time','',formatTime(item.sent_at)));
      messages.append(bubble);
    }
    if(items.length)messages.lastElementChild.scrollIntoView({block:'end'});
  }
  $('#copy-invite').addEventListener('click',async()=>{
    const link=location.origin+'/invite/'+id+'#'+new URLSearchParams({t:tokenFor(id),k:keyFor(id)});
    try{await navigator.clipboard.writeText(link);$('#invite-note').textContent='Invitation copied. Send it only to your intended recipient.';}
    catch{$('#invite-note').textContent='Copy this link: '+link;}
  });
  $('#quit-room').addEventListener('click',async()=>{
    const warning=room.role==='creator'?'Quit and destroy this room for both people now?':'Quit this room? You will lose access, but the creator can see existing content until expiry.';
    if(!confirm(warning))return;
    try{await jsonPost('/rooms/'+id+'/quit',{});dropKeys(id);location.replace('/chats');}catch(error){setStatus(error.message);}
  });
  $('#composer').addEventListener('submit',async event=>{
    event.preventDefault();const field=$('#message-input'),text=field.value.trim();
    if(!text)return;
    try{setStatus('');const encrypted=await encrypt(id,enc.encode(text));await jsonPost('/rooms/'+id+'/messages',encrypted);field.value='';await refresh();}
    catch(error){setStatus(error.message);}
  });
  $('#file-input').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    const ext=file.name.split('.').pop().toLowerCase();
    if(!['pdf','png','docx','pages','jpg','jpeg','gif','xls','xlsx','csv'].includes(ext)||file.size>5_000_000){setStatus('Choose an allowed file up to 5 MB.');return;}
    try{await uploadMedia(new Uint8Array(await file.arrayBuffer()),'file',{name:file.name,type:file.type||'application/octet-stream'},ext);setStatus('File sent.');await refresh();}
    catch(error){setStatus(error.message);}event.target.value='';
  });
  async function uploadMedia(bytes,kind,metadata,ext=''){
    const key=await roomKey(id),iv=crypto.getRandomValues(new Uint8Array(12));
    const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,bytes));
    const payload=new Uint8Array(12+encrypted.length);payload.set(iv);payload.set(encrypted,12);
    const meta=await encrypt(id,enc.encode(JSON.stringify(metadata)));
    await api('/rooms/'+id+'/media',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Katzar-Kind':kind,'X-Katzar-Extension':ext,'X-Katzar-Iv':meta.iv,'X-Katzar-Metadata':meta.ciphertext},body:payload});
  }
  let recorder=null,chunks=[],stream=null;
  $('#record').addEventListener('click',async()=>{
    const button=$('#record');
    if(recorder?.state==='recording'){recorder.stop();button.textContent='Record voice';return;}
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});chunks=[];
      const mime=['audio/webm','audio/mp4','audio/ogg'].find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      recorder.onstop=async()=>{
        stream.getTracks().forEach(track=>track.stop());
        const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});
        if(blob.size>5_000_000){setStatus('Voice note exceeded 5 MB. Record a shorter note.');return;}
        try{await uploadMedia(new Uint8Array(await blob.arrayBuffer()),'audio',{name:'Voice note',type:blob.type});setStatus('Voice note sent. It expires in eight hours.');await refresh();}
        catch(error){setStatus(error.message);}
      };
      recorder.start();button.textContent='Stop recording';setStatus('Recording…');
    }catch(error){setStatus('Microphone unavailable: '+error.message);}
  });
  await refresh();setInterval(refresh,3000);
  setInterval(()=>{if(room?.expiresAt&&Date.now()>=room.expiresAt){dropKeys(id);location.replace('/chats?ended=1');}},1000);
}
