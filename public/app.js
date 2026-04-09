import{generateSecretKey,getPublicKey,nip19,finalizeEvent,Relay,getConversationKey,decrypt as nip44Decrypt,encrypt as nip44Encrypt,BunkerSigner,bytesToHex,hexToBytes,sha256}from'/nostr-bundle.js';
console.log('[SWELLNOTES] Bundle loaded OK, generateSecretKey=',typeof generateSecretKey);
let currentUser=null,currentSpot=null,mySpots=[],followingSet=new Set(),voiceBlob=null,voiceTranscript='',mediaRecorder=null,recordingChunks=[],recordingTimer=null,recordingSeconds=0,nip46Data=null,speechRecognition=null,videoFile=null,avatarFile=null,coverFile=null,pendingSpotData=null;
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const BLOSSOM='https://blossom.primal.net';
const RELAYS=['wss://relay.primal.net','wss://relay.damus.io','wss://nos.lol'];
const IS_CAPACITOR=!!window.Capacitor;
const API_BASE=IS_CAPACITOR?'https://swellnotes.com':'';
const DEFAULT_COVERS=[
  'https://images.unsplash.com/photo-1502933691298-84fc14542831?w=800&q=80',
  'https://images.unsplash.com/photo-1509914398892-963f53e6e2f1?w=800&q=80',
  'https://images.unsplash.com/photo-1416163781743-2430b42aae93?w=800&q=80',
];
function defaultCover(id){return DEFAULT_COVERS[Math.abs([...((id||'')+'x')].reduce((h,c)=>((h<<5)-h)+c.charCodeAt(0),0))%DEFAULT_COVERS.length];}

// Nav
$$('.nav-btn[data-view]').forEach(b=>{b.addEventListener('click',()=>{$$('.nav-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.view').forEach(v=>v.classList.remove('active'));$(`#view-${b.dataset.view}`).classList.add('active');if(b.dataset.view==='history')loadFeed();if(b.dataset.view==='surfers')loadSurfers();if(b.dataset.view==='analysis')loadAnalysis();if(b.dataset.view==='pipeline')loadPipeline();});});

function toast(m,t='success'){const e=document.createElement('div');e.className=`toast toast-${t}`;e.textContent=m;document.body.appendChild(e);setTimeout(()=>e.remove(),3000);}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function getRatingClass(r){if(!r)return'';return r<=3?'r-low':r<=5?'r-mid':r<=7?'r-high':'r-epic';}
function formatTOD(t){return{'5am':'5 AM','6am':'6 AM','7am':'7 AM','8am':'8 AM','9am':'9 AM','10am':'10 AM','11am':'11 AM','12pm':'12 PM','1pm':'1 PM','2pm':'2 PM','3pm':'3 PM','4pm':'4 PM','5pm':'5 PM','6pm':'6 PM',dawn:'Dawn',morning:'AM',midday:'Midday',afternoon:'PM',evening:'Eve'}[t]||t;}
function avatarHTML(path,name,cls='feed-avatar'){if(path)return`<img src="${path}" class="${cls}" alt="">`;const i=(name||'?')[0].toUpperCase();return`<div class="${cls}-placeholder">${i}</div>`;}
function primalLink(pubkey){return`https://primal.net/p/${pubkey}`;}
function userLinkHTML(pubkey,name,avatarPath,cls='feed'){
  const url=primalLink(pubkey);
  const av=avatarPath?`<img src="${avatarPath}" class="${cls}-avatar" alt="">`:`<div class="${cls}-avatar-placeholder">${(name||'?')[0].toUpperCase()}</div>`;
  return`<a href="${url}" target="_blank" rel="noopener" class="user-link" onclick="event.stopPropagation()">${av}<span class="${cls}-name">${escapeHtml(name||'Anon')}</span></a>`;
}

// ===== SPOT STATE =====
function selectSpot(spot){
  if(!spot||spot.error){console.error('Invalid spot:',spot);return;}
  currentSpot=spot;
  localStorage.setItem('swellnotes_spot',JSON.stringify(spot));
  $('#spot-picker')?.classList.add('hidden');
  $('#app-header').classList.remove('hidden');
  $('#hero').classList.remove('hidden');
  document.body.style.overflow='';
  $('#main-content')?.classList.remove('hidden');
  $('#header-spot-name').textContent=spot.name;$('#header-spot-name').style.display='';
  $('#hero-title').textContent=spot.name;
  $('#hero-sub').textContent=spot.location_text||'Track the swell. Rate your sessions.';
  if(spot.cover_image_url){$('#hero-img').src=spot.cover_image_url;$('#hero-img').style.display='';}
  else{$('#hero-img').src=defaultCover(spot.id);$('#hero-img').style.display='';}
  document.title=`${spot.name} · Swellnotes`;
  // Show spot settings + cover edit if admin
  if(currentUser){
    const mem=spot.members?.find(m=>m.pubkey===currentUser.pubkey);
    if(mem?.role==='admin'){$('#spot-settings-btn').classList.remove('hidden');$('#invite-btn').classList.remove('hidden');$('#hero-cover-btn').classList.remove('hidden');}
    else{$('#spot-settings-btn').classList.add('hidden');$('#invite-btn').classList.add('hidden');$('#hero-cover-btn').classList.add('hidden');}
  }
  fetchConditions();
  updateSpotSwitcher();
  // Reload the active view for the new spot
  const activeView=$('.nav-btn.active')?.dataset?.view;
  if(activeView==='analysis')loadAnalysis();
  if(activeView==='history')loadFeed();
  if(activeView==='surfers')loadSurfers();
}

async function loadMySpots(){
  if(!currentUser)return;
  try{mySpots=await(await fetch(API_BASE+'/api/spots',{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();updateSpotSwitcher();}catch{}
}

function updateSpotSwitcher(){
  if(mySpots.length<=1){$('#spot-switcher').classList.add('hidden');return;}
  $('#spot-switcher').classList.remove('hidden');
  const sel=$('#spot-select');
  sel.innerHTML=mySpots.map(s=>`<option value="${s.id}" ${currentSpot?.id===s.id?'selected':''}>${s.name}</option>`).join('');
}

$('#spot-select').addEventListener('change',async e=>{
  const spot=mySpots.find(s=>s.id===e.target.value);
  if(spot){const full=await(await fetch(`${API_BASE}/api/spots/${spot.id}`,{headers:currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{}})).json();selectSpot(full);}
});

// ===== SPOT SEARCH =====
let searchTimeout;
$('#spot-search-input').addEventListener('input',e=>{
  clearTimeout(searchTimeout);
  const q=e.target.value.trim();
  if(q.length<2){$('#spot-search-results').innerHTML='';return;}
  searchTimeout=setTimeout(async()=>{
    try{
      const results=await(await fetch(`${API_BASE}/api/spots/search?q=${encodeURIComponent(q)}`)).json();
      $('#spot-search-results').innerHTML=results.map(r=>`
        <div class="spot-result" data-surfline="${r.surfline_id}" data-name="${escapeHtml(r.name)}" data-loc="${escapeHtml(r.location)}" data-lat="${r.lat}" data-lng="${r.lng}">
          <div class="spot-result-icon">🌊</div>
          <div><div class="spot-result-name">${escapeHtml(r.name)}</div><div class="spot-result-loc">${escapeHtml(r.location)}</div></div>
        </div>
      `).join('')||'<p class="muted" style="padding:1rem;text-align:center">No spots found</p>';
      $$('.spot-result').forEach(el=>el.addEventListener('click',()=>{
        if(!currentUser)return toast('Create an account first','error');
        pendingSpotData={surfline_spot_id:el.dataset.surfline,name:el.dataset.name,location_text:el.dataset.loc,lat:parseFloat(el.dataset.lat),lng:parseFloat(el.dataset.lng)};
        $('#create-spot-name').textContent=`${el.dataset.name} · ${el.dataset.loc}`;
        $('#create-spot-modal').classList.remove('hidden');
      }));
    }catch{}
  },300);
});

// Show user's existing spots
async function showMySpots(){
  if(!currentUser||!mySpots.length){$('#my-spots-section').classList.add('hidden');return;}
  $('#my-spots-section').classList.remove('hidden');
  $('#my-spots-list').innerHTML=mySpots.map(s=>`
    <div class="spot-result" onclick="joinExistingSpot('${s.id}')">
      <div class="spot-result-icon">${`<img src="${s.cover_image_url||defaultCover(s.id)}" style="width:36px;height:36px;border-radius:8px;object-fit:cover">`}</div>
      <div><div class="spot-result-name">${escapeHtml(s.name)}</div><div class="spot-result-loc">${s.member_count||'?'} members</div></div>
    </div>
  `).join('');
}
window.joinExistingSpot=async id=>{const spot=await(await fetch(`${API_BASE}/api/spots/${id}`,{headers:currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{}})).json();selectSpot(spot);};

// ===== CREATE SPOT =====
// Hero cover photo (admin only)
$('#hero-cover-btn').addEventListener('click',()=>$('#hero-cover-file').click());
$('#hero-cover-file').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file||!currentUser||!currentSpot)return;
  try{
    $('#hero-cover-btn').textContent='Uploading...';$('#hero-cover-btn').disabled=true;
    let url=await uploadToBlossom(file);
    if(!url){const r=new FileReader();const b64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(file);});
      // No blossom fallback — just skip for now
      toast('Upload failed','error');return;
    }
    await fetch(`${API_BASE}/api/spots/${currentSpot.id}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({cover_image_url:url})});
    $('#hero-img').src=url;currentSpot.cover_image_url=url;
    toast('Cover updated!');
  }catch{toast('Failed','error');}
  finally{$('#hero-cover-btn').textContent='📷 Change Cover';$('#hero-cover-btn').disabled=false;}
});

$('#create-spot-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!currentUser||!pendingSpotData)return;
  try{
    const body={...pendingSpotData,is_private:$('#spot-private').checked,region:$('#spot-region')?.value.trim()||null,description:$('#spot-description')?.value.trim()||null};
    const res=await fetch(API_BASE+'/api/spots',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify(body)});
    const data=await res.json();
    if(data.ok){
      const spot=await(await fetch(`${API_BASE}/api/spots/${data.id}`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();
      await loadMySpots();
      selectSpot(spot);
      $('#create-spot-modal').classList.add('hidden');
      coverFile=null;pendingSpotData=null;
      toast(`${spot.name} crew created!`);
    }
  }catch{toast('Failed to create crew','error');}
});

$('#create-spot-modal .modal-backdrop').addEventListener('click',()=>$('#create-spot-modal').classList.add('hidden'));
$('#create-spot-modal .modal-close').addEventListener('click',()=>$('#create-spot-modal').classList.add('hidden'));

// ===== INVITES =====
$('#invite-btn').addEventListener('click',async()=>{
  if(!currentSpot||!currentUser)return;
  try{
    const res=await fetch(`${API_BASE}/api/spots/${currentSpot.id}/invites`,{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({})});
    const data=await res.json();
    $('#invite-link-input').value=data.link||`${location.origin}/join/${data.invite_code}`;
    $('#invite-modal').classList.remove('hidden');
  }catch{toast('Failed to create invite','error');}
});
$('#copy-invite').addEventListener('click',()=>{$('#invite-link-input').select();navigator.clipboard?.writeText($('#invite-link-input').value);toast('Copied!');});
$('#invite-modal .modal-backdrop').addEventListener('click',()=>$('#invite-modal').classList.add('hidden'));
$('#invite-modal .modal-close').addEventListener('click',()=>$('#invite-modal').classList.add('hidden'));

// Crew Settings
let crewCoverFile=null;
$('#spot-settings-btn').addEventListener('click',()=>{
  if(!currentSpot)return;
  $('#crew-settings-name').value=currentSpot.name||'';
  $('#crew-settings-region').value=currentSpot.region||'';
  $('#crew-settings-description').value=currentSpot.description||'';
  $('#crew-settings-private').checked=!!currentSpot.is_private;
  if(currentSpot.cover_image_url){$('#crew-cover-preview').innerHTML=`<img src="${currentSpot.cover_image_url}">`;}
  else{$('#crew-cover-preview').innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>Change Cover Photo</span>';}
  crewCoverFile=null;
  $('#crew-settings-modal').classList.remove('hidden');
});
$('#crew-cover-upload').addEventListener('click',()=>$('#crew-cover-file').click());
$('#crew-cover-file').addEventListener('change',e=>{crewCoverFile=e.target.files[0];if(!crewCoverFile)return;const r=new FileReader();r.onload=ev=>{$('#crew-cover-preview').innerHTML=`<img src="${ev.target.result}">`};r.readAsDataURL(crewCoverFile);});
$('#crew-settings-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!currentSpot||!currentUser)return;
  try{
    const body={name:$('#crew-settings-name').value.trim(),region:$('#crew-settings-region').value.trim()||null,description:$('#crew-settings-description').value.trim()||null,is_private:$('#crew-settings-private').checked};
    if(crewCoverFile){const url=await uploadToBlossom(crewCoverFile);if(url)body.cover_image_url=url;}
    await fetch(`${API_BASE}/api/spots/${currentSpot.id}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify(body)});
    const spot=await(await fetch(`${API_BASE}/api/spots/${currentSpot.id}`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();
    await loadMySpots();selectSpot(spot);
    $('#crew-settings-modal').classList.add('hidden');crewCoverFile=null;
    toast('Crew updated!');
  }catch{toast('Failed to update','error');}
});
$('#crew-settings-modal .modal-backdrop').addEventListener('click',()=>$('#crew-settings-modal').classList.add('hidden'));
$('#crew-settings-modal .modal-close').addEventListener('click',()=>$('#crew-settings-modal').classList.add('hidden'));

// ===== BLOSSOM UPLOAD =====
async function uploadToBlossom(file){
  if(!currentUser?.secretKey)return null;
  try{
    /* finalizeEvent from bundle */
    /* hexToBytes,bytesToHex from bundle */
    /* sha256 from bundle */
    const buf=await file.arrayBuffer();const hash=bytesToHex(sha256(new Uint8Array(buf)));const now=Math.floor(Date.now()/1000);
    const ev=finalizeEvent({kind:24242,created_at:now,tags:[['t','upload'],['x',hash],['expiration',String(now+300)]],content:'Upload file'},hexToBytes(currentUser.secretKey));
    const res=await fetch(`${BLOSSOM}/upload`,{method:'PUT',headers:{'Authorization':'Nostr '+btoa(JSON.stringify(ev)),'Content-Type':file.type||'application/octet-stream'},body:buf});
    if(!res.ok)throw new Error(res.status);const data=await res.json();return data.url||`${BLOSSOM}/${hash}`;
  }catch(err){console.error('Blossom:',err);return null;}
}

// ===== PROFILE (kind 0) + FOLLOWS (kind 3) =====
async function fetchProfile(pk){
  // Try Primal's cache API first (fast, reliable)
  try{
    const r=await fetch('https://cache1.primal.net/api/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(["user_infos",{"pubkeys":[pk]}])});
    if(r.ok){const data=await r.json();const profile=data?.find(e=>e.kind===0&&e.pubkey===pk);if(profile)return JSON.parse(profile.content);}
  }catch(e){console.log('Primal cache fetch failed:',e);}
  // Fallback: fetch from relay directly
  try{/* Relay from bundle */const relay=await Relay.connect(RELAYS[0]);return new Promise(r=>{let ev=null;relay.subscribe([{kinds:[0],authors:[pk],limit:1}],{onevent:e=>{if(!ev||e.created_at>ev.created_at)ev=e;},oneose:()=>{relay.close();try{r(ev?JSON.parse(ev.content):null);}catch{r(null);}}});setTimeout(()=>{try{relay.close();}catch{}r(null);},5000);});}catch{return null;}
}
async function publishProfile(name,pic){if(!currentUser?.secretKey)return;try{/* finalizeEvent from bundle *//* Relay from bundle *//* hexToBytes from bundle */const ex=await fetchProfile(currentUser.pubkey)||{};const p={...ex,name};if(pic)p.picture=pic;const ev=finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify(p)},hexToBytes(currentUser.secretKey));for(const u of RELAYS){try{const r=await Relay.connect(u);await r.publish(ev);r.close();}catch{}}}catch{}}
async function fetchKind3(pk){try{/* Relay from bundle */const relay=await Relay.connect(RELAYS[0]);return new Promise(r=>{let ev=null;relay.subscribe([{kinds:[3],authors:[pk],limit:1}],{onevent:e=>{if(!ev||e.created_at>ev.created_at)ev=e;},oneose:()=>{relay.close();r(ev);}});setTimeout(()=>{try{relay.close();}catch{}r(ev);},5000);});}catch{return null;}}
async function publishKind3(pks){if(!currentUser?.secretKey)return;try{/* finalizeEvent from bundle *//* Relay from bundle *//* hexToBytes from bundle */const ev=finalizeEvent({kind:3,created_at:Math.floor(Date.now()/1000),tags:pks.map(p=>['p',p]),content:''},hexToBytes(currentUser.secretKey));for(const u of RELAYS){try{const r=await Relay.connect(u);await r.publish(ev);r.close();}catch{}}}catch{}}
async function syncFollowsFromRelay(){if(!currentUser)return;const ev=await fetchKind3(currentUser.pubkey);if(!ev)return;const pks=ev.tags.filter(t=>t[0]==='p').map(t=>t[1]);followingSet=new Set(pks);for(const pk of pks){try{await fetch(`${API_BASE}/api/follows/${pk}`,{method:'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});}catch{}}}

// ===== LANDING PAGE AUTH =====
let landingAvatarFile=null;
$('#landing-avatar-preview').addEventListener('click',e=>{e.stopPropagation();$('#landing-avatar-file').click();});
$('#landing-avatar-file').addEventListener('change',e=>{landingAvatarFile=e.target.files[0];if(!landingAvatarFile)return;const r=new FileReader();r.onload=ev=>{$('#landing-avatar-preview').innerHTML=`<img src="${ev.target.result}">`};r.readAsDataURL(landingAvatarFile);});
$('#landing-primal-btn').addEventListener('click',openLoginModal);

$('#landing-create-form').addEventListener('submit',async e=>{
  e.preventDefault();const name=$('#landing-create-name').value.trim();if(!name)return;
  $('#landing-submit-btn').disabled=true;$('#landing-submit-btn').classList.add('hidden');$('#landing-loading').classList.remove('hidden');
  try{/* generateSecretKey,getPublicKey,bytesToHex from bundle */
  const sk=generateSecretKey(),secretKey=bytesToHex(sk),pubkey=getPublicKey(sk);
  currentUser={pubkey,secretKey,display_name:name,avatar_path:null};
  let avatarUrl=null;if(landingAvatarFile)avatarUrl=await uploadToBlossom(landingAvatarFile);
  const body={pubkey,display_name:name};if(avatarUrl)body.avatar_url=avatarUrl;
  else if(landingAvatarFile){const r=new FileReader();body.avatar_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(landingAvatarFile);});}
  const res=await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json();currentUser.avatar_path=data.avatar_path||avatarUrl;
  localStorage.setItem('swellnotes_user',JSON.stringify(currentUser));
  await publishProfile(name,avatarUrl);
  updateAuthUI();landingAvatarFile=null;toast(`Welcome, ${name}!`);
  }catch(err){toast('Failed: '+err.message,'error');console.error('Account create error:',err);}
  finally{$('#landing-submit-btn').disabled=false;$('#landing-submit-btn').classList.remove('hidden');$('#landing-loading').classList.add('hidden');}
});

// ===== AUTH =====
$('#create-account-btn').addEventListener('click',()=>$('#create-modal').classList.remove('hidden'));
$('#create-modal .modal-backdrop').addEventListener('click',()=>$('#create-modal').classList.add('hidden'));
$('#create-modal .modal-close').addEventListener('click',()=>$('#create-modal').classList.add('hidden'));
$('#switch-to-primal').addEventListener('click',()=>{$('#create-modal').classList.add('hidden');openLoginModal();});

$('#avatar-upload').addEventListener('click',()=>$('#avatar-file').click());
$('#avatar-file').addEventListener('change',e=>{avatarFile=e.target.files[0];if(!avatarFile)return;const r=new FileReader();r.onload=ev=>{$('#avatar-preview').innerHTML=`<img src="${ev.target.result}">`};r.readAsDataURL(avatarFile);});

$('#create-form').addEventListener('submit',async e=>{
  e.preventDefault();const name=$('#create-name').value.trim();if(!name)return;
  $('#create-submit-btn').disabled=true;$('#create-submit-btn').classList.add('hidden');$('#create-loading').classList.remove('hidden');
  try{/* generateSecretKey,getPublicKey,bytesToHex from bundle */
  const sk=generateSecretKey(),secretKey=bytesToHex(sk),pubkey=getPublicKey(sk);
  currentUser={pubkey,secretKey,display_name:name,avatar_path:null};
  let avatarUrl=null;if(avatarFile)avatarUrl=await uploadToBlossom(avatarFile);
  const body={pubkey,display_name:name};if(avatarUrl)body.avatar_url=avatarUrl;
  else if(avatarFile){const r=new FileReader();body.avatar_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(avatarFile);});}
  const res=await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json();currentUser.avatar_path=data.avatar_path||avatarUrl;
  localStorage.setItem('swellnotes_user',JSON.stringify(currentUser));
  await publishProfile(name,avatarUrl);
  updateAuthUI();$('#create-modal').classList.add('hidden');avatarFile=null;toast(`Welcome, ${name}!`);
  }catch{toast('Failed','error');}
  finally{$('#create-submit-btn').disabled=false;$('#create-submit-btn').classList.remove('hidden');$('#create-loading').classList.add('hidden');}
});

const isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
$('#login-btn')?.addEventListener('click',openLoginModal);
async function openLoginModal(){
  try{
    if(!isMobile){
      $('#login-modal').classList.remove('hidden');$('#login-loading').classList.remove('hidden');
      $('#login-qr').classList.add('hidden');$('#mobile-login-btn').classList.add('hidden');$('#login-connected').classList.add('hidden');
    }else{
      // Show inline status on landing card
      const st=$('#landing-primal-status');if(st){st.classList.remove('hidden');st.style.display='flex';$('#landing-primal-status-text').textContent='Connecting to Primal...';}
      $('#landing-primal-btn').disabled=true;$('#landing-primal-btn').style.opacity='0.5';
    }
    const nip46Origin=IS_CAPACITOR?'https://swellnotes.com':location.origin;
    const nip46Params=`origin=${encodeURIComponent(nip46Origin)}${IS_CAPACITOR?'&platform=ios':''}`;
    const r=await fetch(`${API_BASE}/api/nip46/init?${nip46Params}`);
    if(!r.ok)throw new Error('Server error: '+r.status);
    nip46Data=await r.json();
    if(!nip46Data.mobileURI||!nip46Data.secretKey)throw new Error('Invalid NIP-46 response');
    if(isMobile||IS_CAPACITOR){
      localStorage.setItem('nip46_pending',JSON.stringify({localSecretKey:nip46Data.secretKey,localPublicKey:nip46Data.publicKey,secret:nip46Data.secret,timestamp:Date.now()}));
      // Start relay listener BEFORE redirecting — so it's ready when user returns
      waitForNIP46();
      // Small delay to let listener start, then redirect to Primal
      setTimeout(async()=>{
        const st=$('#landing-primal-status');if(st){$('#landing-primal-status-text').textContent='Waiting for Primal...';}
        if(IS_CAPACITOR){try{const Browser=window.Capacitor.Plugins.Browser;await Browser.open({url:nip46Data.mobileURI});}catch{window.location.href=nip46Data.mobileURI;}}
        else{window.location.href=nip46Data.mobileURI;}
      },300);
    }else{
      $('#qr-image').src=nip46Data.qrDataUrl;$('#login-qr').classList.remove('hidden');$('#login-loading').classList.add('hidden');
      waitForNIP46();
    }
  }catch(err){
    console.error('Login init error:',err);
    toast('Login failed — please try again','error');
    if(!isMobile)$('#login-modal').classList.add('hidden');
    else{$('#landing-primal-btn').disabled=false;$('#landing-primal-btn').style.opacity='';const st=$('#landing-primal-status');if(st){st.classList.add('hidden');st.style.display='';}}
  }
}
$('#mobile-login-btn')?.addEventListener('click',async()=>{if(!nip46Data)return;localStorage.setItem('nip46_pending',JSON.stringify({localSecretKey:nip46Data.secretKey,localPublicKey:nip46Data.publicKey,secret:nip46Data.secret,timestamp:Date.now()}));if(IS_CAPACITOR){try{const Browser=window.Capacitor.Plugins.Browser;await Browser.open({url:nip46Data.mobileURI});}catch{location.href=nip46Data.mobileURI;}}else{location.href=nip46Data.mobileURI;}});
async function waitForNIP46(){
  if(!nip46Data)return;
  try{
    console.log('[NIP46] Starting waitForNIP46, importing modules...');
    /* Relay from bundle */
    const dec=nip44Decrypt;
    /* hexToBytes from bundle */
    /* BunkerSigner from bundle */
    console.log('[NIP46] Modules loaded, connecting to relay...');
    const skb=hexToBytes(nip46Data.secretKey);
    const relay=await Relay.connect('wss://relay.primal.net');
    console.log('[NIP46] Connected to relay, subscribing for pubkey:', nip46Data.publicKey.slice(0,12)+'...');
    relay.subscribe([{kinds:[24133],'#p':[nip46Data.publicKey],limit:0}],{
      onevent:async ev=>{
        console.log('[NIP46] Event received from:', ev.pubkey.slice(0,12)+'...');
        if(!ev.tags.some(t=>t[0]==='p'&&t[1]===nip46Data.publicKey)){console.log('[NIP46] Event not for us, skipping');return;}
        try{
          const convKey=getConversationKey(skb,ev.pubkey);
          const decrypted=dec(ev.content,convKey);
          console.log('[NIP46] Decrypted:', decrypted.slice(0,100));
          const r=JSON.parse(decrypted);
          console.log('[NIP46] Response result:', r.result);
          if(r.result===nip46Data.secret||r.result==='ack'||r.result===true){
            const bunkerPubkey=ev.pubkey;
            console.log('[NIP46] ACK received! Bunker:', bunkerPubkey.slice(0,12)+'... Fetching real pubkey via RPC...');
            try{
              const nip44Enc=nip44Encrypt;
              /* finalizeEvent from bundle */
              const rpcId=crypto.randomUUID();
              const rpcPayload=JSON.stringify({id:rpcId,method:'get_public_key',params:[]});
              const encPayload=nip44Enc(rpcPayload,getConversationKey(skb,bunkerPubkey));
              const rpcEvent=finalizeEvent({kind:24133,created_at:Math.floor(Date.now()/1000),tags:[['p',bunkerPubkey]],content:encPayload},skb);
              await relay.publish(rpcEvent);
              console.log('[NIP46] get_public_key RPC sent, waiting for response...');
              // Response will come as another event — set a timeout fallback
              const timeout=setTimeout(()=>{if(nip46Data._waitingForPubkey){console.log('[NIP46] get_public_key timeout, using bunker pubkey');nip46Data._waitingForPubkey=false;relay.close();completeLogin(bunkerPubkey);}},8000);
              // Override the event handler won't work since we're inside it,
              // but the subscription is still active so the next event will hit this handler
              // Store state so next event can be handled
              nip46Data._waitingForPubkey=true;nip46Data._rpcId=rpcId;nip46Data._bunkerPubkey=bunkerPubkey;nip46Data._timeout=timeout;
            }catch(e){console.log('[NIP46] RPC send failed:', e);relay.close();await completeLogin(bunkerPubkey);}
          }else if(nip46Data._waitingForPubkey&&r.result&&r.result.length===64){
            // This is the get_public_key response
            clearTimeout(nip46Data._timeout);
            nip46Data._waitingForPubkey=false;
            console.log('[NIP46] Real user pubkey:', r.result.slice(0,12)+'...');
            relay.close();
            await completeLogin(r.result);
          }else{console.log('[NIP46] Ignoring event, result:', r.result?.slice?.(0,20));}
        }catch(e){console.log('[NIP46] Decrypt/parse error:', e);}
      },
      oneose:()=>{console.log('[NIP46] EOSE received, waiting for real-time events...');}
    });
    setTimeout(()=>{try{relay.close();}catch{}},300000);
  }catch(err){
    console.error('[NIP46] Fatal error:', err);
    toast('Login connection failed','error');
    // Reset mobile UI on failure
    $('#landing-primal-btn').disabled=false;$('#landing-primal-btn').style.opacity='';
    const st=$('#landing-primal-status');if(st){st.classList.add('hidden');st.style.display='';}
  }
}

// On mobile, check for callback result when user returns to the page
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!currentUser)checkCallback();});

async function completeLogin(pk){
  const profile=await fetchProfile(pk);const name=profile?.name||profile?.display_name||pk.slice(0,8)+'...';const picture=profile?.picture||null;
  await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:pk,display_name:name,avatar_url:picture})});
  currentUser={pubkey:pk,display_name:name,avatar_path:picture};localStorage.setItem('swellnotes_user',JSON.stringify(currentUser));
  // Reset mobile login UI
  $('#landing-primal-btn').disabled=false;$('#landing-primal-btn').style.opacity='';
  const st=$('#landing-primal-status');if(st){st.classList.add('hidden');st.style.display='';}
  updateAuthUI();$('#login-loading')?.classList.add('hidden');$('#login-qr')?.classList.add('hidden');$('#mobile-login-btn')?.classList.add('hidden');$('#login-connected')?.classList.remove('hidden');
  // Auto-load and select first spot after login
  await loadMySpots();
  if(mySpots.length>0&&!currentSpot){const spot=await(await fetch(`${API_BASE}/api/spots/${mySpots[0].id}`,{headers:currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{}})).json();if(spot&&!spot.error)selectSpot(spot);}
  setTimeout(()=>{$('#login-modal').classList.add('hidden');toast(`Welcome, ${name}!`);},1000);
}

async function checkCallback(){const c=localStorage.getItem('nip46_connected');if(!c)return;try{const d=JSON.parse(c);if(Date.now()-d.timestamp>300000){localStorage.removeItem('nip46_connected');return;}localStorage.removeItem('nip46_connected');await completeLogin(d.bunkerPubkey);}catch{localStorage.removeItem('nip46_connected');}}

$('#login-modal .modal-backdrop').addEventListener('click',()=>$('#login-modal').classList.add('hidden'));
$('#login-modal .modal-close').addEventListener('click',()=>$('#login-modal').classList.add('hidden'));
// ===== SETTINGS =====
$('#settings-btn').addEventListener('click',async()=>{
  if(!currentUser)return;
  $('#settings-name').textContent=currentUser.display_name;
  if(currentUser.avatar_path){$('#settings-avatar').src=currentUser.avatar_path;$('#settings-avatar').style.display='';}
  else $('#settings-avatar').style.display='none';
  // Show key section for local accounts, NIP-46 section for Primal logins
  if(currentUser.secretKey){
    $('#settings-key-section').classList.remove('hidden');
    $('#settings-nip46-section').classList.add('hidden');
    // Convert hex secret key to nsec
    try{
      /* nip19 from bundle */
      /* hexToBytes from bundle */
      const nsec=nip19.nsecEncode(hexToBytes(currentUser.secretKey));
      $('#nsec-display').textContent=nsec;
    }catch{$('#nsec-display').textContent=currentUser.secretKey;}
    // Reset reveal state
    $('#key-hidden').classList.remove('hidden');$('#key-shown').classList.add('hidden');
  }else{
    $('#settings-key-section').classList.add('hidden');
    $('#settings-nip46-section').classList.remove('hidden');
  }
  $('#settings-modal').classList.remove('hidden');
});

$('#reveal-key-btn').addEventListener('click',()=>{
  const nsec=$('#nsec-display').textContent;
  navigator.clipboard?.writeText(nsec);toast('Private key copied!');
});

$('#copy-key-btn').addEventListener('click',()=>{
  const nsec=$('#nsec-display').textContent;
  navigator.clipboard?.writeText(nsec);toast('Private key copied!');
});

$('#settings-avatar-upload').addEventListener('click',()=>$('#settings-avatar-file').click());
$('#settings-avatar-file').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file||!currentUser)return;
  try{
    let avatarUrl=await uploadToBlossom(file);
    if(!avatarUrl){const r=new FileReader();const b64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(file);});
      const res=await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:currentUser.pubkey,display_name:currentUser.display_name,avatar_base64:b64})});
      const data=await res.json();avatarUrl=data.avatar_path;
    } else {
      await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:currentUser.pubkey,display_name:currentUser.display_name,avatar_url:avatarUrl})});
    }
    currentUser.avatar_path=avatarUrl;localStorage.setItem('swellnotes_user',JSON.stringify(currentUser));
    $('#settings-avatar').src=avatarUrl;$('#settings-avatar').style.display='';
    if($('#user-avatar'))$('#user-avatar').src=avatarUrl;
    toast('Photo updated!');
  }catch{toast('Failed to update photo','error');}
});
$('#settings-modal .modal-backdrop').addEventListener('click',()=>$('#settings-modal').classList.add('hidden'));
$('#settings-modal .modal-close').addEventListener('click',()=>$('#settings-modal').classList.add('hidden'));

$('#logout-btn').addEventListener('click',()=>{currentUser=null;currentSpot=null;mySpots=[];followingSet.clear();localStorage.removeItem('swellnotes_user');localStorage.removeItem('swellnotes_spot');updateAuthUI();location.reload();});

function updateAuthUI(){
  if(currentUser){
    $('#landing-page').classList.add('hidden');
    document.body.style.overflow='';
    $('#app-header').classList.remove('hidden');
    $('#auth-buttons').classList.add('hidden');$('#user-info').classList.remove('hidden');$('#spot-picker-auth')?.classList.add('hidden');$('#user-name').textContent=currentUser.display_name;const av=$('#user-avatar');if(currentUser.avatar_path){av.src=currentUser.avatar_path;av.style.display='';}else av.style.display='none';$('#submit-btn').disabled=false;$('#submit-btn').textContent='Log Session';$('#comment-form')?.classList.remove('hidden');
    if(!currentSpot){$('#spot-picker')?.classList.remove('hidden');$('#main-content')?.classList.add('hidden');$('#hero').classList.add('hidden');$('#app-header').classList.add('hidden');document.body.style.overflow='hidden';}
    else{$('#hero').classList.remove('hidden');$('#app-header').classList.remove('hidden');}
    loadFollowing();loadMySpots().then(showMySpots);
  } else {
    $('#landing-page').classList.remove('hidden');
    document.body.style.overflow='hidden';
    $('#app-header').classList.add('hidden');
    $('#hero').classList.add('hidden');
    $('#main-content').classList.add('hidden');
    $('#spot-picker')?.classList.add('hidden');
    $('#auth-buttons').classList.remove('hidden');$('#user-info').classList.add('hidden');$('#submit-btn').disabled=true;$('#submit-btn').textContent='Log in to Log Session';$('#comment-form')?.classList.add('hidden');
  }
}

// ===== FOLLOWS =====
async function loadFollowing(){if(!currentUser)return;try{const{following}=await(await fetch(API_BASE+'/api/follows',{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();followingSet=new Set(following.map(f=>f.pubkey));}catch{};syncFollowsFromRelay();}
async function toggleFollow(pk){if(!currentUser)return toast('Log in first','error');const is=followingSet.has(pk);if(is)followingSet.delete(pk);else followingSet.add(pk);loadSurfers();await fetch(`${API_BASE}/api/follows/${pk}`,{method:is?'DELETE':'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});await publishKind3([...followingSet]);}
window.toggleFollow=toggleFollow;

// Crew search for surfer "By Crew" tab
let surferCrewTimeout;
$('#surfer-crew-select')?.addEventListener('input',e=>{
  clearTimeout(surferCrewTimeout);const q=e.target.value.trim();
  const results=$('#surfer-crew-results');
  if(q.length<2){results.innerHTML='';return;}
  surferCrewTimeout=setTimeout(async()=>{
    const headers=currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{};
    const spots=await(await fetch(`${API_BASE}/api/spots/browse?q=${encodeURIComponent(q)}`,{headers})).json();
    if(!spots.length){results.innerHTML='<p class="muted" style="padding:0.5rem;text-align:center">No crews found</p>';return;}
    results.innerHTML=spots.map(s=>{
      const name=s.is_member||!s.is_private?escapeHtml(s.name||s.region||'Unknown'):escapeHtml(s.region||'Unknown Region');
      return`<div class="spot-result" data-crew-id="${s.id}">
        <div class="spot-result-icon">${`<img src="${s.cover_image_url||defaultCover(s.id)}" style="width:36px;height:36px;border-radius:8px;object-fit:cover">`}</div>
        <div><div class="spot-result-name">${name}</div><div class="spot-result-loc">${s.member_count} member${s.member_count!==1?'s':''}</div></div>
      </div>`;
    }).join('');
    results.querySelectorAll('.spot-result').forEach(el=>el.addEventListener('click',()=>{
      $('#surfer-crew-select').dataset.crewId=el.dataset.crewId;
      $('#surfer-crew-select').value=el.querySelector('.spot-result-name').textContent;
      results.innerHTML='';
      loadSurfers();
    }));
  },300);
});

let currentSurferTab='active';
// Surfer sub-tabs
$$('.sub-tab[data-surfer-tab]').forEach(btn=>{btn.addEventListener('click',()=>{
  $$('.sub-tab[data-surfer-tab]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  currentSurferTab=btn.dataset.surferTab;loadSurfers();
});});

async function loadSurfers(){
  loadJoinRequests();
  const crewSearch=$('#surfer-crew-search');const desc=$('#surfers-desc');
  let params='';
  if(currentSurferTab==='active'){
    params='?sort=recent';crewSearch.classList.add('hidden');
    desc.textContent='Latest active surfers. Follow to see their reports & analysis.';
  }else if(currentSurferTab==='crew'){
    crewSearch.classList.remove('hidden');
    desc.textContent='Find surfers by searching for a crew.';
    if(!$('#surfer-crew-select').dataset.crewId){$('#surfers-list').innerHTML='<div class="empty-state"><p>Search for a crew above to see its members.</p></div>';return;}
    params=`?crew_id=${$('#surfer-crew-select').dataset.crewId}`;
  }else{
    params=currentSpot?`?spot_id=${currentSpot.id}`:'';crewSearch.classList.add('hidden');
    desc.textContent='Members of this crew. Follow to see their reports & analysis.';
  }
  try{const users=await(await fetch(API_BASE+'/api/users'+params)).json();const list=$('#surfers-list');if(!users.length){list.innerHTML='<div class="empty-state"><p>No surfers found.</p></div>';return;}
  list.innerHTML=users.map(u=>{const me=currentUser?.pubkey===u.pubkey;const fol=followingSet.has(u.pubkey);let btn;if(me)btn='<button class="btn-follow is-you" disabled>You</button>';else if(!currentUser)btn='';else if(fol)btn=`<button class="btn-follow following" onclick="toggleFollow('${u.pubkey}')">Following</button>`;else btn=`<button class="btn-follow" onclick="toggleFollow('${u.pubkey}')">Follow</button>`;
  const isAdmin=currentSpot?.members?.some(m=>m.pubkey===currentUser?.pubkey&&m.role==='admin');
  const adminBtn=(!me&&isAdmin&&u.role!=='admin'&&currentSpot)?`<button class="btn-outline btn-xs" style="margin-left:0.3rem" onclick="event.stopPropagation();makeAdmin('${currentSpot.id}','${u.pubkey}')">Make Admin</button>`:'';
  return`<div class="surfer-card"><a href="${primalLink(u.pubkey)}" target="_blank" rel="noopener" class="surfer-profile-link" onclick="event.stopPropagation()">${u.avatar_path?`<img src="${u.avatar_path}" class="surfer-av">`:`<div class="surfer-av-placeholder">${(u.display_name||'?')[0].toUpperCase()}</div>`}</a><div class="surfer-info"><a href="${primalLink(u.pubkey)}" target="_blank" rel="noopener" class="surfer-name-link">${escapeHtml(u.display_name||'Anon')}</a></div><div class="surfer-meta">${u.session_count} session${u.session_count!==1?'s':''}${u.total_barrels>0?` · 🤿 ${u.total_barrels} tube${u.total_barrels>1?'s':''}`:''}${u.role==='admin'?' · admin':''}</div></div><div style="display:flex;align-items:center">${btn}${adminBtn}</div></div>`;}).join('');}catch{}}

// ===== CONDITIONS =====
$('#session_date').value=new Date().toISOString().split('T')[0];
async function fetchConditions(){const d=$('#session_date').value,t=$('#time_of_day').value,p=$('#conditions-preview');p.innerHTML='<div class="cond-loading">Fetching conditions...</div>';
  const spotParam=currentSpot?`&spot_id=${currentSpot.id}`:'';
  const condHeaders=currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{};
  try{const c=await(await fetch(`${API_BASE}/api/conditions?date=${d}&time_of_day=${t}${spotParam}`,{headers:condHeaders})).json();if(!c.surf_height_min_ft&&!c.swells?.length){p.innerHTML='<div class="cond-loading">No forecast data.</div>';return;}
  const sw=(c.swells||[]).map(s=>`<div class="swell-item"><span class="swell-compass">${s.direction_compass}</span><span class="swell-detail">${s.height_ft}ft ${s.period_s}s</span><span class="swell-meta">${s.direction_deg}°</span></div>`).join('');
  p.innerHTML=`<div class="cond-grid"><div class="cond-block"><h4>Surf</h4><div class="cond-val">${c.surf_height_min_ft||'?'}-${c.surf_height_max_ft||'?'} ft</div></div><div class="cond-block"><h4>Swells (${c.swells?.length||0})</h4><div class="swells-list">${sw||'—'}</div></div><div class="cond-block"><h4>Wind</h4><div class="cond-val">${c.wind_speed_mph||0} mph</div><div class="cond-sub">${c.wind_type||''} ${c.wind_gust_mph?'gusts '+c.wind_gust_mph:''}</div></div><div class="cond-block"><h4>Tide</h4><div class="cond-val">${c.tide_height_ft||'?'} ft</div></div></div>`;}catch{p.innerHTML='<div class="cond-loading">Could not fetch.</div>';}}
$('#session_date').addEventListener('change',fetchConditions);$('#time_of_day').addEventListener('change',fetchConditions);

// ===== TABS =====
$$('.shape-tab').forEach(btn=>{btn.addEventListener('click',()=>{const g=btn.dataset.group;if(g==='session_type'){$$('.shape-tab[data-group="session_type"]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');$('#session_type').value=btn.dataset.val;}else{btn.classList.toggle('active');$('#wave_shape').value=[...$$('.shape-tab[data-shape].active')].map(b=>b.dataset.shape).join(',');}});});
document.querySelector('.shape-tab[data-val="surfed"]')?.classList.add('active');

// ===== RATING =====
const rs=$('#rating'),rd=$('#rating-display');
// Audio tick for rating
let audioCtx=null;
function playTick(rating){
  try{
    if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=audioCtx.createOscillator();const gain=audioCtx.createGain();
    osc.connect(gain);gain.connect(audioCtx.destination);
    // Higher pitch + longer for higher ratings
    osc.frequency.value=200+rating*80;
    osc.type=rating>=8?'sine':'triangle';
    gain.gain.setValueAtTime(0.08+rating*0.02,audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+(rating>=8?0.15:0.06));
    osc.start();osc.stop(audioCtx.currentTime+(rating>=8?0.15:0.06));
    // Extra sparkle for 8+
    if(rating>=8){const o2=audioCtx.createOscillator();const g2=audioCtx.createGain();o2.connect(g2);g2.connect(audioCtx.destination);o2.frequency.value=600+rating*60;o2.type='sine';g2.gain.setValueAtTime(0.05,audioCtx.currentTime+0.03);g2.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.2);o2.start(audioCtx.currentTime+0.03);o2.stop(audioCtx.currentTime+0.2);}
  }catch{}
}

let lastRatingVal=5;
function updateRating(){
  const v=+rs.value;
  const bc=v<=3?'#f87171':v<=5?'#facc15':v<=7?'#22d3ee':'#818cf8';
  rd.style.background='#fff';rd.style.color='#000';rd.style.borderColor=bc;
  // Scale badge size based on rating
  const scale=0.9+v*0.04;rd.style.transform=`scale(${scale})`;
  if(v>=8)rd.style.boxShadow='0 0 20px rgba(129,140,248,0.4)';
  else if(v>=6)rd.style.boxShadow='0 0 12px rgba(56,189,248,0.25)';
  else rd.style.boxShadow='none';
  // Pulse + haptic on change
  if(v!==lastRatingVal){
    rd.classList.remove('pulse');void rd.offsetWidth;rd.classList.add('pulse');
    if(v>lastRatingVal){if(navigator.vibrate)navigator.vibrate(v>=8?[30,20,30]:v>=5?[15]:[8]);playTick(v);}
    lastRatingVal=v;
  }
  rd.textContent=v;
}
rs.addEventListener('input',updateRating);updateRating();

// ===== BARRELS =====
$('#barrel-plus').addEventListener('click',()=>{const i=$('#barrels');i.value=Math.min(99,+i.value+1);});
$('#barrel-minus').addEventListener('click',()=>{const i=$('#barrels');i.value=Math.max(0,+i.value-1);});

// ===== VOICE =====
const rb=$('#record-btn'),rl=$('#record-label');
function setupSR(){const S=window.SpeechRecognition||window.webkitSpeechRecognition;if(!S)return null;const r=new S();r.continuous=true;r.interimResults=true;r.lang='en-US';let ft='';r.onresult=e=>{let i='';for(let x=e.resultIndex;x<e.results.length;x++){if(e.results[x].isFinal)ft+=e.results[x][0].transcript+' ';else i+=e.results[x][0].transcript;}voiceTranscript=ft.trim();$('#transcript-text').textContent=ft+i;$('#transcript-section').classList.remove('hidden');};r.onerror=()=>{};r.onend=()=>$('#transcript-text')?.classList.remove('listening');return{recognition:r,reset:()=>{ft='';}};}
rb.addEventListener('mousedown',startRec);rb.addEventListener('mouseup',stopRec);rb.addEventListener('mouseleave',stopRec);
rb.addEventListener('touchstart',e=>{e.preventDefault();startRec();});rb.addEventListener('touchend',e=>{e.preventDefault();stopRec();});
async function startRec(){if(mediaRecorder?.state==='recording')return;try{if(IS_CAPACITOR){try{const Microphone=window.Capacitor.Plugins.Microphone;if(Microphone){const perm=await Microphone.requestPermissions();if(perm.microphone!=='granted'){toast('Mic permission denied','error');return;}}}catch{}}const s=await navigator.mediaDevices.getUserMedia({audio:true});recordingChunks=[];const recMime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/mp4';mediaRecorder=new MediaRecorder(s,{mimeType:recMime});mediaRecorder.ondataavailable=e=>{if(e.data.size>0)recordingChunks.push(e.data);};mediaRecorder.onstop=()=>{s.getTracks().forEach(t=>t.stop());voiceBlob=new Blob(recordingChunks,{type:recMime});voiceBlob._ext=recMime.includes('mp4')?'m4a':'webm';$('#voice-audio').src=URL.createObjectURL(voiceBlob);$('#voice-playback').classList.remove('hidden');};mediaRecorder.start(100);const sr=setupSR();if(sr){speechRecognition=sr.recognition;sr.reset();voiceTranscript='';$('#transcript-text').textContent='';$('#transcript-text').classList.add('listening');$('#transcript-section').classList.remove('hidden');speechRecognition.start();}rb.classList.add('recording');rl.textContent='Release to stop';$('#recording-status').classList.remove('hidden');recordingSeconds=0;updTimer();recordingTimer=setInterval(()=>{recordingSeconds++;updTimer();},1000);}catch{toast('Mic denied','error');}}
function stopRec(){if(!mediaRecorder||mediaRecorder.state!=='recording')return;mediaRecorder.stop();if(speechRecognition){speechRecognition.stop();speechRecognition=null;}clearInterval(recordingTimer);rb.classList.remove('recording');rl.textContent='Voice Note';$('#recording-status').classList.add('hidden');}
function updTimer(){$('#record-timer').textContent=`${Math.floor(recordingSeconds/60)}:${(recordingSeconds%60).toString().padStart(2,'0')}`;}
$('#delete-voice').addEventListener('click',()=>{voiceBlob=null;voiceTranscript='';$('#voice-audio').src='';$('#voice-playback').classList.add('hidden');$('#transcript-section').classList.add('hidden');});
$('#video-file').addEventListener('change',e=>{videoFile=e.target.files[0];if(!videoFile)return;$('#video-player').src=URL.createObjectURL(videoFile);$('#video-preview').classList.remove('hidden');});
$('#delete-video').addEventListener('click',()=>{videoFile=null;$('#video-player').src='';$('#video-preview').classList.add('hidden');$('#video-file').value='';});

// ===== FORM =====
$('#session-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!currentUser)return toast('Log in first','error');
  const data={session_date:$('#session_date').value,time_of_day:$('#time_of_day').value,rating:+$('#rating').value,barrels:+($('#barrels').value)||0,wave_shape:$('#wave_shape').value||null,session_type:$('#session_type').value||'surfed',notes:$('#notes').value||null,voice_transcript:voiceTranscript||null,spot_id:currentSpot?.id||null};
  try{$('#submit-btn').disabled=true;$('#submit-btn').textContent='Uploading...';
  if(voiceBlob){const vExt=voiceBlob._ext||'webm';const vType=vExt==='m4a'?'audio/mp4':'audio/webm';const vf=new File([voiceBlob],`voice.${vExt}`,{type:vType});const u=await uploadToBlossom(vf);if(u)data.voice_url=u;else{const r=new FileReader();data.voice_memo_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(voiceBlob);});}}
  if(videoFile){const u=await uploadToBlossom(videoFile);if(u)data.video_url=u;else{const r=new FileReader();data.video_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(videoFile);});}}
  $('#submit-btn').textContent='Logging...';
  const res=await fetch(API_BASE+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify(data)});
  if(res.ok){const result=await res.json();toast('Session logged!');
    const shareData={rating:data.rating,session_type:data.session_type,wave_shape:data.wave_shape,notes:data.notes,video_url:data.video_url||null,conditions:result.conditions||{},spot_name:currentSpot?.name||'Unknown',sessionUrl:`https://swellnotes.com/session/${result.id}`};
    $('#notes').value='';$('#barrels').value=0;rs.value=5;updateRating();$$('.shape-tab[data-shape]').forEach(b=>b.classList.remove('active'));$('#wave_shape').value='';$$('.shape-tab[data-group="session_type"]').forEach(b=>b.classList.remove('active'));document.querySelector('.shape-tab[data-val="surfed"]')?.classList.add('active');$('#session_type').value='surfed';voiceBlob=null;voiceTranscript='';$('#voice-audio').src='';$('#voice-playback').classList.add('hidden');$('#transcript-section').classList.add('hidden');videoFile=null;$('#video-player').src='';$('#video-preview').classList.add('hidden');$('#video-file').value='';
    showShareModal(shareData);
  }else{const err=await res.json();toast(err.error||'Failed','error');}}catch(err){console.error(err);toast('Error','error');}
  finally{$('#submit-btn').disabled=!currentUser;$('#submit-btn').textContent=currentUser?'Log Session':'Log in to Log Session';}
});

// ===== SHARE =====
let pendingShareData=null;
function showShareModal(sd){pendingShareData=sd;const c=sd.conditions;const sw=(c.swells||[]).map(s=>`${s.height_ft}ft ${s.period_s}s ${s.direction_compass}`).join(', ');const sh=c.surf_height_min_ft&&c.surf_height_max_ft?`${c.surf_height_min_ft}-${c.surf_height_max_ft}ft`:'';const emoji=sd.rating>=8?'🔥':sd.rating>=6?'🤙':sd.rating>=4?'👌':'😐';
let html=`<strong>${sd.spot_name} ${sd.session_type==='observed'?'check':'session'}</strong>`;if(sh)html+=` · ${sh}`;html+=` · ${sd.rating}/10 ${emoji}`;if(sw)html+=`<div class="share-stats">Swell: ${sw}</div>`;if(sd.video_url)html+=`<video src="${sd.video_url}" controls muted preload="metadata"></video>`;
$('#share-preview').innerHTML=html;$('#share-text').value=sd.notes||`${sd.spot_name} was ${sd.rating>=8?'firing':sd.rating>=6?'fun':sd.rating>=4?'decent':'flat'} today! ${sh} ${emoji}`;$('#share-modal').classList.remove('hidden');}
function closeShareAndGoToFeed(){$('#share-modal').classList.add('hidden');$$('.nav-btn').forEach(x=>x.classList.remove('active'));$$('.nav-btn[data-view="history"]').forEach(x=>x.classList.add('active'));$$('.view').forEach(v=>v.classList.remove('active'));$('#view-history').classList.add('active');loadFeed();}
function getShareText(){return $('#share-text').value.trim();}
function getShareUrl(){return pendingShareData?.sessionUrl||'https://swellnotes.com';}
$('#share-skip-btn').addEventListener('click',closeShareAndGoToFeed);
$('#share-modal .modal-backdrop').addEventListener('click',closeShareAndGoToFeed);
$('#share-modal .modal-close').addEventListener('click',closeShareAndGoToFeed);
$('#share-whatsapp-btn').addEventListener('click',()=>{const t=getShareText()+'\n'+getShareUrl();window.open('https://wa.me/?text='+encodeURIComponent(t),'_blank');closeShareAndGoToFeed();});
$('#share-messages-btn').addEventListener('click',()=>{const t=getShareText()+'\n'+getShareUrl();window.open('sms:&body='+encodeURIComponent(t));closeShareAndGoToFeed();});
$('#share-native-btn').addEventListener('click',async()=>{const t=getShareText();try{await navigator.share({title:pendingShareData?.spot_name+' session',text:t,url:getShareUrl()});}catch{}closeShareAndGoToFeed();});
$('#share-post-btn').addEventListener('click',async()=>{if(!currentUser?.secretKey||!pendingShareData)return;try{$('#share-post-btn').disabled=true;$('#share-post-btn').textContent='Posting...';const sd=pendingShareData;const c=sd.conditions;const sw=(c.swells||[]).map(s=>`${s.height_ft}ft ${s.period_s}s ${s.direction_compass} ${s.direction_deg}°`).join(', ');const sh=c.surf_height_min_ft&&c.surf_height_max_ft?`${c.surf_height_min_ft}-${c.surf_height_max_ft}ft`:'';let content=$('#share-text').value.trim();if(!content.includes(sd.spot_name))content=`🌊 ${sd.spot_name} · ${sh} · ${sd.rating}/10\n\n${content}`;if(sw&&!content.includes(sw))content+=`\n\nSwell: ${sw}`;if(c.wind_type)content+=`\nWind: ${c.wind_speed_mph}mph ${c.wind_type}`;if(sd.video_url)content+=`\n\n${sd.video_url}`;const tags=[['t','surf'],['t',sd.spot_name.toLowerCase().replace(/\s+/g,'')],['t','surfing']];if(sd.video_url)tags.push(['imeta',`url ${sd.video_url}`,`m video/mp4`]);const ev=finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags,content},hexToBytes(currentUser.secretKey));for(const u of RELAYS){try{const r=await Relay.connect(u);await r.publish(ev);r.close();}catch{}}toast('Shared!');closeShareAndGoToFeed();}catch{toast('Share failed','error');}finally{$('#share-post-btn').disabled=false;$('#share-post-btn').textContent='Share';}});

// ===== MULTI-SPOT FEED =====
let spotFollowingSet=new Set();

async function loadFeed(){
  if(!currentUser){$('#crew-list').innerHTML='<div class="empty-state"><p>Log in to see your crews.</p></div>';return;}
  $('#crew-feed').classList.add('hidden');$('#crew-list').classList.remove('hidden');
  try{
    await loadMySpots();
    const list=$('#crew-list');
    if(!mySpots.length){list.innerHTML='<div class="empty-state"><p>No crews yet.</p><p class="muted">Browse and join a crew to get started.</p></div>';return;}
    list.innerHTML=mySpots.map(s=>`<div class="crew-card" data-id="${s.id}">
      ${s.cover_image_url?`<img src="${s.cover_image_url}" class="crew-card-cover" alt="">`:`<img src="${defaultCover(s.id)}" class="crew-card-cover" alt="">`}
      <div class="crew-card-info"><h3>${escapeHtml(s.name)}</h3><span class="muted">${s.location_text||''}</span></div>
      <span class="crew-card-count">${s.member_count||'?'} members</span>
    </div>`).join('');
    list.querySelectorAll('.crew-card').forEach(c=>c.addEventListener('click',()=>openCrewFeed(c.dataset.id)));
  }catch{$('#crew-list').innerHTML='<div class="empty-state">Error loading crews</div>';}
}

async function openCrewFeed(spotId){
  const spot=mySpots.find(s=>s.id===spotId);
  if(!spot)return;
  $('#crew-list').classList.add('hidden');$('#crew-feed').classList.remove('hidden');
  $('#crew-feed-title').textContent=spot.name;
  const list=$('#session-list');list.innerHTML='<div class="cond-loading">Loading...</div>';
  try{
    const groups=await(await fetch(`${API_BASE}/api/feed?limit=50`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();
    const group=groups.find(g=>g.spot.id===spotId);
    if(!group||!group.sessions.length){list.innerHTML='<div class="empty-state"><p>No sessions logged yet.</p></div>';return;}
    list.innerHTML=group.sessions.map(s=>renderSessionCard(s)).join('');
    list.querySelectorAll('.feed-card').forEach(c=>c.addEventListener('click',()=>openSession(c.dataset.id)));
  }catch{list.innerHTML='<div class="empty-state">Error loading sessions</div>';}
}
$('#back-to-crews').addEventListener('click',()=>{$('#crew-feed').classList.add('hidden');$('#crew-list').classList.remove('hidden');});

function renderSessionCard(s){
  const d=new Date(s.session_date+'T12:00:00'),tags=[];
  // Only show session type, wave shape, and media tags — no swell/wind data
  if(s.surf_height_min_ft!=null)tags.push(`<span class="tag tag-height">${s.surf_height_min_ft}-${s.surf_height_max_ft}ft</span>`);
  if(s.session_type==='surfed')tags.push('<span class="tag tag-shape">surfed</span>');
  else if(s.session_type==='observed')tags.push('<span class="tag tag-observed">observed</span>');
  if(s.wave_shape)tags.push(`<span class="tag tag-shape">${s.wave_shape}</span>`);
  if(s.barrels>0)tags.push(`<span class="tag tag-barrel">🤿 ${s.barrels} tube${s.barrels>1?'s':''}</span>`);
  if(s.video_path)tags.push('<span class="tag tag-video">📹</span>');
  if(s.voice_memo_path)tags.push('<span class="tag tag-voice">🎙</span>');
  const vt=s.video_path?`<div class="feed-video-thumb"><video src="${s.video_path}" preload="metadata" muted></video></div>`:'';
  const bb=s.total_barrels>0?`<span class="barrel-count" title="${s.total_barrels} tubes">🤿${s.total_barrels}</span>`:'';
  return`<div class="feed-card" data-id="${s.id}"><div class="feed-date"><div class="day">${d.getDate()}</div><div class="mo">${d.toLocaleString('en',{month:'short'})}</div></div><div class="feed-body"><div class="feed-user">${userLinkHTML(s.pubkey,s.display_name,s.avatar_path)}${bb}<span class="feed-tod">· ${formatTOD(s.time_of_day)}</span></div><div class="feed-tags">${tags.join('')}</div>${vt}</div><div class="feed-rating">${s.rating?`<div class="rbadge ${getRatingClass(s.rating)}">${s.rating}</div>`:'<div class="rbadge">—</div>'}</div></div>`;
}

window.switchToSpot=async id=>{
  try{const spot=await(await fetch(`${API_BASE}/api/spots/${id}`)).json();selectSpot(spot);}catch{}
};

// ===== BROWSE & FOLLOW SPOTS =====
$('#browse-spots-btn').addEventListener('click',()=>{$('#browse-spots-panel').classList.remove('hidden');loadBrowseSpots();});
$('#close-browse').addEventListener('click',()=>$('#browse-spots-panel').classList.add('hidden'));

let browseTimeout;
$('#browse-search').addEventListener('input',e=>{
  clearTimeout(browseTimeout);browseTimeout=setTimeout(()=>loadBrowseSpots(e.target.value.trim()),300);
});

async function loadBrowseSpots(q=''){
  const params=new URLSearchParams();if(q)params.set('q',q);
  const headers=currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{};
  try{
    const spots=await(await fetch(`${API_BASE}/api/spots/browse?${params}`,{headers})).json();
    spotFollowingSet=new Set(spots.filter(s=>s.is_following).map(s=>s.id));
    const list=$('#browse-spot-list');
    if(!spots.length){list.innerHTML='<p class="muted" style="padding:1rem;text-align:center">No crews found</p>';return;}
    list.innerHTML=spots.map(s=>{
      const isMember=s.is_member;const isFollowing=spotFollowingSet.has(s.id);
      const displayName=isMember||!s.is_private?escapeHtml(s.name||s.region||'Unknown'):escapeHtml(s.region||'Unknown Region');
      let btn;
      if(isMember)btn='<button class="btn-follow is-you" disabled>Member</button>';
      else if(!s.is_private&&currentUser)btn=`<button class="btn-follow" onclick="joinPublicCrew('${s.id}')">Join</button>`;
      else if(s.has_pending_request)btn='<button class="btn-follow" disabled>Requested</button>';
      else if(s.is_private&&currentUser)btn=`<button class="btn-follow" onclick="openJoinRequest('${s.id}','${escapeHtml(s.region||'')}')">Request</button>`;
      else if(!currentUser)btn='';
      else if(isFollowing)btn=`<button class="btn-follow following" onclick="toggleSpotFollow('${s.id}')">Following</button>`;
      else btn=`<button class="btn-follow" onclick="toggleSpotFollow('${s.id}')">Follow</button>`;
      return`<div class="browse-spot-card">
        ${s.cover_image_url?`<img src="${s.cover_image_url}" class="browse-spot-img" alt="">`:`<img src="${defaultCover(s.id)}" class="browse-spot-img" alt="">`}
        <div class="browse-spot-info"><div class="browse-spot-name">${displayName}</div><div class="browse-spot-meta">${s.member_count} member${s.member_count!==1?'s':''}${s.is_private?' · Private':' · Public'}${s.recent_sessions>0?' · Active':''}</div></div>
        ${btn}
      </div>`;
    }).join('');
  }catch{$('#browse-spot-list').innerHTML='<p class="muted" style="padding:1rem;text-align:center">Error</p>';}
}

window.toggleSpotFollow=async id=>{
  if(!currentUser)return toast('Log in first','error');
  const isFollowing=spotFollowingSet.has(id);
  if(isFollowing)spotFollowingSet.delete(id);else spotFollowingSet.add(id);
  loadBrowseSpots($('#browse-search').value.trim());
  await fetch(`${API_BASE}/api/spots/${id}/follow`,{method:isFollowing?'DELETE':'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});
  loadFeed();
};

// ===== SINGLE-SPOT FEED (fallback for logged-out) =====
async function loadSessions(){
  const list=$('#session-list');
  if(!currentSpot){list.innerHTML='<div class="empty-state"><p>Select a spot first to see the feed.</p></div>';return;}
  const p=new URLSearchParams();
  p.set('spot_id',currentSpot.id);if(currentUser)p.set('feed_for',currentUser.pubkey);
  try{const{sessions}=await(await fetch(`${API_BASE}/api/sessions?${p}`)).json();
  if(!sessions.length){list.innerHTML='<div class="empty-state"><p>No sessions yet. Be the first to log one!</p></div>';return;}
  list.innerHTML=sessions.map(s=>renderSessionCard(s)).join('');
  list.querySelectorAll('.feed-card').forEach(c=>c.addEventListener('click',()=>openSession(c.dataset.id)));
  }catch{list.innerHTML='<div class="empty-state">Error</div>';}
}

// ===== DETAIL =====
async function openSession(id){try{const{session:s,comments}=await(await fetch(`${API_BASE}/api/sessions/${id}`)).json();const d=new Date(s.session_date+'T12:00:00');const ds=d.toLocaleDateString('en',{weekday:'long',year:'numeric',month:'long',day:'numeric'});const sw=JSON.parse(s.swells_json||'[]');const swH=sw.map((x,i)=>`<div class="detail-block"><h4>${i?'Secondary':'Primary'} Swell</h4><p>${x.height_ft}ft ${x.period_s}s ${x.direction_compass} ${x.direction_deg}° <small style="opacity:.5">(${x.impact}%)</small></p></div>`).join('');
// Check if user can delete (own session or spot admin)
const canDelete=currentUser&&(s.pubkey===currentUser.pubkey||(currentSpot?.members?.some(m=>m.pubkey===currentUser.pubkey&&m.role==='admin')));
$('#session-detail').innerHTML=`<h2>${ds}</h2><p class="muted"><a href="${primalLink(s.pubkey)}" target="_blank" rel="noopener" class="user-link-inline">${escapeHtml(s.display_name||'Anon')}</a> · ${formatTOD(s.time_of_day)}</p><div style="margin:.75rem 0"><div class="rbadge ${getRatingClass(s.rating)}" style="width:52px;height:52px;font-size:1.3rem;display:inline-flex">${s.rating||'—'}/10</div></div><div class="detail-grid"><div class="detail-block"><h4>Surf</h4><p>${s.surf_height_min_ft||'?'}–${s.surf_height_max_ft||'?'} ft</p></div>${swH}<div class="detail-block"><h4>Wind</h4><p>${s.wind_speed_mph||'?'} mph ${s.wind_type?'('+s.wind_type+')':''}</p></div><div class="detail-block"><h4>Tide</h4><p>${s.tide_height_ft||'?'} ft</p></div>${s.wave_shape?`<div class="detail-block"><h4>Shape</h4><p style="text-transform:capitalize">${s.wave_shape}</p></div>`:''}${s.barrels>0?`<div class="detail-block"><h4>Tubes</h4><p>🤿 ${s.barrels}</p></div>`:''}</div>${s.video_path?`<div class="detail-video"><video controls src="${s.video_path}" preload="metadata"></video></div>`:''}${s.voice_memo_path?`<div class="detail-voice"><audio controls src="${s.voice_memo_path}" style="width:100%;height:36px"></audio>${s.voice_transcript?`<div class="detail-transcript">"${escapeHtml(s.voice_transcript)}"</div>`:''}</div>`:''}${s.notes?`<div class="detail-notes">${escapeHtml(s.notes)}</div>`:''}${canDelete?`<button class="btn-delete-session" onclick="deleteSession(${s.id})">Delete Log</button>`:''}${currentUser&&s.pubkey!==currentUser.pubkey?`<div class="detail-actions"><button class="btn-report" onclick="reportContent('session','${s.id}')">Report</button><button class="btn-report" onclick="blockUser('${s.pubkey}')">Block User</button></div>`:''}`;
$('#comments-list').innerHTML=comments.length?comments.map(c=>`<div class="comment"><div class="comment-meta"><a href="${primalLink(c.pubkey)}" target="_blank" rel="noopener" class="user-link-inline">${escapeHtml(c.display_name||'Anon')}</a> · ${new Date(c.created_at*1000).toLocaleDateString()}${currentUser&&c.pubkey!==currentUser.pubkey?` · <button class="btn-report-inline" onclick="event.stopPropagation();reportContent('comment','${c.id}')">Report</button>`:''}</div><div class="comment-body">${escapeHtml(c.body)}</div></div>`).join(''):'<p class="muted" style="font-size:.82rem">No comments yet</p>';
$('#comment-form').onsubmit=async e=>{e.preventDefault();if(!currentUser)return;const b=$('#comment-body').value.trim();if(!b)return;await fetch(`${API_BASE}/api/sessions/${id}/comments`,{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({body:b})});$('#comment-body').value='';openSession(id);};
$('#session-modal').classList.remove('hidden');}catch{toast('Error','error');}}
window.openSession=openSession;
window.openLoginModal=openLoginModal;

async function deleteSession(id){
  if(!confirm('Delete this log? This cannot be undone.'))return;
  try{
    const res=await fetch(`${API_BASE}/api/sessions/${id}`,{method:'DELETE',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});
    if(res.ok){toast('Log deleted');$('#session-modal').classList.add('hidden');loadSessions();}
    else{const err=await res.json();toast(err.error||'Failed','error');}
  }catch{toast('Failed to delete','error');}
}
window.deleteSession=deleteSession;

async function makeAdmin(spotId,pubkey){
  if(!confirm('Make this surfer an admin? They will be able to delete posts and invite others.'))return;
  try{
    await fetch(`${API_BASE}/api/spots/${spotId}/members/${pubkey}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({role:'admin'})});
    toast('Admin added');loadSurfers();
  }catch{toast('Failed','error');}
}
window.makeAdmin=makeAdmin;

async function reportContent(type,id){
  if(!currentUser)return toast('Log in first','error');
  const reason=prompt('Why are you reporting this? (optional)');
  if(reason===null)return; // cancelled
  try{
    await fetch(API_BASE+'/api/report',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({target_type:type,target_id:String(id),reason:reason||null})});
    toast('Reported. We will review this.');
  }catch{toast('Failed to report','error');}
}
window.reportContent=reportContent;

async function blockUser(pubkey){
  if(!currentUser)return toast('Log in first','error');
  if(!confirm('Block this user? Their content will be hidden from your feed.'))return;
  try{
    await fetch(`${API_BASE}/api/blocks/${pubkey}`,{method:'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});
    toast('User blocked');$('#session-modal').classList.add('hidden');
  }catch{toast('Failed to block','error');}
}
window.blockUser=blockUser;
$('#session-modal .modal-backdrop').addEventListener('click',()=>$('#session-modal').classList.add('hidden'));
$('#session-modal .modal-close').addEventListener('click',()=>$('#session-modal').classList.add('hidden'));

// ===== SEARCH =====
$('#search-btn').addEventListener('click',runSearch);$('#search-clear').addEventListener('click',()=>{['search-dir-min','search-dir-max','search-height-min','search-height-max','search-period-min','search-period-max','search-rating-min','search-rating-max'].forEach(id=>$(`#${id}`).value='');$('#search-results').innerHTML='';});
async function runSearch(){const p=new URLSearchParams();if(currentUser)p.set('pubkey',currentUser.pubkey);if(currentSpot)p.set('spot_id',currentSpot.id);const fields={dir_min:'search-dir-min',dir_max:'search-dir-max',height_min:'search-height-min',height_max:'search-height-max',period_min:'search-period-min',period_max:'search-period-max',rating_min:'search-rating-min',rating_max:'search-rating-max'};Object.entries(fields).forEach(([k,id])=>{const v=$(`#${id}`).value;if(v)p.set(k,v);});
try{const{sessions,summary}=await(await fetch(`${API_BASE}/api/search?${p}`)).json();const sr=$('#search-results');if(!sessions.length){sr.innerHTML='<div class="empty-state"><p>No matches.</p></div>';return;}
sr.innerHTML=`<div class="search-summary"><div class="search-stat"><span class="search-stat-label">Sessions</span><span class="search-stat-value">${summary.count}</span></div><div class="search-stat"><span class="search-stat-label">Avg</span><span class="search-stat-value">${summary.avg_rating||'—'}/10</span></div><div class="search-stat"><span class="search-stat-label">Best</span><span class="search-stat-value">${summary.best_rating||'—'}</span></div><div class="search-stat"><span class="search-stat-label">Worst</span><span class="search-stat-value">${summary.worst_rating||'—'}</span></div></div><div class="search-result-list">${sessions.map(s=>{const d=new Date(s.session_date+'T12:00:00'),sw=JSON.parse(s.swells_json||'[]');return`<div class="feed-card" onclick="openSession(${s.id})"><div class="feed-date"><div class="day">${d.getDate()}</div><div class="mo">${d.toLocaleString('en',{month:'short'})}</div></div><div class="feed-body"><div class="feed-user">${avatarHTML(s.avatar_path,s.display_name)}<span class="feed-name">${escapeHtml(s.display_name||'Anon')}</span></div><div class="feed-tags">${sw.map(x=>`<span class="tag tag-swell">${x.height_ft}ft ${x.period_s}s ${x.direction_compass}</span>`).join('')}</div></div><div class="feed-rating">${s.rating?`<div class="rbadge ${getRatingClass(s.rating)}">${s.rating}</div>`:''}</div></div>`;}).join('')}</div>`;}catch{$('#search-results').innerHTML='<div class="empty-state">Failed</div>';}}

// ===== FORECAST MATCH =====
async function loadAnalysis(){
  const el=$('#forecast-match');
  if(!currentSpot){el.innerHTML='<p class="empty-state">Select a crew to see forecast matches.</p>';return;}
  el.innerHTML='<div class="cond-loading">Matching forecast to past sessions...</div>';
  try{
    const slots=await(await fetch(`${API_BASE}/api/analysis/forecast-match?spot_id=${currentSpot.id}`)).json();
    if(!slots.length){el.innerHTML='<p class="empty-state">No forecast data available.</p>';return;}
    let currentDay='';
    el.innerHTML=slots.map(s=>{
      const dayHeader=s.day!==currentDay?(currentDay=s.day,`<div class="fm-day">${s.day} · ${new Date(s.date+'T12:00:00').toLocaleDateString('en',{month:'short',day:'numeric'})}</div>`):'';
      const emoji=s.avg_rating>=8?'🔥':s.avg_rating>=6?'🤙':s.avg_rating>=4?'👌':s.avg_rating?'😐':'';
      const ratingClass=s.avg_rating>=8?'fm-fire':s.avg_rating>=6?'fm-fun':s.avg_rating>=4?'fm-ok':'fm-meh';
      const matchHTML=s.match_count>0?`
        <div class="fm-result ${ratingClass}">
          <div class="fm-rating">${s.avg_rating}/10 ${emoji}</div>
          <div class="fm-stats">${s.match_count} similar session${s.match_count>1?'s':''} · best ${s.best_rating}/10 · worst ${s.worst_rating}/10</div>
          <div class="fm-sessions">${s.sessions.map(m=>`<div class="fm-session" onclick="openSession(${m.id})"><span class="fm-session-rating ${getRatingClass(m.rating)}">${m.rating}</span> ${m.swell_compass} ${m.swell_height}ft · ${m.wind_type||'?'} · ${m.date}</div>`).join('')}</div>
        </div>`:`<div class="fm-result fm-nodata"><div class="fm-no-match">No matching sessions yet</div><div class="fm-stats muted">Log more sessions with similar swells to get predictions</div></div>`;
      return`${dayHeader}<div class="fm-slot">
        <div class="fm-time">${formatTOD(s.time)}</div>
        <div class="fm-conditions">
          <span class="fm-swell">${s.swell.direction_compass} ${s.swell.height_ft}ft ${s.swell.period_s}s · ${s.swell.direction_deg}°</span>
          <span class="fm-wind">${s.wind.type||'?'} ${s.wind.speed_mph||'?'}mph</span>
          ${s.surf.min_ft?`<span class="fm-surf">${s.surf.min_ft}-${s.surf.max_ft}ft faces</span>`:''}
        </div>
        ${matchHTML}
      </div>`;
    }).join('');
  }catch(e){console.error(e);el.innerHTML='<p class="empty-state">Error loading forecast match.</p>';}
}

// ===== INVITE CLAIM (check URL) =====
async function checkInviteURL(){
  const m=location.pathname.match(/^\/join\/(\w+)$/);
  if(!m)return;
  try{
    const inv=await(await fetch(`${API_BASE}/api/invite/${m[1]}`)).json();
    if(inv.error){toast(inv.error,'error');return;}
    if(!currentUser){toast('Create an account first, then open the invite link again','error');return;}
    const res=await fetch(`${API_BASE}/api/invite/${m[1]}/claim`,{method:'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});
    const data=await res.json();
    if(data.ok){
      await loadMySpots();
      const spot=await(await fetch(`${API_BASE}/api/spots/${data.spot_id}`)).json();
      selectSpot(spot);
      toast(`Joined ${inv.spot_name}!`);
      history.replaceState(null,'','/');
    }
  }catch{toast('Invalid invite','error');}
}

// ===== PIPELINE TAB =====
let pipelineTimeout;
$('#pipeline-search')?.addEventListener('input',e=>{
  clearTimeout(pipelineTimeout);
  pipelineTimeout=setTimeout(()=>loadPipeline(e.target.value.trim()),300);
});

async function loadPipeline(q=''){
  const params=new URLSearchParams();if(q)params.set('q',q);
  const headers=currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{};
  const list=$('#pipeline-list');
  try{
    const spots=await(await fetch(`${API_BASE}/api/spots/browse?${params}`,{headers})).json();
    if(!spots.length){list.innerHTML='<div class="empty-state"><p>No crews found.</p></div>';return;}
    list.innerHTML=spots.map(s=>renderPipelineCard(s)).join('');
  }catch{list.innerHTML='<div class="empty-state"><p>Error loading crews.</p></div>';}
}

function renderPipelineCard(s){
  const displayName=s.is_member||!s.is_private?escapeHtml(s.name||s.region||'Unknown'):escapeHtml(s.region||'Unknown Region');
  const adminAvatars=(s.admins||[]).map(a=>
    a.avatar_path?`<img src="${a.avatar_path}" class="pipeline-admin-av" title="${escapeHtml(a.display_name||'')}" alt="">`
    :`<div class="pipeline-admin-av-placeholder" title="${escapeHtml(a.display_name||'')}">${(a.display_name||'?')[0].toUpperCase()}</div>`
  ).join('');
  const activity=s.recent_sessions>0?'<span class="pipeline-active">Active</span>':'';
  let actionBtn='';
  if(s.is_member)actionBtn='<button class="btn-follow is-you" disabled>Member</button>';
  else if(!s.is_private&&currentUser)actionBtn=`<button class="btn-solid btn-sm" onclick="event.stopPropagation();joinPublicCrew('${s.id}')">Join</button>`;
  else if(s.has_pending_request)actionBtn='<button class="btn-follow" disabled>Requested</button>';
  else if(currentUser)actionBtn=`<button class="btn-solid btn-sm" onclick="event.stopPropagation();openJoinRequest('${s.id}','${escapeHtml(s.region||'')}')">Request to Join</button>`;
  return`<div class="pipeline-card" onclick="${s.is_member?`joinExistingSpot('${s.id}')`:''}">
    ${s.cover_image_url?`<img src="${s.cover_image_url}" class="pipeline-cover" alt="">`:`<img src="${defaultCover(s.id)}" class="pipeline-cover" alt="">`}
    <div class="pipeline-info">
      <div class="pipeline-name">${displayName} ${activity}</div>
      ${s.description?`<div class="pipeline-desc">${escapeHtml(s.description)}</div>`:''}
      <div class="pipeline-meta">${s.member_count} member${s.member_count!==1?'s':''}${s.is_private?' · Private':' · Public'}</div>
      <div class="pipeline-admins">${adminAvatars}</div>
    </div>
    <div class="pipeline-action">${actionBtn}</div>
  </div>`;
}

// ===== JOIN REQUESTS =====
window.openJoinRequest=(spotId,regionName)=>{
  if(!currentUser)return toast('Log in first','error');
  $('#join-request-crew-name').textContent=regionName;
  $('#join-request-message').value='';
  $('#join-request-form').onsubmit=async e=>{
    e.preventDefault();
    const msg=$('#join-request-message').value.trim();
    try{
      const res=await fetch(`${API_BASE}/api/spots/${spotId}/join-request`,{
        method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},
        body:JSON.stringify({message:msg||null})
      });
      if(res.ok){toast('Request sent!');$('#join-request-modal').classList.add('hidden');loadPipeline($('#pipeline-search')?.value?.trim()||'');}
      else{const err=await res.json();toast(err.error||'Failed','error');}
    }catch{toast('Failed to send request','error');}
  };
  $('#join-request-modal').classList.remove('hidden');
};
$('#join-request-modal .modal-backdrop')?.addEventListener('click',()=>$('#join-request-modal').classList.add('hidden'));
$('#join-request-modal .modal-close')?.addEventListener('click',()=>$('#join-request-modal').classList.add('hidden'));

window.joinPublicCrew=async id=>{
  if(!currentUser)return toast('Log in first','error');
  try{
    const res=await fetch(`${API_BASE}/api/spots/${id}/join`,{method:'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});
    if(res.ok){toast('Joined!');await loadMySpots();loadBrowseSpots();const spot=await(await fetch(`${API_BASE}/api/spots/${id}`)).json();selectSpot(spot);}
    else{const err=await res.json();toast(err.error||'Failed','error');}
  }catch{toast('Failed to join','error');}
};

async function loadJoinRequests(){
  if(!currentUser||!currentSpot)return;
  const panel=$('#join-requests-panel');if(!panel)return;
  const isAdmin=currentSpot.members?.some(m=>m.pubkey===currentUser.pubkey&&m.role==='admin');
  if(!isAdmin){panel.classList.add('hidden');return;}
  try{
    const requests=await(await fetch(`${API_BASE}/api/spots/${currentSpot.id}/join-requests`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();
    if(!requests.length){panel.classList.add('hidden');return;}
    panel.classList.remove('hidden');
    $('#join-request-count').textContent=requests.length;
    $('#join-requests-list').innerHTML=requests.map(r=>`
      <div class="join-request-card">
        ${avatarHTML(r.avatar_path,r.display_name,'feed-avatar')}
        <div class="join-request-info">
          <div class="join-request-name">${escapeHtml(r.display_name||'Anon')}</div>
          ${r.message?`<div class="join-request-msg">"${escapeHtml(r.message)}"</div>`:''}
        </div>
        <button class="btn-solid btn-xs" onclick="resolveJoinRequest('${currentSpot.id}','${r.id}','approved')">Approve</button>
        <button class="btn-outline btn-xs" onclick="resolveJoinRequest('${currentSpot.id}','${r.id}','denied')">Deny</button>
      </div>
    `).join('');
  }catch{panel.classList.add('hidden');}
}

window.resolveJoinRequest=async(spotId,reqId,status)=>{
  try{
    await fetch(`${API_BASE}/api/spots/${spotId}/join-requests/${reqId}`,{
      method:'PUT',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},
      body:JSON.stringify({status})
    });
    toast(status==='approved'?'Approved!':'Denied');
    loadJoinRequests();loadSurfers();
  }catch{toast('Failed','error');}
};

// New crew button on Pipeline tab triggers the spot search flow
function openNewCrewFlow(){
  if(!currentUser)return toast('Create an account first','error');
  // Show the spot picker search for Surfline
  const modal=document.createElement('div');modal.className='modal';modal.id='find-spot-for-crew-modal';
  modal.innerHTML=`<div class="modal-backdrop"></div><div class="modal-content modal-sm">
    <button class="modal-close">&times;</button>
    <h2>Find a Surf Break</h2>
    <p class="modal-sub">Search Surfline for your break, then set up your crew.</p>
    <div class="field" style="margin:1rem 0"><input type="text" id="crew-spot-search" placeholder="Search surf breaks..." autocomplete="off"></div>
    <div id="crew-spot-results" class="spot-results"></div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.modal-backdrop').addEventListener('click',()=>modal.remove());
  modal.querySelector('.modal-close').addEventListener('click',()=>modal.remove());
  let t;
  modal.querySelector('#crew-spot-search').addEventListener('input',e=>{
    clearTimeout(t);const q=e.target.value.trim();
    if(q.length<2){modal.querySelector('#crew-spot-results').innerHTML='';return;}
    t=setTimeout(async()=>{
      try{
        const results=await(await fetch(`${API_BASE}/api/spots/search?q=${encodeURIComponent(q)}`)).json();
        modal.querySelector('#crew-spot-results').innerHTML=results.map(r=>`
          <div class="spot-result" data-surfline="${r.surfline_id}" data-name="${escapeHtml(r.name)}" data-loc="${escapeHtml(r.location)}" data-lat="${r.lat}" data-lng="${r.lng}">
            <div class="spot-result-icon">🌊</div>
            <div><div class="spot-result-name">${escapeHtml(r.name)}</div><div class="spot-result-loc">${escapeHtml(r.location)}</div></div>
          </div>
        `).join('')||'<p class="muted" style="padding:1rem;text-align:center">No breaks found</p>';
        modal.querySelectorAll('.spot-result').forEach(el=>el.addEventListener('click',()=>{
          pendingSpotData={surfline_spot_id:el.dataset.surfline,name:el.dataset.name,location_text:el.dataset.loc,lat:parseFloat(el.dataset.lat),lng:parseFloat(el.dataset.lng)};
          $('#create-spot-name').textContent=`${el.dataset.name} · ${el.dataset.loc}`;
          modal.remove();
          $('#create-spot-modal').classList.remove('hidden');
        }));
      }catch{}
    },300);
  });
  modal.querySelector('#crew-spot-search').focus();
}
$('#create-crew-btn')?.addEventListener('click',openNewCrewFlow);
$('#nav-add-crew')?.addEventListener('click',openNewCrewFlow);

// ===== INIT =====
const saved=localStorage.getItem('swellnotes_user');if(saved){try{currentUser=JSON.parse(saved);}catch{localStorage.removeItem('swellnotes_user');}}
const savedSpot=localStorage.getItem('swellnotes_spot');if(savedSpot){try{currentSpot=JSON.parse(savedSpot);selectSpot(currentSpot);}catch{localStorage.removeItem('swellnotes_spot');}}
console.log('[Init] user:',currentUser?.display_name||'none','spot:',currentSpot?.name||'none');
updateAuthUI();checkCallback();checkInviteURL();
if(!currentSpot)fetchConditions();
// Register service worker for PWA
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
// Capacitor: listen for deep link returns (NIP-46 callback)
if(IS_CAPACITOR){try{const CapApp=window.Capacitor.Plugins.App;if(CapApp)CapApp.addListener('appUrlOpen',data=>{if(data.url&&data.url.includes('login-callback'))checkCallback();});}catch{}}
