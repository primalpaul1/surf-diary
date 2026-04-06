let currentUser=null,followingSet=new Set(),voiceBlob=null,voiceTranscript='',mediaRecorder=null,recordingChunks=[],recordingTimer=null,recordingSeconds=0,nip46Data=null,speechRecognition=null,videoFile=null,avatarFile=null;
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const BLOSSOM='https://blossom.primal.net';
const RELAYS=['wss://relay.primal.net','wss://relay.damus.io','wss://nos.lol'];

// Nav
$$('.nav-btn[data-view]').forEach(b=>{b.addEventListener('click',()=>{$$('.nav-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.view').forEach(v=>v.classList.remove('active'));$(`#view-${b.dataset.view}`).classList.add('active');if(b.dataset.view==='history')loadSessions();if(b.dataset.view==='surfers')loadSurfers();if(b.dataset.view==='analysis')loadAnalysis();});});

function toast(m,t='success'){const e=document.createElement('div');e.className=`toast toast-${t}`;e.textContent=m;document.body.appendChild(e);setTimeout(()=>e.remove(),3000);}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function getRatingClass(r){if(!r)return'';return r<=3?'r-low':r<=5?'r-mid':r<=7?'r-high':'r-epic';}
function formatTOD(t){return{dawn:'Dawn Patrol',morning:'Morning',midday:'Midday',afternoon:'Afternoon',evening:'Evening','5am':'5 AM','6am':'6 AM','7am':'7 AM','8am':'8 AM','9am':'9 AM','10am':'10 AM','11am':'11 AM','12pm':'12 PM','1pm':'1 PM','2pm':'2 PM','3pm':'3 PM','4pm':'4 PM','5pm':'5 PM','6pm':'6 PM'}[t]||t;}
function avatarHTML(path,name,cls='feed-avatar'){if(path)return`<img src="${path}" class="${cls}" alt="">`;const i=(name||'?')[0].toUpperCase();return`<div class="${cls}-placeholder">${i}</div>`;}

// ===== BLOSSOM UPLOAD =====
async function uploadToBlossom(file) {
  if (!currentUser?.secretKey) {
    // No local secret key (NIP-46 user) — fall back to base64 server upload
    return null;
  }
  try {
    const { finalizeEvent } = await import('https://esm.sh/nostr-tools@2.10.0/pure');
    const { hexToBytes } = await import('https://esm.sh/@noble/hashes@1.8.0/utils');
    const { sha256 } = await import('https://esm.sh/@noble/hashes@1.8.0/sha256');
    const { bytesToHex } = await import('https://esm.sh/@noble/hashes@1.8.0/utils');

    // Read file as ArrayBuffer and hash it
    const buf = await file.arrayBuffer();
    const hashBytes = sha256(new Uint8Array(buf));
    const fileHash = bytesToHex(hashBytes);
    const now = Math.floor(Date.now() / 1000);

    // Build kind 24242 auth event
    const authEvent = finalizeEvent({
      kind: 24242,
      created_at: now,
      tags: [['t', 'upload'], ['x', fileHash], ['expiration', String(now + 300)]],
      content: 'Upload file'
    }, hexToBytes(currentUser.secretKey));

    const authHeader = 'Nostr ' + btoa(JSON.stringify(authEvent));

    // Upload to Blossom
    const res = await fetch(`${BLOSSOM}/upload`, {
      method: 'PUT',
      headers: {
        'Authorization': authHeader,
        'Content-Type': file.type || 'application/octet-stream'
      },
      body: buf
    });

    if (!res.ok) throw new Error(`Blossom upload failed: ${res.status}`);
    const data = await res.json();
    return data.url || `${BLOSSOM}/${fileHash}`;
  } catch (err) {
    console.error('Blossom upload failed:', err);
    return null; // Fall back to base64
  }
}

// ===== NOSTR KIND 3 FOLLOWS =====
async function fetchKind3(pubkey) {
  try {
    const { Relay } = await import('https://esm.sh/nostr-tools@2.10.0/relay');
    const relay = await Relay.connect(RELAYS[0]);
    return new Promise((resolve) => {
      let event = null;
      relay.subscribe([{ kinds: [3], authors: [pubkey], limit: 1 }], {
        onevent: (ev) => { if (!event || ev.created_at > event.created_at) event = ev; },
        oneose: () => { relay.close(); resolve(event); }
      });
      setTimeout(() => { try { relay.close(); } catch {} resolve(event); }, 5000);
    });
  } catch { return null; }
}

async function publishKind3(followPubkeys) {
  if (!currentUser?.secretKey) return; // Can't sign without local key
  try {
    const { finalizeEvent } = await import('https://esm.sh/nostr-tools@2.10.0/pure');
    const { Relay } = await import('https://esm.sh/nostr-tools@2.10.0/relay');
    const { hexToBytes } = await import('https://esm.sh/@noble/hashes@1.8.0/utils');

    const tags = followPubkeys.map(pk => ['p', pk]);
    const event = finalizeEvent({
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    }, hexToBytes(currentUser.secretKey));

    // Publish to all relays
    for (const url of RELAYS) {
      try {
        const relay = await Relay.connect(url);
        await relay.publish(event);
        relay.close();
      } catch {}
    }
  } catch (err) { console.error('Failed to publish kind 3:', err); }
}

async function syncFollowsFromRelay() {
  if (!currentUser) return;
  const event = await fetchKind3(currentUser.pubkey);
  if (!event) return;
  const pTags = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
  followingSet = new Set(pTags);
  // Sync to server cache
  for (const pk of pTags) {
    try { await fetch(`/api/follows/${pk}`, { method: 'POST', headers: { 'X-Nostr-Pubkey': currentUser.pubkey } }); } catch {}
  }
}

// ===== AUTH =====
$('#create-account-btn').addEventListener('click',()=>$('#create-modal').classList.remove('hidden'));
$('#create-modal .modal-backdrop').addEventListener('click',()=>$('#create-modal').classList.add('hidden'));
$('#create-modal .modal-close').addEventListener('click',()=>$('#create-modal').classList.add('hidden'));
$('#switch-to-primal').addEventListener('click',()=>{$('#create-modal').classList.add('hidden');openLoginModal();});

// Avatar upload preview
$('#avatar-upload').addEventListener('click',()=>$('#avatar-file').click());
$('#avatar-file').addEventListener('change',e=>{
  avatarFile=e.target.files[0];if(!avatarFile)return;
  const reader=new FileReader();
  reader.onload=ev=>{$('#avatar-preview').innerHTML=`<img src="${ev.target.result}">`};
  reader.readAsDataURL(avatarFile);
});

$('#create-form').addEventListener('submit',async e=>{
  e.preventDefault();const name=$('#create-name').value.trim();if(!name)return;
  try{
    const{generateSecretKey,getPublicKey}=await import('https://esm.sh/nostr-tools@2.10.0');
    const{bytesToHex}=await import('https://esm.sh/@noble/hashes@1.8.0/utils');
    const sk=generateSecretKey(),secretKey=bytesToHex(sk),pubkey=getPublicKey(sk);

    // Set currentUser early so Blossom upload can use the secretKey
    currentUser={pubkey,secretKey,display_name:name,avatar_path:null};

    // Upload avatar to Blossom if provided
    let avatarUrl=null;
    if(avatarFile){
      avatarUrl=await uploadToBlossom(avatarFile);
    }

    const body={pubkey,display_name:name};
    if(avatarUrl)body.avatar_url=avatarUrl;
    else if(avatarFile){
      // Fallback: send as base64
      const r=new FileReader();
      body.avatar_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(avatarFile);});
    }

    const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    currentUser.avatar_path=data.avatar_path||avatarUrl||null;
    localStorage.setItem('surf_diary_user',JSON.stringify(currentUser));
    updateAuthUI();$('#create-modal').classList.add('hidden');avatarFile=null;
    toast(`Welcome, ${name}!`);
  }catch{toast('Failed to create account','error');}
});

// Primal NIP-46
const isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
$('#login-btn').addEventListener('click',openLoginModal);
async function openLoginModal(){$('#login-modal').classList.remove('hidden');$('#login-loading').classList.remove('hidden');$('#login-qr').classList.add('hidden');$('#mobile-login-btn').classList.add('hidden');$('#login-connected').classList.add('hidden');try{const r=await fetch(`/api/nip46/init?origin=${encodeURIComponent(location.origin)}`);nip46Data=await r.json();if(isMobile)$('#mobile-login-btn').classList.remove('hidden');else{$('#qr-image').src=nip46Data.qrDataUrl;$('#login-qr').classList.remove('hidden');}$('#login-loading').classList.add('hidden');waitForNIP46();}catch{toast('Login failed','error');$('#login-modal').classList.add('hidden');}}

$('#mobile-login-btn').addEventListener('click',()=>{if(!nip46Data)return;localStorage.setItem('nip46_pending',JSON.stringify({localSecretKey:nip46Data.secretKey,localPublicKey:nip46Data.publicKey,secret:nip46Data.secret,timestamp:Date.now()}));location.href=nip46Data.mobileURI;});

async function waitForNIP46(){if(!nip46Data)return;try{const{Relay}=await import('https://esm.sh/nostr-tools@2.10.0/relay');const{getConversationKey,decrypt:dec}=await import('https://esm.sh/nostr-tools@2.10.0/nip44');const{hexToBytes}=await import('https://esm.sh/@noble/hashes@1.8.0/utils');const{BunkerSigner}=await import('https://esm.sh/nostr-tools@2.10.0/nip46');const skb=hexToBytes(nip46Data.secretKey);const relay=await Relay.connect('wss://relay.primal.net');relay.subscribe([{kinds:[24133],'#p':[nip46Data.publicKey],limit:0}],{onevent:async ev=>{if(!ev.tags.some(t=>t[0]==='p'&&t[1]===nip46Data.publicKey))return;try{const r=JSON.parse(dec(ev.content,getConversationKey(skb,ev.pubkey)));if(r.result===nip46Data.secret||r.result==='ack'||r.result===true){const s=BunkerSigner.fromBunker(skb,{pubkey:ev.pubkey,relays:['wss://relay.primal.net']},{});let pk;try{pk=await s.getPublicKey();}catch{pk=ev.pubkey;}relay.close();await completeLogin(pk);}}catch{}},oneose:()=>{}});setTimeout(()=>{try{relay.close();}catch{}},300000);}catch{}}

async function completeLogin(pk,dn){const n=dn||pk.slice(0,8)+'...';await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:pk,display_name:n})});const u=await(await fetch(`/api/users/${pk}`)).json();currentUser={pubkey:pk,display_name:u.display_name||n,avatar_path:u.avatar_path};localStorage.setItem('surf_diary_user',JSON.stringify(currentUser));updateAuthUI();$('#login-loading')?.classList.add('hidden');$('#login-qr')?.classList.add('hidden');$('#mobile-login-btn')?.classList.add('hidden');$('#login-connected')?.classList.remove('hidden');setTimeout(()=>{$('#login-modal').classList.add('hidden');toast('Logged in!');},1000);}

async function checkCallback(){const c=localStorage.getItem('nip46_connected');if(!c)return;try{const d=JSON.parse(c);if(Date.now()-d.timestamp>300000){localStorage.removeItem('nip46_connected');return;}const{BunkerSigner}=await import('https://esm.sh/nostr-tools@2.10.0/nip46');const{hexToBytes}=await import('https://esm.sh/@noble/hashes@1.8.0/utils');const s=BunkerSigner.fromBunker(hexToBytes(d.localSecretKey),{pubkey:d.bunkerPubkey,relays:['wss://relay.primal.net']},{});let pk;try{pk=await s.getPublicKey();}catch{pk=d.bunkerPubkey;}localStorage.removeItem('nip46_connected');await completeLogin(pk);}catch{localStorage.removeItem('nip46_connected');}}

$('#login-modal .modal-backdrop').addEventListener('click',()=>$('#login-modal').classList.add('hidden'));
$('#login-modal .modal-close').addEventListener('click',()=>$('#login-modal').classList.add('hidden'));
$('#logout-btn').addEventListener('click',()=>{currentUser=null;followingSet.clear();localStorage.removeItem('surf_diary_user');updateAuthUI();toast('Logged out');});

function updateAuthUI(){if(currentUser){$('#auth-buttons').classList.add('hidden');$('#user-info').classList.remove('hidden');$('#user-name').textContent=currentUser.display_name;const av=$('#user-avatar');if(currentUser.avatar_path){av.src=currentUser.avatar_path;av.style.display='';}else av.style.display='none';$('#submit-btn').disabled=false;$('#submit-btn').textContent='Log Session';$('#comment-form')?.classList.remove('hidden');loadFollowing();}else{$('#auth-buttons').classList.remove('hidden');$('#user-info').classList.add('hidden');$('#submit-btn').disabled=true;$('#submit-btn').textContent='Log in to Log Session';$('#comment-form')?.classList.add('hidden');}}

// ===== FOLLOWS (Nostr kind 3 + server cache) =====
async function loadFollowing(){
  if(!currentUser)return;
  // First load from server cache (fast)
  try{const{following}=await(await fetch('/api/follows',{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();followingSet=new Set(following.map(f=>f.pubkey));}catch{}
  // Then sync from Nostr relay (may update)
  syncFollowsFromRelay();
}

async function toggleFollow(pk){
  if(!currentUser)return toast('Log in first','error');
  const isFollowing=followingSet.has(pk);

  // Update local state immediately
  if(isFollowing)followingSet.delete(pk); else followingSet.add(pk);
  loadSurfers();

  // Update server cache
  await fetch(`/api/follows/${pk}`,{method:isFollowing?'DELETE':'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});

  // Publish kind 3 to Nostr relays
  await publishKind3([...followingSet]);
}
window.toggleFollow=toggleFollow;

async function loadSurfers(){try{const users=await(await fetch('/api/users')).json();const list=$('#surfers-list');if(!users.length){list.innerHTML='<div class="empty-state"><p>No surfers yet.</p></div>';return;}
list.innerHTML=users.map(u=>{const me=currentUser?.pubkey===u.pubkey;const fol=followingSet.has(u.pubkey);let btn;if(me)btn='<button class="btn-follow is-you" disabled>You</button>';else if(!currentUser)btn='';else if(fol)btn=`<button class="btn-follow following" onclick="toggleFollow('${u.pubkey}')">Following</button>`;else btn=`<button class="btn-follow" onclick="toggleFollow('${u.pubkey}')">Follow</button>`;
return`<div class="surfer-card">${u.avatar_path?`<img src="${u.avatar_path}" class="surfer-av">`:`<div class="surfer-av-placeholder">${(u.display_name||'?')[0].toUpperCase()}</div>`}<div class="surfer-info"><div class="surfer-name">${escapeHtml(u.display_name||'Anon')}</div><div class="surfer-meta">${u.session_count} session${u.session_count!==1?'s':''}</div></div>${btn}</div>`;}).join('');}catch{}}

// ===== CONDITIONS =====
$('#session_date').value=new Date().toISOString().split('T')[0];
async function fetchConditions(){const d=$('#session_date').value,t=$('#time_of_day').value,p=$('#conditions-preview');p.innerHTML='<div class="cond-loading">Fetching conditions...</div>';try{const c=await(await fetch(`/api/conditions?date=${d}&time_of_day=${t}`)).json();if(!c.surf_height_min_ft&&!c.swells?.length){p.innerHTML='<div class="cond-loading">No forecast data.</div>';return;}
const sw=(c.swells||[]).map(s=>`<div class="swell-item"><span class="swell-compass">${s.direction_compass}</span><span class="swell-detail">${s.height_ft}ft ${s.period_s}s</span><span class="swell-meta">${s.direction_deg}° · ${s.impact}%</span></div>`).join('');
p.innerHTML=`<div class="cond-grid"><div class="cond-block"><h4>Surf</h4><div class="cond-val">${c.surf_height_min_ft||'?'}-${c.surf_height_max_ft||'?'} ft</div></div><div class="cond-block"><h4>Swells (${c.swells?.length||0})</h4><div class="swells-list">${sw||'—'}</div></div><div class="cond-block"><h4>Wind</h4><div class="cond-val">${c.wind_speed_mph||0} mph</div><div class="cond-sub">${c.wind_type||''} ${c.wind_gust_mph?'gusts '+c.wind_gust_mph:''}</div></div><div class="cond-block"><h4>Tide</h4><div class="cond-val">${c.tide_height_ft||'?'} ft</div></div></div>`;}catch{p.innerHTML='<div class="cond-loading">Could not fetch.</div>';}}
$('#session_date').addEventListener('change',fetchConditions);$('#time_of_day').addEventListener('change',fetchConditions);fetchConditions();

// ===== TABS =====
$$('.shape-tab').forEach(btn=>{btn.addEventListener('click',()=>{
  const group=btn.dataset.group;
  if(group==='session_type'){$$('.shape-tab[data-group="session_type"]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');$('#session_type').value=btn.dataset.val;}
  else{btn.classList.toggle('active');$('#wave_shape').value=[...$$('.shape-tab[data-shape].active')].map(b=>b.dataset.shape).join(',');}
});});
document.querySelector('.shape-tab[data-val="surfed"]')?.classList.add('active');

// ===== RATING =====
const rs=$('#rating'),rd=$('#rating-display');
function updateRating(){const v=+rs.value;rd.textContent=v;const[bg,fg]=v<=3?['#fee2e2','#dc2626']:v<=5?['#fef3c7','#d97706']:v<=7?['#d1fae5','#059669']:['#a7f3d0','#047857'];rd.style.background=bg;rd.style.color=fg;}
rs.addEventListener('input',updateRating);updateRating();

// ===== VOICE =====
const rb=$('#record-btn'),rl=$('#record-label');
function setupSR(){const S=window.SpeechRecognition||window.webkitSpeechRecognition;if(!S)return null;const r=new S();r.continuous=true;r.interimResults=true;r.lang='en-US';let ft='';r.onresult=e=>{let i='';for(let x=e.resultIndex;x<e.results.length;x++){if(e.results[x].isFinal)ft+=e.results[x][0].transcript+' ';else i+=e.results[x][0].transcript;}voiceTranscript=ft.trim();$('#transcript-text').textContent=ft+i;$('#transcript-section').classList.remove('hidden');};r.onerror=()=>{};r.onend=()=>$('#transcript-text')?.classList.remove('listening');return{recognition:r,reset:()=>{ft='';}};}
rb.addEventListener('mousedown',startRec);rb.addEventListener('mouseup',stopRec);rb.addEventListener('mouseleave',stopRec);
rb.addEventListener('touchstart',e=>{e.preventDefault();startRec();});rb.addEventListener('touchend',e=>{e.preventDefault();stopRec();});
async function startRec(){if(mediaRecorder?.state==='recording')return;try{const s=await navigator.mediaDevices.getUserMedia({audio:true});recordingChunks=[];mediaRecorder=new MediaRecorder(s,{mimeType:'audio/webm;codecs=opus'});mediaRecorder.ondataavailable=e=>{if(e.data.size>0)recordingChunks.push(e.data);};mediaRecorder.onstop=()=>{s.getTracks().forEach(t=>t.stop());voiceBlob=new Blob(recordingChunks,{type:'audio/webm'});$('#voice-audio').src=URL.createObjectURL(voiceBlob);$('#voice-playback').classList.remove('hidden');};mediaRecorder.start(100);const sr=setupSR();if(sr){speechRecognition=sr.recognition;sr.reset();voiceTranscript='';$('#transcript-text').textContent='';$('#transcript-text').classList.add('listening');$('#transcript-section').classList.remove('hidden');speechRecognition.start();}rb.classList.add('recording');rl.textContent='Release to stop';$('#recording-status').classList.remove('hidden');recordingSeconds=0;updTimer();recordingTimer=setInterval(()=>{recordingSeconds++;updTimer();},1000);}catch{toast('Mic denied','error');}}
function stopRec(){if(!mediaRecorder||mediaRecorder.state!=='recording')return;mediaRecorder.stop();if(speechRecognition){speechRecognition.stop();speechRecognition=null;}clearInterval(recordingTimer);rb.classList.remove('recording');rl.textContent='Voice Note';$('#recording-status').classList.add('hidden');}
function updTimer(){$('#record-timer').textContent=`${Math.floor(recordingSeconds/60)}:${(recordingSeconds%60).toString().padStart(2,'0')}`;}
$('#delete-voice').addEventListener('click',()=>{voiceBlob=null;voiceTranscript='';$('#voice-audio').src='';$('#voice-playback').classList.add('hidden');$('#transcript-section').classList.add('hidden');});

// ===== VIDEO =====
$('#video-file').addEventListener('change',e=>{videoFile=e.target.files[0];if(!videoFile)return;$('#video-player').src=URL.createObjectURL(videoFile);$('#video-preview').classList.remove('hidden');});
$('#delete-video').addEventListener('click',()=>{videoFile=null;$('#video-player').src='';$('#video-preview').classList.add('hidden');$('#video-file').value='';});

// ===== FORM =====
$('#session-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!currentUser)return toast('Log in first','error');
  const data={session_date:$('#session_date').value,time_of_day:$('#time_of_day').value,rating:+$('#rating').value,wave_shape:$('#wave_shape').value||null,session_type:$('#session_type').value||'surfed',notes:$('#notes').value||null,voice_transcript:voiceTranscript||null};

  try{
    $('#submit-btn').disabled=true;$('#submit-btn').textContent='Uploading...';

    // Upload media to Blossom first (if local account with secretKey)
    if(voiceBlob){
      const voiceFile=new File([voiceBlob],'voice.webm',{type:'audio/webm'});
      const url=await uploadToBlossom(voiceFile);
      if(url)data.voice_url=url;
      else{const r=new FileReader();data.voice_memo_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(voiceBlob);});}
    }
    if(videoFile){
      const url=await uploadToBlossom(videoFile);
      if(url)data.video_url=url;
      else{const r=new FileReader();data.video_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(videoFile);});}
    }

    $('#submit-btn').textContent='Logging...';
    const res=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify(data)});
    if(res.ok){
      toast('Session logged!');$('#notes').value='';rs.value=5;updateRating();
      $$('.shape-tab[data-shape]').forEach(b=>b.classList.remove('active'));$('#wave_shape').value='';
      $$('.shape-tab[data-group="session_type"]').forEach(b=>b.classList.remove('active'));document.querySelector('.shape-tab[data-val="surfed"]')?.classList.add('active');$('#session_type').value='surfed';
      voiceBlob=null;voiceTranscript='';$('#voice-audio').src='';$('#voice-playback').classList.add('hidden');$('#transcript-section').classList.add('hidden');
      videoFile=null;$('#video-player').src='';$('#video-preview').classList.add('hidden');$('#video-file').value='';
    }else{const err=await res.json();toast(err.error||'Failed','error');}
  }catch(err){console.error(err);toast('Upload error','error');}
  finally{$('#submit-btn').disabled=!currentUser;$('#submit-btn').textContent=currentUser?'Log Session':'Log in to Log Session';}
});

// ===== FEED =====
async function loadSessions(){const dir=$('#filter-direction').value,mo=$('#filter-month').value,p=new URLSearchParams();if(currentUser)p.set('feed_for',currentUser.pubkey);if(dir)p.set('swell_dir',dir);if(mo)p.set('month',mo);
try{const{sessions}=await(await fetch(`/api/sessions?${p}`)).json();const list=$('#session-list');if(!sessions.length){list.innerHTML='<div class="empty-state"><p>No sessions yet. Log one or follow surfers!</p></div>';return;}
list.innerHTML=sessions.map(s=>{const d=new Date(s.session_date+'T12:00:00'),tags=[],sw=JSON.parse(s.swells_json||'[]');
sw.forEach(x=>tags.push(`<span class="tag tag-swell">${x.height_ft}ft ${x.period_s}s ${x.direction_compass} ${x.direction_deg}°</span>`));
if(s.surf_height_min_ft!=null)tags.push(`<span class="tag tag-height">${s.surf_height_min_ft}-${s.surf_height_max_ft}ft</span>`);
if(s.wind_type)tags.push(`<span class="tag tag-wind">${s.wind_speed_mph||''}mph ${s.wind_type}</span>`);
if(s.session_type==='observed')tags.push('<span class="tag tag-observed">observed</span>');
if(s.wave_shape)tags.push(`<span class="tag tag-shape">${s.wave_shape}</span>`);
if(s.video_path)tags.push('<span class="tag tag-video">📹 video</span>');
if(s.voice_memo_path)tags.push('<span class="tag tag-voice">🎙</span>');
const videoThumb=s.video_path?`<div class="feed-video-thumb"><video src="${s.video_path}" preload="metadata" muted></video></div>`:'';
return`<div class="feed-card" data-id="${s.id}"><div class="feed-date"><div class="day">${d.getDate()}</div><div class="mo">${d.toLocaleString('en',{month:'short'})}</div></div><div class="feed-body"><div class="feed-user">${avatarHTML(s.avatar_path,s.display_name)}<span class="feed-name">${escapeHtml(s.display_name||'Anon')}</span><span class="feed-tod">· ${formatTOD(s.time_of_day)}</span></div><div class="feed-tags">${tags.join('')}</div>${videoThumb}</div><div class="feed-rating">${s.rating?`<div class="rbadge ${getRatingClass(s.rating)}">${s.rating}</div>`:'<div class="rbadge" style="background:#f1f5f9;color:#94a3b8">—</div>'}</div></div>`;}).join('');
list.querySelectorAll('.feed-card').forEach(c=>c.addEventListener('click',()=>openSession(c.dataset.id)));}catch{$('#session-list').innerHTML='<div class="empty-state">Error loading</div>';}}
$('#filter-direction').addEventListener('change',loadSessions);$('#filter-month').addEventListener('change',loadSessions);

// ===== DETAIL =====
async function openSession(id){try{const{session:s,comments}=await(await fetch(`/api/sessions/${id}`)).json();const d=new Date(s.session_date+'T12:00:00');const dateStr=d.toLocaleDateString('en',{weekday:'long',year:'numeric',month:'long',day:'numeric'});const sw=JSON.parse(s.swells_json||'[]');
const swH=sw.map((x,i)=>`<div class="detail-block"><h4>${i?'Secondary':'Primary'} Swell</h4><p>${x.height_ft}ft ${x.period_s}s ${x.direction_compass} ${x.direction_deg}° <small style="opacity:.5">(${x.impact}%)</small></p></div>`).join('');
$('#session-detail').innerHTML=`<h2>${dateStr}</h2><p class="muted">${escapeHtml(s.display_name||'Anon')} · ${formatTOD(s.time_of_day)}</p><div style="margin:.75rem 0"><div class="rbadge ${getRatingClass(s.rating)}" style="width:52px;height:52px;font-size:1.3rem;display:inline-flex">${s.rating||'—'}/10</div></div><div class="detail-grid"><div class="detail-block"><h4>Surf</h4><p>${s.surf_height_min_ft||'?'}–${s.surf_height_max_ft||'?'} ft</p></div>${swH}<div class="detail-block"><h4>Wind</h4><p>${s.wind_speed_mph||'?'} mph ${s.wind_type?'('+s.wind_type+')':''}</p></div><div class="detail-block"><h4>Tide</h4><p>${s.tide_height_ft||'?'} ft</p></div>${s.wave_shape?`<div class="detail-block"><h4>Shape</h4><p style="text-transform:capitalize">${s.wave_shape}</p></div>`:''}</div>${s.video_path?`<div class="detail-video"><video controls src="${s.video_path}" preload="metadata"></video></div>`:''}${s.voice_memo_path?`<div class="detail-voice"><audio controls src="${s.voice_memo_path}" style="width:100%;height:36px"></audio>${s.voice_transcript?`<div class="detail-transcript">"${escapeHtml(s.voice_transcript)}"</div>`:''}</div>`:''}${s.notes?`<div class="detail-notes">${escapeHtml(s.notes)}</div>`:''}`;
$('#comments-list').innerHTML=comments.length?comments.map(c=>`<div class="comment"><div class="comment-meta">${escapeHtml(c.display_name||'Anon')} · ${new Date(c.created_at*1000).toLocaleDateString()}</div><div class="comment-body">${escapeHtml(c.body)}</div></div>`).join(''):'<p class="muted" style="font-size:.82rem">No comments yet</p>';
$('#comment-form').onsubmit=async e=>{e.preventDefault();if(!currentUser)return;const b=$('#comment-body').value.trim();if(!b)return;await fetch(`/api/sessions/${id}/comments`,{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({body:b})});$('#comment-body').value='';openSession(id);};
$('#session-modal').classList.remove('hidden');}catch{toast('Error','error');}}
$('#session-modal .modal-backdrop').addEventListener('click',()=>$('#session-modal').classList.add('hidden'));
$('#session-modal .modal-close').addEventListener('click',()=>$('#session-modal').classList.add('hidden'));

// ===== SEARCH =====
$('#search-btn').addEventListener('click',runSearch);
$('#search-clear').addEventListener('click',()=>{['search-dir-min','search-dir-max','search-height-min','search-height-max','search-period-min','search-period-max','search-rating-min','search-rating-max'].forEach(id=>$(`#${id}`).value='');$('#search-results').innerHTML='';});
async function runSearch(){const p=new URLSearchParams();if(currentUser)p.set('pubkey',currentUser.pubkey);const fields={dir_min:'search-dir-min',dir_max:'search-dir-max',height_min:'search-height-min',height_max:'search-height-max',period_min:'search-period-min',period_max:'search-period-max',rating_min:'search-rating-min',rating_max:'search-rating-max'};Object.entries(fields).forEach(([k,id])=>{const v=$(`#${id}`).value;if(v)p.set(k,v);});
try{const{sessions,summary}=await(await fetch(`/api/search?${p}`)).json();const sr=$('#search-results');if(!sessions.length){sr.innerHTML='<div class="empty-state"><p>No matches.</p></div>';return;}
sr.innerHTML=`<div class="search-summary"><div class="search-stat"><span class="search-stat-label">Sessions</span><span class="search-stat-value">${summary.count}</span></div><div class="search-stat"><span class="search-stat-label">Avg Rating</span><span class="search-stat-value">${summary.avg_rating||'—'}/10</span></div><div class="search-stat"><span class="search-stat-label">Best</span><span class="search-stat-value">${summary.best_rating||'—'}/10</span></div><div class="search-stat"><span class="search-stat-label">Worst</span><span class="search-stat-value">${summary.worst_rating||'—'}/10</span></div></div><div class="search-result-list">${sessions.map(s=>{const d=new Date(s.session_date+'T12:00:00'),sw=JSON.parse(s.swells_json||'[]');const swTags=sw.map(x=>`<span class="tag tag-swell">${x.height_ft}ft ${x.period_s}s ${x.direction_compass} ${x.direction_deg}°</span>`).join('');return`<div class="feed-card" data-id="${s.id}" onclick="openSession(${s.id})"><div class="feed-date"><div class="day">${d.getDate()}</div><div class="mo">${d.toLocaleString('en',{month:'short'})}</div></div><div class="feed-body"><div class="feed-user">${avatarHTML(s.avatar_path,s.display_name)}<span class="feed-name">${escapeHtml(s.display_name||'Anon')}</span><span class="feed-tod">· ${formatTOD(s.time_of_day)}</span></div><div class="feed-tags">${swTags}${s.surf_height_min_ft!=null?`<span class="tag tag-height">${s.surf_height_min_ft}-${s.surf_height_max_ft}ft</span>`:''}${s.wind_type?`<span class="tag tag-wind">${s.wind_speed_mph}mph ${s.wind_type}</span>`:''}</div></div><div class="feed-rating">${s.rating?`<div class="rbadge ${getRatingClass(s.rating)}">${s.rating}</div>`:'<div class="rbadge" style="background:#f1f5f9;color:#94a3b8">—</div>'}</div></div>`;}).join('')}</div>`;}catch{$('#search-results').innerHTML='<div class="empty-state">Search failed</div>';}}
window.openSession=openSession;

// ===== ANALYSIS =====
async function loadAnalysis(){try{const q=currentUser?`?pubkey=${currentUser.pubkey}`:'';const[dr,br,tr]=await Promise.all([fetch('/api/analysis/by-direction'+q),fetch('/api/analysis/best-conditions'+q),fetch('/api/analysis/timeline'+q)]);const[dirs,best,tl]=await Promise.all([dr.json(),br.json(),tr.json()]);
$('#direction-analysis').innerHTML=!dirs.length?'<p class="empty-state">Log sessions to see patterns!</p>':`<table class="analysis-table"><thead><tr><th>Dir</th><th>#</th><th>Rating</th><th>Avg Swell</th></tr></thead><tbody>${dirs.map(d=>`<tr><td><span class="dir-badge">${d.direction}</span></td><td>${d.session_count}</td><td class="bar-cell"><div class="bar-bg" style="width:${(d.avg_rating/10)*100}%;background:var(--teal)"></div><span class="bar-value">${d.avg_rating}/10</span></td><td>${d.avg_swell_height||'-'}ft ${d.avg_swell_period||'-'}s</td></tr>`).join('')}</tbody></table>`;
$('#best-conditions').innerHTML=!best.length?'<p class="empty-state">Need 2+ sessions per combo</p>':`<table class="analysis-table"><thead><tr><th>Dir</th><th>Swell</th><th>Period</th><th>Wind</th><th>#</th><th>Avg</th></tr></thead><tbody>${best.map(b=>`<tr><td><span class="dir-badge">${b.direction}</span></td><td>${b.swell_bucket}</td><td>${b.period_bucket}</td><td>${b.wind_type}</td><td>${b.count}</td><td><strong>${b.avg_rating}/10</strong></td></tr>`).join('')}</tbody></table>`;
$('#timeline-chart').innerHTML=!tl.length?'<p class="empty-state">Log sessions first</p>':tl.map(t=>{const r=t.avg_rating||0;const c=r>=8?'var(--teal)':r>=5?'var(--gold)':r>=3?'#f97316':'var(--coral)';const d=new Date(t.session_date+'T12:00:00');return`<div class="timeline-row"><div class="timeline-date">${d.toLocaleDateString('en',{month:'short',day:'numeric'})}</div><div class="timeline-bar"><div class="timeline-fill" style="width:${Math.max(r/10*100,8)}%;background:${c}">${r}</div></div><div class="timeline-info">${t.avg_min}-${t.avg_max}ft ${t.directions||''}</div></div>`;}).join('');}catch(e){console.error(e);}}

// ===== INIT =====
const saved=localStorage.getItem('surf_diary_user');if(saved)currentUser=JSON.parse(saved);
updateAuthUI();checkCallback();
