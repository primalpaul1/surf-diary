import{generateSecretKey,getPublicKey,nip19,finalizeEvent,Relay,getConversationKey,decrypt as nip44Decrypt,encrypt as nip44Encrypt,BunkerSigner,bytesToHex,hexToBytes,sha256}from'/nostr-bundle.js';
import * as authBackup from '/auth-backup.js';
let currentUser=null,currentSpot=null,mySpots=[],followingSet=new Set(),voiceBlob=null,voiceTranscript='',mediaRecorder=null,recordingChunks=[],recordingTimer=null,recordingSeconds=0,nip46Data=null,speechRecognition=null,videoFile=null,avatarFile=null,coverFile=null,pendingSpotData=null,isPro=false;
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const BLOSSOM='https://blossom.primal.net';
const RELAYS=['wss://relay.primal.net','wss://relay.damus.io','wss://nos.lol'];
const AUTOFOLLOW_NPUB='npub1spdnfacgsd7lk0nlqkq443tkq4jx9z6c6ksvaquuewmw7d3qltpslcq6j7';
const IS_CAPACITOR=!!window.Capacitor;
// Under Capacitor live-reload the page is served over http(s) from the dev
// server, so relative API calls hit the local backend. A real bundled build
// loads over capacitor:// and must target production.
const IS_LIVE_RELOAD=IS_CAPACITOR&&location.protocol.startsWith('http');
const API_BASE=(IS_CAPACITOR&&!IS_LIVE_RELOAD)?'https://swellnotes.com':'';
// Resolve a native plugin. This no-bundler app never loads @capacitor/core, so
// registerPlugin() and Capacitor.Plugins are NOT available for app-local plugins.
// The injected native bridge does expose nativePromise(plugin, method, opts),
// which is exactly what registerPlugin's proxy calls under the hood, so we build
// the shim from that and route straight to the native StoreKitPlugin by name.
function resolveNativePlugin(name,methods){
  const C=window.Capacitor;if(!C)return null;
  if(C.Plugins&&C.Plugins[name])return C.Plugins[name];
  if(typeof C.registerPlugin==='function'){try{return C.registerPlugin(name);}catch(e){}}
  if(typeof C.nativePromise==='function'){const o={};methods.forEach(m=>{o[m]=(opts)=>C.nativePromise(name,m,opts||{});});return o;}
  return null;
}
const StoreKit=IS_CAPACITOR?resolveNativePlugin('StoreKit',['getProducts','purchase','restorePurchases','getStatus']):null;
const PRIMAL_APP_STORE_HTTPS='https://apps.apple.com/app/id1673134518';
const PRIMAL_APP_STORE_ITMS='itms-apps://apps.apple.com/app/id1673134518';
// Normalize an avatar URL (Blossom URL or server-relative path) to an absolute https URL
// suitable for Nostr kind-0 publish + cross-domain image loads.
function absAvatarUrl(p){if(!p)return null;if(p.startsWith('http'))return p;return `https://swellnotes.com${p.startsWith('/')?'':'/'}${p}`;}
// Open Primal via SFSafariViewController (keeps Swellnotes' WebSocket alive during background;
// window.location.href backgrounds the app harder and iOS kills the relay socket).
async function launchPrimal(deepLink){if(IS_CAPACITOR&&window.Capacitor?.Plugins?.Browser){try{await window.Capacitor.Plugins.Browser.open({url:deepLink});return;}catch{}}window.location.href=deepLink;}
async function openPrimalAppStore(){const url=IS_CAPACITOR?PRIMAL_APP_STORE_ITMS:PRIMAL_APP_STORE_HTTPS;if(IS_CAPACITOR&&window.Capacitor?.Plugins?.Browser){try{await window.Capacitor.Plugins.Browser.open({url});return;}catch{}}window.location.href=url;}
// In the iOS app the WebView ignores target="_blank", so external links (Terms of Use, Privacy
// Policy, primal.net profiles) would silently do nothing, a non-functional link per App Store
// 3.1.2(c). Route every http(s) link to the in-app Safari view. (mailto:/tel: fall through to iOS.)
if(IS_CAPACITOR){document.addEventListener('click',e=>{
  const a=e.target?.closest?.('a[href]');if(!a)return;
  const href=a.getAttribute('href')||'';
  if(/^https?:\/\//i.test(href)){e.preventDefault();
    try{window.Capacitor?.Plugins?.Browser?.open({url:href});}catch{try{window.open(href,'_system');}catch{}}}
},true);}
const KEYCHAIN_USER_KEY='swellnotes_user';
function saveUser(u){
  // nsec is device-only: on iOS the secret goes ONLY into the ThisDeviceOnly Keychain
  // (hardware-encrypted, never synced, backup-excluded, survives WebView storage eviction);
  // localStorage keeps a secret-free stub for fast identity restore. On web (no Keychain
  // plugin) the secret stays in localStorage since there's no better store there.
  if(u.source==='nsec'&&IS_CAPACITOR&&window.Capacitor?.Plugins?.Keychain){
    const stub={pubkey:u.pubkey,display_name:u.display_name,avatar_path:u.avatar_path,source:'nsec'};
    localStorage.setItem(KEYCHAIN_USER_KEY,JSON.stringify(stub));
    try{window.Capacitor.Plugins.Keychain.save({key:KEYCHAIN_USER_KEY,value:JSON.stringify(u),deviceOnly:true});}catch(e){console.warn('[Keychain] save failed',e);}
    return;
  }
  const json=JSON.stringify(u);localStorage.setItem(KEYCHAIN_USER_KEY,json);
  if(u.source==='nsec')return; // web/imported: keep on-device, never sync to iCloud
  try{window.Capacitor?.Plugins?.Keychain?.save({key:KEYCHAIN_USER_KEY,value:json});}catch(e){console.warn('[Keychain] save failed',e);}}
function clearUser(){localStorage.removeItem(KEYCHAIN_USER_KEY);try{window.Capacitor?.Plugins?.Keychain?.clear({key:KEYCHAIN_USER_KEY});}catch(e){}}
// A brand-new account is a fresh user: reset the once-per-device onboarding flags so
// they see the spot picker + guided tour (and first-run tab hints).
function markFreshAccount(){localStorage.setItem(TAB_HINTS_KEY,'[]');localStorage.removeItem('swellnotes_onboarded');localStorage.removeItem('swellnotes_tour_v1');}
const DEFAULT_COVERS=['/covers/cover1.jpg','/covers/cover2.jpg','/covers/cover3.jpg','/covers/cover4.jpg'];
function defaultCover(id){return DEFAULT_COVERS[Math.abs([...((id||'')+'x')].reduce((h,c)=>((h<<5)-h)+c.charCodeAt(0),0))%DEFAULT_COVERS.length];}

// Nav
$$('.nav-btn[data-view]').forEach(b=>{b.addEventListener('click',()=>{$$('.nav-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.view').forEach(v=>v.classList.remove('active'));$(`#view-${b.dataset.view}`).classList.add('active');document.body.classList.toggle('pro-immersive',b.dataset.view==='pro');window.scrollTo(0,0);if(b.dataset.view==='history')loadFeed();if(b.dataset.view==='surfers')loadSurfers();if(b.dataset.view==='analysis')loadAnalysis();if(b.dataset.view==='pipeline')loadPipeline();if(b.dataset.view==='pro')renderProTab();if(b.dataset.view==='forecast')loadForecast();updateReportFab();syncHero();});});

// Floating "new report" button, visible on the Reports tab, jumps to the Log form
function updateReportFab(){const onHistory=$('.nav-btn.active')?.dataset?.view==='history';const hasSpots=(typeof mySpots!=='undefined')&&mySpots.length>0;$('#report-fab')?.classList.toggle('hidden',!(onHistory&&currentUser&&hasSpots));}
// The spot cover hero shows only on Log/Surfers/Analysis, never on the Reports feed
function syncHero(){const v=$('.nav-btn.active')?.dataset?.view;const show=!!currentSpot&&(v==='forecast'||v==='surfers'||v==='analysis');$('#hero')?.classList.toggle('hidden',!show);updateSpotNav();}
$('#report-fab')?.addEventListener('click',openQuickPost);

// ===== QUICK POST (Twitter-style composer, 2 steps) =====
let qpVideoFile=null,qpPhotos=[],qpVoiceBlob=null,qpVoiceTranscript='',qpSR=null,qpStep=1,qpLastRate=7;
let qpRec=null,qpRecChunks=[],qpRecTimer=null,qpRecSecs=0;
function nowTimeOfDay(){let h=new Date().getHours();if(h<5)h=5;if(h>18)h=18;if(h<12)return h+'am';if(h===12)return '12pm';return (h-12)+'pm';}
function qpRenderPreview(){
  const wrap=$('#qp-preview');if(!wrap)return;
  let html='';
  if(qpPhotos.length)html+=`<div class="qp-thumbs">${qpPhotos.map((f,i)=>`<div class="qp-thumb"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" class="qp-thumb-x" data-photo="${i}" aria-label="Remove">×</button></div>`).join('')}</div>`;
  else if(qpVideoFile)html+=`<div class="qp-thumbs"><div class="qp-thumb"><video src="${URL.createObjectURL(qpVideoFile)}" muted></video><button type="button" class="qp-thumb-x" data-vid aria-label="Remove">×</button></div></div>`;
  if(qpVoiceBlob)html+=`<div class="qp-voice-chip"><audio controls src="${URL.createObjectURL(qpVoiceBlob)}"></audio><button type="button" class="qp-thumb-x" data-voice aria-label="Remove">×</button></div>`;
  if(!html){wrap.classList.add('hidden');wrap.innerHTML='';return;}
  wrap.innerHTML=html;wrap.classList.remove('hidden');
  wrap.querySelectorAll('.qp-thumb-x').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.photo!=null){qpPhotos.splice(+b.dataset.photo,1);$('#qp-photo-file').value='';}
    else if(b.hasAttribute('data-vid')){qpVideoFile=null;$('#qp-video-file').value='';}
    else if(b.hasAttribute('data-voice')){qpVoiceBlob=null;qpVoiceTranscript='';}
    qpRenderPreview();
  }));
}
function qpSetupSR(){const S=window.SpeechRecognition||window.webkitSpeechRecognition;if(!S)return null;const r=new S();r.continuous=true;r.interimResults=true;r.lang='en-US';let ft='';r.onresult=e=>{for(let x=e.resultIndex;x<e.results.length;x++){if(e.results[x].isFinal)ft+=e.results[x][0].transcript+' ';}qpVoiceTranscript=ft.trim();};r.onerror=()=>{};return r;}
function qpGoStep(n){
  qpStep=n;
  $('#qp-step1').classList.toggle('hidden',n!==1);
  $('#qp-step2').classList.toggle('hidden',n!==2);
  $('#qp-dot1').classList.toggle('on',n===1);
  $('#qp-dot2').classList.toggle('on',n===2);
  $('#qp-left').textContent=n===1?'Cancel':'Back';
  $('#qp-right').textContent=n===1?'Next':'Post';
}
function openQuickPost(){
  if(!currentUser)return;
  if(!mySpots.length){toast('Join or create a crew first','error');return;}
  const sel=$('#qp-spot');
  sel.innerHTML=mySpots.map(s=>`<option value="${s.id}">${escapeHtml(s.name||'Spot')}</option>`).join('');
  // Default to the active Reports chip, else the current spot, else the first crew.
  const has=id=>id&&mySpots.some(s=>s.id===id);
  sel.value=has(feedFilter)?feedFilter:(has(currentSpot?.id)?currentSpot.id:mySpots[0].id);
  const av=$('#qp-av');if(currentUser.avatar_path){av.src=currentUser.avatar_path;av.style.visibility='';}else av.style.visibility='hidden';
  $('#qp-text').value='';
  $('#qp-rating').value=7;$('#qp-rating-val').textContent='7.0';qpLastRate=7;
  $$('#qp-tags .qp-tag').forEach(b=>b.classList.remove('on'));
  $('#qp-tags .qp-tag[data-type="surfed"]')?.classList.add('on');
  qpVideoFile=null;qpPhotos=[];qpVoiceBlob=null;qpVoiceTranscript='';$('#qp-video-file').value='';$('#qp-photo-file').value='';qpRenderPreview();
  qpGoStep(1);
  $('#quickpost').classList.remove('hidden');
  setTimeout(()=>$('#qp-text').focus(),50);
}
function closeQuickPost(){if(qpRec?.state==='recording')qpStopVoice();$('#quickpost').classList.add('hidden');}
$('#qp-left')?.addEventListener('click',()=>{qpStep===1?closeQuickPost():qpGoStep(1);});
$('#qp-right')?.addEventListener('click',()=>{qpStep===1?qpGoStep(2):doQuickPost();});
$('#quickpost')?.addEventListener('click',e=>{if(e.target.id==='quickpost')closeQuickPost();});
$('#qp-rating')?.addEventListener('input',e=>{const v=+e.target.value;$('#qp-rating-val').textContent=v.toFixed(1);if(v!==qpLastRate){hapticTick('LIGHT');qpLastRate=v;}});
$('#qp-tags')?.addEventListener('click',e=>{const b=e.target.closest('.qp-tag');if(!b)return;
  if(b.dataset.type){$$('#qp-tags .qp-tag[data-type]').forEach(x=>x.classList.remove('on'));b.classList.add('on');}
  else b.classList.toggle('on');
});
$('#qp-photo-btn')?.addEventListener('click',()=>$('#qp-photo-file').click());
$('#qp-photo-file')?.addEventListener('change',e=>{const sel=Array.from(e.target.files||[]);if(sel.length){qpPhotos=[...qpPhotos,...sel].slice(0,4);qpVideoFile=null;}e.target.value='';qpRenderPreview();});
$('#qp-video-btn')?.addEventListener('click',()=>$('#qp-video-file').click());
$('#qp-video-file')?.addEventListener('change',e=>{qpVideoFile=e.target.files[0]||null;if(qpVideoFile)qpPhotos=[];qpRenderPreview();});
$('#qp-voice-btn')?.addEventListener('click',()=>{qpRec?.state==='recording'?qpStopVoice():qpStartVoice();});
async function qpStartVoice(){
  try{
    if(IS_CAPACITOR){try{const Mic=window.Capacitor?.Plugins?.Microphone;if(Mic){const p=await Mic.requestPermissions();if(p.microphone!=='granted'){toast('Mic permission denied','error');return;}}}catch{}}
    const s=await navigator.mediaDevices.getUserMedia({audio:true});
    qpRecChunks=[];const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/mp4';
    qpRec=new MediaRecorder(s,{mimeType:mime});
    qpRec.ondataavailable=e=>{if(e.data.size>0)qpRecChunks.push(e.data);};
    qpRec.onstop=()=>{s.getTracks().forEach(t=>t.stop());qpVoiceBlob=new Blob(qpRecChunks,{type:mime});qpVoiceBlob._ext=mime.includes('mp4')?'m4a':'webm';qpRenderPreview();};
    qpRec.start(100);qpRecSecs=0;
    qpVoiceTranscript='';qpSR=qpSetupSR();if(qpSR)try{qpSR.start();}catch{}
    $('#qp-voice-btn').classList.add('recording');const t=$('#qp-rec-time');t.classList.remove('hidden');t.textContent='0:00';
    qpRecTimer=setInterval(()=>{qpRecSecs++;t.textContent=`${Math.floor(qpRecSecs/60)}:${String(qpRecSecs%60).padStart(2,'0')}`;},1000);
  }catch{toast('Mic denied','error');}
}
function qpStopVoice(){if(!qpRec||qpRec.state!=='recording')return;qpRec.stop();if(qpSR){try{qpSR.stop();}catch{}qpSR=null;}clearInterval(qpRecTimer);$('#qp-voice-btn')?.classList.remove('recording');$('#qp-rec-time')?.classList.add('hidden');}
async function doQuickPost(){
  if(!currentUser)return;
  const spotId=$('#qp-spot').value;if(!spotId)return toast('Pick a spot','error');
  const typeBtn=$('#qp-tags .qp-tag[data-type].on');
  const shapes=[...$$('#qp-tags .qp-tag[data-shape].on')].map(b=>b.dataset.shape);
  const data={
    session_date:new Date().toISOString().split('T')[0],
    time_of_day:nowTimeOfDay(),
    rating:+$('#qp-rating').value,
    barrels:0,
    wave_shape:shapes.join(',')||null,
    session_type:typeBtn?typeBtn.dataset.type:'surfed',
    notes:$('#qp-text').value.trim()||null,
    spot_id:spotId
  };
  const btn=$('#qp-right');btn.disabled=true;btn.textContent='Posting…';
  try{
    if(qpPhotos.length){data.photos=[];data.photos_base64=[];for(const f of qpPhotos){const u=await uploadToBlossom(f);if(u)data.photos.push(u);else{const r=new FileReader();const b64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(f);});data.photos_base64.push(b64);}}}
    if(qpVideoFile){const u=await uploadToBlossom(qpVideoFile);if(u)data.video_url=u;else{const r=new FileReader();data.video_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(qpVideoFile);});}}
    if(qpVoiceBlob){const ext=qpVoiceBlob._ext||'webm';const vf=new File([qpVoiceBlob],`voice.${ext}`,{type:ext==='m4a'?'audio/mp4':'audio/webm'});const u=await uploadToBlossom(vf);if(u)data.voice_url=u;else{const r=new FileReader();data.voice_memo_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(qpVoiceBlob);});data.voice_ext=ext;}data.voice_transcript=qpVoiceTranscript||null;}
    const res=await fetch(API_BASE+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify(data)});
    if(!res.ok)throw new Error('post failed');
    const result=await res.json().catch(()=>({}));
    const spot=mySpots.find(s=>s.id===spotId);
    closeQuickPost();toast('Posted!');
    document.body.classList.remove('pro-immersive');updateReportFab();
    // Offer to share to Nostr/Primal + WhatsApp (closing the share step lands on the feed)
    showShareModal({rating:data.rating,session_type:data.session_type,wave_shape:data.wave_shape,notes:data.notes,video_url:data.video_url||null,conditions:result.conditions||{},spot_name:spot?.name||currentSpot?.name||'Spot',sessionUrl:`https://swellnotes.com/session/${result.id||''}`});
  }catch{toast('Post failed','error');}
  finally{btn.disabled=false;btn.textContent='Post';}
}

// ===== TAB HINTS (first-run onboarding) =====
const TAB_HINTS_KEY='swellnotes_seen_tabs';
const ALL_TABS=['history','forecast','surfers','analysis','pipeline'];
const TAB_HINTS={
  history:{title:'Reports',body:'Browse past sessions and stats from your crew.'},
  surfers:{title:'Surfers',body:'See who\'s in your crew and follow other surfers.'},
  analysis:{title:'Analysis',body:'Match the incoming swell to your best past days.'},
  pipeline:{title:'Search',body:'Find a new spot or start your own crew.'}
};
function getSeenTabs(){try{return JSON.parse(localStorage.getItem(TAB_HINTS_KEY)||'[]');}catch{return[];}}
function markTabSeen(v){const s=getSeenTabs();if(!s.includes(v)){s.push(v);localStorage.setItem(TAB_HINTS_KEY,JSON.stringify(s));}renderTabDots();}
function renderTabDots(){$$('.nav-tip-dot').forEach(d=>d.remove());} // tab-hint bubbles retired, the guided tour replaces them
function maybeShowTabHint(v){const h=TAB_HINTS[v];if(!h)return;const seen=getSeenTabs();if(seen.includes(v))return;document.querySelector('.tab-hint')?.remove();const el=document.createElement('div');el.className='tab-hint';el.innerHTML=`<div class="tab-hint-body"><div class="tab-hint-title">${h.title}</div><div class="tab-hint-text">${h.body}</div></div><button class="tab-hint-close" aria-label="Dismiss">×</button>`;document.body.appendChild(el);const remove=()=>{el.classList.add('tab-hint-out');setTimeout(()=>el.remove(),200);};el.querySelector('.tab-hint-close').addEventListener('click',remove);setTimeout(remove,6000);markTabSeen(v);}
function initTabHints(){
  // If we've never tracked seen-tabs before AND a user is already logged in, mark all seen
  // (existing users who upgrade to this build shouldn't suddenly see hints).
  if(localStorage.getItem(TAB_HINTS_KEY)===null&&localStorage.getItem('swellnotes_user')){
    localStorage.setItem(TAB_HINTS_KEY,JSON.stringify(ALL_TABS));
  }
  renderTabDots();
}

function toast(m,t='success'){const e=document.createElement('div');e.className=`toast toast-${t}`;e.textContent=m;document.body.appendChild(e);setTimeout(()=>e.remove(),3000);}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
// Escape a URL for safe use inside a double-quoted HTML attribute. Blocks script-y
// schemes and neutralizes quote/angle breakout. Avatars, covers, and media URLs come
// from other users' Nostr profiles / uploads, so they're attacker-controllable.
function safeUrl(u){if(u==null)return'';const s=String(u);if(/^\s*(javascript|vbscript|data:text)/i.test(s))return'';return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function getRatingClass(r){if(!r)return'';return r<=3?'r-low':r<=5?'r-mid':r<=7?'r-high':'r-epic';}
function fmtRating(r){if(r==null)return'-';const n=Math.round(r*10)/10;return Number.isInteger(n)?String(n):n.toFixed(1);}
function formatTOD(t){return{'5am':'5 AM','6am':'6 AM','7am':'7 AM','8am':'8 AM','9am':'9 AM','10am':'10 AM','11am':'11 AM','12pm':'12 PM','1pm':'1 PM','2pm':'2 PM','3pm':'3 PM','4pm':'4 PM','5pm':'5 PM','6pm':'6 PM',dawn:'Dawn',morning:'AM',midday:'Midday',afternoon:'PM',evening:'Eve'}[t]||t;}
function ringCls(u){return (u&&u.is_pro&&((u.show_pro_ring??1)))?' pro-ring':'';}
// Dead avatar URLs render a broken-image glyph; swap the img for an initials placeholder.
window.__avErr=function(img,ch){const d=document.createElement('div');
  d.className=img.className.replace(/\bsurfer-av\b/,'surfer-av-placeholder').replace(/\bpcard-av\b/,'pcard-av-ph').replace(/\bfeed-avatar\b/,'feed-avatar-placeholder').replace(/\bcmt-av\b/,'cmt-av-ph');
  d.textContent=ch||'?';img.replaceWith(d);};
function avInitial(name){const c=(name||'?').trim()[0]||'?';return c.toUpperCase().replace(/['"<>&]/g,'?');}
function avatarHTML(path,name,cls='feed-avatar',pro=false){const rc=pro?' pro-ring':'';if(path)return`<img src="${safeUrl(path)}" class="${cls}${rc}" alt="" onerror="__avErr(this,'${avInitial(name)}')">`;return`<div class="${cls}-placeholder${rc}">${avInitial(name)}</div>`;}
function primalLink(pubkey){return`https://primal.net/p/${pubkey}`;}
function userLinkHTML(pubkey,name,avatarPath,cls='feed',pro=false){
  const url=primalLink(pubkey);
  const rc=pro?' pro-ring':'';
  const av=avatarPath?`<img src="${safeUrl(avatarPath)}" class="${cls}-avatar${rc}" alt="">`:`<div class="${cls}-avatar-placeholder${rc}">${(name||'?')[0].toUpperCase()}</div>`;
  return`<a href="${url}" target="_blank" rel="noopener" class="user-link" onclick="event.stopPropagation()">${av}<span class="${cls}-name">${escapeHtml(name||'Anon')}</span></a>`;
}

// ===== SPOT STATE =====
function selectSpot(spot){
  if(!spot||spot.error){console.error('Invalid spot:',spot);return;}
  // Leaving the Pro tab if it was open (e.g. via the spot switcher)
  if($('.nav-btn.active')?.dataset?.view==='pro'){document.body.classList.remove('pro-immersive');$$('.nav-btn').forEach(x=>x.classList.remove('active'));$('.nav-btn[data-view="log"]')?.classList.add('active');$$('.view').forEach(v=>v.classList.remove('active'));$('#view-log')?.classList.add('active');}
  currentSpot=spot;
  localStorage.setItem('swellnotes_spot',JSON.stringify(spot));
  localStorage.setItem('swellnotes_onboarded','1');
  const overlay=document.getElementById('onboard-overlay');if(overlay)overlay.remove();
  $('#spot-picker')?.classList.add('hidden');
  $('#app-header').classList.remove('hidden');
  renderTabDots();
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
    $('#log-members-btn')?.classList.remove('hidden');
    $('#invite-btn')?.classList.toggle('hidden',!mem); // any crew member can invite
    const isAdmin=mem?.role==='admin';
    $('#spot-settings-btn')?.classList.toggle('hidden',!isAdmin);
    $('#hero-cover-btn')?.classList.toggle('hidden',!isAdmin);
  }
  fetchConditions();
  updateSpotSwitcher();
  // Reload the active view for the new spot
  const activeView=$('.nav-btn.active')?.dataset?.view;
  if(activeView==='analysis')loadAnalysis();
  if(activeView==='history')loadFeed();
  if(activeView==='surfers')loadSurfers();
  if(activeView==='forecast')loadForecast();
  syncHero();
}

async function loadMySpots(){
  if(!currentUser)return;
  try{mySpots=await(await fetch(API_BASE+'/api/spots',{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();updateSpotSwitcher();}catch{}
}
// After a fresh login, drop into the first crew if none is active so the hero,
// forecast, and spot context populate (matches the Primal/completeLogin flow).
async function selectFirstSpotIfNone(){
  await loadMySpots();
  if(mySpots.length>0&&!currentSpot){
    try{const sp=await(await fetch(`${API_BASE}/api/spots/${mySpots[0].id}`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();if(sp&&!sp.error)selectSpot(sp);}catch{}
  }
}

function updateSpotSwitcher(){
  // The old dropdown above the tabs is gone, switching happens via the Reports
  // chip row and the hero top-right picker. Keep #spot-select (hidden) populated
  // for the change handler, and refresh the new spot-nav UI.
  $('#spot-switcher')?.classList.add('hidden');
  const sel=$('#spot-select');
  if(sel)sel.innerHTML=mySpots.map(s=>`<option value="${s.id}" ${currentSpot?.id===s.id?'selected':''}>${s.name}</option>`).join('');
  renderFeedChips();updateSpotNav();updateReportFab();
}

$('#spot-select').addEventListener('change',async e=>{
  const spot=mySpots.find(s=>s.id===e.target.value);
  if(spot){const full=await(await fetch(`${API_BASE}/api/spots/${spot.id}`,{headers:currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{}})).json();selectSpot(full);}
});

// ----- Spot nav: Reports chip row + hero top-right picker -----
async function switchSpot(id){
  const s=(mySpots||[]).find(x=>x.id===id);if(!s)return;
  try{const full=await(await fetch(`${API_BASE}/api/spots/${id}`,{headers:currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{}})).json();selectSpot(full&&!full.error?full:s);}
  catch{selectSpot(s);}
}
function renderFeedChips(){
  const el=$('#feed-chips');if(!el)return;
  const spots=(mySpots||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  // Drop a remembered filter whose spot no longer exists
  if(feedFilter!=='__all'&&!spots.some(s=>s.id===feedFilter)){feedFilter='__all';localStorage.removeItem('swellnotes_feed_filter');}
  const chips=[{id:'__all',name:'All spots'},...spots];
  el.innerHTML=chips.map(c=>`<button class="feed-chip${c.id===feedFilter?' active':''}" data-spot="${c.id}">${escapeHtml(c.name)}</button>`).join('');
  el.querySelectorAll('.feed-chip').forEach(b=>b.addEventListener('click',()=>{
    feedFilter=b.dataset.spot;
    if(feedFilter==='__all')localStorage.removeItem('swellnotes_feed_filter');else localStorage.setItem('swellnotes_feed_filter',feedFilter);
    el.querySelectorAll('.feed-chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');
    renderReportFeed();
  }));
}
function updateHeroPicker(){
  const v=$('.nav-btn.active')?.dataset?.view;
  const show=!!currentSpot&&(v==='forecast'||v==='surfers'||v==='analysis');
  const btn=$('#hero-spot-picker');if(btn){btn.classList.toggle('hidden',!show);if(show)$('#hero-spot-picker-name').textContent=currentSpot.name||'Spot';}
  if(!show)$('#hero-spot-menu')?.classList.add('hidden');
}
function updateSpotNav(){
  const v=$('.nav-btn.active')?.dataset?.view;
  const onReports=v==='history'&&!!currentUser;
  $('#feed-chips')?.classList.toggle('hidden',!onReports);
  updateHeroPicker();
}
$('#hero-spot-picker')?.addEventListener('click',e=>{
  e.stopPropagation();
  const menu=$('#hero-spot-menu');if(!menu)return;
  if(!menu.classList.contains('hidden')){menu.classList.add('hidden');return;}
  const spots=(mySpots||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  menu.innerHTML=spots.map(s=>`<button data-spot="${s.id}" class="${currentSpot?.id===s.id?'active':''}">${escapeHtml(s.name)}</button>`).join('')+`<button data-spot="__browse">+ Find a crew</button>`;
  menu.querySelectorAll('button').forEach(b=>b.addEventListener('click',ev=>{ev.stopPropagation();menu.classList.add('hidden');
    if(b.dataset.spot==='__browse'){$('.nav-btn[data-view="pipeline"]')?.click();return;}switchSpot(b.dataset.spot);}));
  menu.classList.remove('hidden');
  // Anchor the fixed menu under the picker and cap its height to the viewport so
  // it scrolls internally instead of being clipped by the hero's overflow:hidden.
  const r=$('#hero-spot-picker').getBoundingClientRect();
  menu.style.top=(r.bottom+8)+'px';
  menu.style.left='auto';
  menu.style.right=Math.max(8,window.innerWidth-r.right)+'px';
  menu.style.maxHeight=Math.max(160,window.innerHeight-r.bottom-24)+'px';
});
document.addEventListener('click',()=>$('#hero-spot-menu')?.classList.add('hidden'));

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
        $('#create-spot-name').textContent=`Forecasts from ${el.dataset.name} · kept private`;if($('#spot-name'))$('#spot-name').value='';
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
      <div class="spot-result-icon">${`<img src="${safeUrl(s.cover_image_url||defaultCover(s.id))}" style="width:36px;height:36px;border-radius:8px;object-fit:cover">`}</div>
      <div><div class="spot-result-name">${escapeHtml(s.name)}</div><div class="spot-result-loc">${s.member_count||'?'} members</div></div>
    </div>
  `).join('');
}
window.joinExistingSpot=async id=>{localStorage.setItem('swellnotes_onboarded','1');const spot=await(await fetch(`${API_BASE}/api/spots/${id}`,{headers:currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{}})).json();landInSpot(spot);};
// Joining/selecting a spot should have a payoff: land in that spot's Reports feed,
// not silently stay on Search. `welcome` also shows a one-time banner atop the feed.
let justJoinedSpot=null;
function landInSpot(spot,{welcome=false}={}){
  if(!spot||spot.error)return;
  selectSpot(spot);
  if(welcome)justJoinedSpot={name:spot.name,members:spot.member_count};
  document.querySelector('.nav-btn[data-view="history"]')?.click();
  window.scrollTo(0,0);
}
window.dismissWelcome=()=>{justJoinedSpot=null;document.getElementById('welcome-banner')?.remove();};
// Let users dismiss the "Select a spot" overlay, they can pick one later from Search.
window.dismissOnboard=()=>{localStorage.setItem('swellnotes_onboarded','1');document.getElementById('onboard-overlay')?.remove();};
// Jump to the Search tab where you find / create / select a spot (used by empty-state links).
window.goToSpotPicker=()=>{document.querySelector('.nav-btn[data-view="pipeline"]')?.click();};
// Tapping your name/avatar in the header opens your Primal profile.
$('.user-pill')?.addEventListener('click',()=>{
  if(!currentUser?.pubkey)return;
  const url=primalLink(currentUser.pubkey);
  if(IS_CAPACITOR&&window.Capacitor?.Plugins?.Browser){window.Capacitor.Plugins.Browser.open({url});}
  else{window.open(url,'_blank');}
});

// ===== CREATE SPOT =====
// Hero cover photo (admin only)
$('#hero-cover-btn').addEventListener('click',()=>$('#hero-cover-file').click());
$('#fm-info-btn')?.addEventListener('click',()=>$('#fm-info-pop')?.classList.toggle('hidden'));
$('#hero-cover-file').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file||!currentUser||!currentSpot)return;
  try{
    $('#hero-cover-btn').classList.add('loading');$('#hero-cover-btn').disabled=true;
    let url=await uploadToBlossom(file);
    if(!url){url=await uploadToServer(file);if(!url){toast('Upload failed','error');return;}}
    await fetch(`${API_BASE}/api/spots/${currentSpot.id}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({cover_image_url:url})});
    $('#hero-img').src=url;currentSpot.cover_image_url=url;
    toast('Cover updated!');
  }catch{toast('Failed','error');}
  finally{$('#hero-cover-btn').classList.remove('loading');$('#hero-cover-btn').disabled=false;}
});

$('#create-spot-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!currentUser||!pendingSpotData)return;
  try{
    const body={...pendingSpotData,name:$('#spot-name')?.value.trim()||pendingSpotData.name,is_private:$('#spot-private').checked,description:$('#spot-description')?.value.trim()||null};
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

// ===== LOG MEMBERS + INVITES =====
$('#log-members-btn')?.addEventListener('click',()=>{if(currentSpot)showMembers(currentSpot.id,currentSpot.name);});
// ===== INVITE SHEET (universal: crew invite OR app invite) =====
let inviteLink='https://swellnotes.com',inviteMsg='';
// opts.spotId + opts.spotName => crew invite (any member); no opts => personal app invite.
async function openInviteSheet(opts={}){
  if(!currentUser)return;
  const modal=$('#invite-modal');
  $('#invite-qr-panel').classList.add('hidden'); // reset QR
  if(opts.spotId){
    $('#invite-title').textContent=`Invite to ${opts.spotName||'this crew'}`;
    $('#invite-sub').textContent='Anyone with this link joins your crew.';
    $('#invite-link-input').value='Creating link…';inviteLink='';modal.classList.remove('hidden');
    try{
      const res=await fetch(`${API_BASE}/api/spots/${opts.spotId}/invites`,{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({})});
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||'Failed');
      inviteLink=data.link||`https://swellnotes.com/join/${data.invite_code}`;
      inviteMsg=`Join my crew at ${opts.spotName||'our spot'} on Swellnotes 🏄`;
    }catch(e){toast(e.message||'Failed to create invite','error');modal.classList.add('hidden');return;}
  }else{
    $('#invite-title').textContent='Invite friends';
    $('#invite-sub').textContent='Bring your surf crew to Swellnotes.';
    inviteLink=`https://swellnotes.com/join?ref=${currentUser.pubkey}`; // personal, attributed
    inviteMsg='Come log surf with me on Swellnotes 🏄';
    modal.classList.remove('hidden');
  }
  $('#invite-link-input').value=inviteLink;
  $('#invite-qr-img').src=`${API_BASE}/api/qr?data=${encodeURIComponent(inviteLink)}`;
}
window.inviteToCrew=()=>{if(currentSpot)openInviteSheet({spotId:currentSpot.id,spotName:currentSpot.name});};
function inviteShareText(){return `${inviteMsg}\n${inviteLink}`;}
$('#invite-btn').addEventListener('click',()=>{if(currentSpot)openInviteSheet({spotId:currentSpot.id,spotName:currentSpot.name});});
$('#settings-invite-btn')?.addEventListener('click',()=>{$('#settings-modal').classList.add('hidden');openInviteSheet();});
$('#invite-share-btn').addEventListener('click',async()=>{if(!inviteLink)return;try{await navigator.share({title:'Swellnotes',text:inviteMsg,url:inviteLink});}catch{navigator.clipboard?.writeText(inviteLink);toast('Link copied');}});
$('#invite-wa').addEventListener('click',()=>{if(inviteLink)window.open('https://wa.me/?text='+encodeURIComponent(inviteShareText()),'_blank');});
$('#invite-msg').addEventListener('click',()=>{if(inviteLink)window.open('sms:&body='+encodeURIComponent(inviteShareText()));});
$('#invite-qr-btn').addEventListener('click',()=>{$('#invite-qr-panel').classList.toggle('hidden');});
$('#copy-invite').addEventListener('click',()=>{$('#invite-link-input').select();navigator.clipboard?.writeText(inviteLink);toast('Copied!');});
$('#invite-modal .modal-backdrop').addEventListener('click',()=>$('#invite-modal').classList.add('hidden'));
$('#invite-modal .modal-close').addEventListener('click',()=>$('#invite-modal').classList.add('hidden'));

// Crew Settings
let crewCoverFile=null;
$('#spot-settings-btn').addEventListener('click',()=>{
  if(!currentSpot)return;
  $('#crew-settings-name').value=currentSpot.name||'';
  $('#crew-settings-description').value=currentSpot.description||'';
  $('#crew-settings-private').checked=!!currentSpot.is_private;
  if(currentSpot.cover_image_url){$('#crew-cover-preview').innerHTML=`<img src="${safeUrl(currentSpot.cover_image_url)}">`;}
  else{$('#crew-cover-preview').innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>Change Cover Photo</span>';}
  crewCoverFile=null;
  $('#crew-settings-modal').classList.remove('hidden');
});
$('#crew-cover-upload').addEventListener('click',()=>$('#crew-cover-file').click());
$('#crew-cover-file').addEventListener('change',e=>{crewCoverFile=e.target.files[0];if(!crewCoverFile)return;const r=new FileReader();r.onload=ev=>{$('#crew-cover-preview').innerHTML=`<img src="${ev.target.result}">`};r.readAsDataURL(crewCoverFile);});
$('#crew-settings-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!currentSpot||!currentUser)return;
  try{
    const body={name:$('#crew-settings-name').value.trim(),description:$('#crew-settings-description').value.trim()||null,is_private:$('#crew-settings-private').checked};
    if(crewCoverFile){let url=await uploadToBlossom(crewCoverFile);if(!url)url=await uploadToServer(crewCoverFile);if(url)body.cover_image_url=url;}
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

async function uploadToServer(file){
  try{
    const r=new FileReader();
    const b64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(file);});
    const res=await fetch(API_BASE+'/api/upload',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({base64:b64})});
    if(!res.ok)return null;const data=await res.json();return data.url;
  }catch{return null;}
}

// ===== NIP-46 REMOTE SIGNING =====
async function nip46Sign(unsignedEvent){
  const n=currentUser?.nip46;
  if(!n?.localSecretKey||!n?.bunkerPubkey)throw new Error('No NIP-46 connection');
  const skb=hexToBytes(n.localSecretKey);
  const localPubkey=getPublicKey(skb);
  const relay=await Relay.connect('wss://relay.primal.net');
  try{
    const rpcId=crypto.randomUUID();
    const payload=JSON.stringify({id:rpcId,method:'sign_event',params:[JSON.stringify(unsignedEvent)]});
    const convKey=getConversationKey(skb,n.bunkerPubkey);
    const enc=nip44Encrypt(payload,convKey);
    const rpcEvent=finalizeEvent({kind:24133,created_at:Math.floor(Date.now()/1000),tags:[['p',n.bunkerPubkey]],content:enc},skb);
    await relay.publish(rpcEvent);
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{relay.close();reject(new Error('Sign timeout'));},15000);
      relay.subscribe([{kinds:[24133],'#p':[localPubkey],limit:0}],{
        onevent:ev=>{
          try{
            const dec=nip44Decrypt(ev.content,getConversationKey(skb,ev.pubkey));
            const r=JSON.parse(dec);
            if(r.id===rpcId&&r.result){clearTimeout(timeout);relay.close();resolve(JSON.parse(r.result));}
          }catch{}
        }
      });
    });
  }catch(e){try{relay.close();}catch{}throw e;}
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
async function publishProfile(name,pic,nip05){if(!currentUser?.secretKey)return;try{/* finalizeEvent from bundle *//* Relay from bundle *//* hexToBytes from bundle */const ex=await fetchProfile(currentUser.pubkey);if(currentUser.source==='nsec'&&!ex)return;const p={...(ex||{}),name};if(pic)p.picture=pic;if(nip05)p.nip05=nip05;const ev=finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify(p)},hexToBytes(currentUser.secretKey));for(const u of RELAYS){try{const r=await Relay.connect(u);await r.publish(ev);r.close();}catch{}}}catch{}}
async function fetchKind3(pk){try{/* Relay from bundle */const relay=await Relay.connect(RELAYS[0]);return new Promise(r=>{let ev=null;relay.subscribe([{kinds:[3],authors:[pk],limit:1}],{onevent:e=>{if(!ev||e.created_at>ev.created_at)ev=e;},oneose:()=>{relay.close();r(ev);}});setTimeout(()=>{try{relay.close();}catch{}r(ev);},5000);});}catch{return null;}}
async function publishKind3(pks){if(!currentUser?.secretKey||currentUser.source==='nsec')return;try{/* imported keys: never broadcast a follow list (would wipe their real kind-3) *//* finalizeEvent from bundle *//* Relay from bundle *//* hexToBytes from bundle */const ev=finalizeEvent({kind:3,created_at:Math.floor(Date.now()/1000),tags:pks.map(p=>['p',p]),content:''},hexToBytes(currentUser.secretKey));for(const u of RELAYS){try{const r=await Relay.connect(u);await r.publish(ev);r.close();}catch{}}}catch{}}
async function syncFollowsFromRelay(){if(!currentUser)return;const ev=await fetchKind3(currentUser.pubkey);if(!ev)return;const pks=ev.tags.filter(t=>t[0]==='p').map(t=>t[1]);followingSet=new Set(pks);for(const pk of pks){try{await fetch(`${API_BASE}/api/follows/${pk}`,{method:'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});}catch{}}}

// Auto-follow the default Swellnotes npub for new signups (in-app + Nostr kind 3)
async function autoFollowDefault(){
  if(!currentUser||!AUTOFOLLOW_NPUB)return;
  try{
    const d=nip19.decode(AUTOFOLLOW_NPUB);
    const hex=d?.data;
    if(!hex||typeof hex!=='string'||hex===currentUser.pubkey)return;
    followingSet.add(hex);
    try{await fetch(`${API_BASE}/api/follows/${hex}`,{method:'POST',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});}catch{}
    await publishKind3([...followingSet]);
  }catch(err){console.error('Auto-follow failed:',err);}
}

// ===== LANDING PAGE AUTH =====
$('#landing-primal-btn').addEventListener('click',openLoginModal);
// Create Account: generate a fresh local key, then collect name + photo in the profile step.
$('#landing-create-btn')?.addEventListener('click',()=>{
  const sk=generateSecretKey(),secretKey=bytesToHex(sk),pubkey=getPublicKey(sk);
  openProfileSetup({pubkey,secretKey,npub:nip19.npubEncode(pubkey)});
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
  let avatarUrl=null;if(avatarFile)avatarUrl=await uploadToBlossom(avatarFile);
  const body={pubkey,display_name:name};if(avatarUrl)body.avatar_url=avatarUrl;
  else if(avatarFile){const r=new FileReader();body.avatar_base64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(avatarFile);});}
  const res=await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json();
  if(!res.ok){
    if(data?.error==='name_taken')toast(data.message||'That name is taken. Pick another.','error');
    else toast(data?.error||'Failed','error');
    return;
  }
  currentUser={pubkey,secretKey,display_name:name,avatar_path:absAvatarUrl(data.avatar_path)||avatarUrl};
  saveUser(currentUser);
  markFreshAccount(); // new account → show first-run tab hints
  publishProfile(name,avatarUrl||absAvatarUrl(data.avatar_path),data.nip05_full).catch(()=>{}); // fire-and-forget: relay publish must not block login
  autoFollowDefault();
  updateAuthUI();$('#create-modal').classList.add('hidden');avatarFile=null;toast(`Welcome, ${name}!`);maybeStartTour(700);
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
      // Start relay listener BEFORE redirecting, so it's ready when user returns
      waitForNIP46();
      // Small delay to let listener start, then redirect to Primal
      setTimeout(()=>{
        const st=$('#landing-primal-status');if(st){$('#landing-primal-status-text').textContent='Waiting for Primal...';}
        launchPrimal(nip46Data.mobileURI);
      },300);
    }else{
      $('#qr-image').src=nip46Data.qrDataUrl;$('#login-qr').classList.remove('hidden');$('#login-loading').classList.add('hidden');
      waitForNIP46();
    }
  }catch(err){
    console.error('Login init error:',err);
    toast('Login failed, please try again','error');
    if(!isMobile)$('#login-modal').classList.add('hidden');
    else{$('#landing-primal-btn').disabled=false;$('#landing-primal-btn').style.opacity='';const st=$('#landing-primal-status');if(st){st.classList.add('hidden');st.style.display='';}}
  }
}
$('#mobile-login-btn')?.addEventListener('click',()=>{if(!nip46Data)return;localStorage.setItem('nip46_pending',JSON.stringify({localSecretKey:nip46Data.secretKey,localPublicKey:nip46Data.publicKey,secret:nip46Data.secret,timestamp:Date.now()}));launchPrimal(nip46Data.mobileURI);});
$('#landing-primal-appstore')?.addEventListener('click',e=>{e.preventDefault();openPrimalAppStore();});
$('#modal-primal-appstore')?.addEventListener('click',e=>{e.preventDefault();openPrimalAppStore();});
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
              // Response will come as another event, set a timeout fallback
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
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!currentUser){checkCallback();if(nip46Data&&!nip46Data._completed){console.log('[NIP46] App resumed, reconnecting relay...');waitForNIP46();}}});

async function completeLogin(pk){
  if(nip46Data)nip46Data._completed=true;
  const profile=await fetchProfile(pk);const name=profile?.name||profile?.display_name||pk.slice(0,8)+'...';const picture=profile?.picture||null;
  await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:pk,display_name:name,avatar_url:picture})});
  // Save NIP-46 connection data for remote signing
  const pending=JSON.parse(localStorage.getItem('nip46_pending')||'null');
  const connected=JSON.parse(localStorage.getItem('nip46_connected')||'null');
  const localSk=nip46Data?.secretKey||pending?.localSecretKey||null;
  const bunkerPk=nip46Data?._bunkerPubkey||connected?.bunkerPubkey||null;
  const wasNewUser=!localStorage.getItem(TAB_HINTS_KEY);
  currentUser={pubkey:pk,display_name:name,avatar_path:picture};
  if(localSk&&bunkerPk)currentUser.nip46={localSecretKey:localSk,bunkerPubkey:bunkerPk};
  saveUser(currentUser);
  if(wasNewUser)markFreshAccount(); // first-time Primal login on this device → show hints
  // Reset mobile login UI
  $('#landing-primal-btn').disabled=false;$('#landing-primal-btn').style.opacity='';
  const st=$('#landing-primal-status');if(st){st.classList.add('hidden');st.style.display='';}
  updateAuthUI();$('#login-loading')?.classList.add('hidden');$('#login-qr')?.classList.add('hidden');$('#mobile-login-btn')?.classList.add('hidden');$('#login-connected')?.classList.remove('hidden');
  // Auto-load and select first spot after login
  await loadMySpots();
  if(mySpots.length>0&&!currentSpot){const spot=await(await fetch(`${API_BASE}/api/spots/${mySpots[0].id}`,{headers:currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{}})).json();if(spot&&!spot.error)selectSpot(spot);}
  setTimeout(()=>{$('#login-modal').classList.add('hidden');toast(`Welcome, ${name}!`);},1000);
}

async function checkCallback(){const c=localStorage.getItem('nip46_connected');if(!c)return;try{const d=JSON.parse(c);if(Date.now()-d.timestamp>300000){localStorage.removeItem('nip46_connected');return;}await completeLogin(d.bunkerPubkey);localStorage.removeItem('nip46_connected');}catch{localStorage.removeItem('nip46_connected');}}

$('#login-modal .modal-backdrop').addEventListener('click',()=>$('#login-modal').classList.add('hidden'));
$('#login-modal .modal-close').addEventListener('click',()=>$('#login-modal').classList.add('hidden'));
// ===== SETTINGS =====
$('#settings-btn').addEventListener('click',async()=>{
  if(!currentUser)return;
  $('#settings-name').textContent=currentUser.display_name;
  if(currentUser.avatar_path){$('#settings-avatar').src=currentUser.avatar_path;$('#settings-avatar').style.display='';}
  else $('#settings-avatar').style.display='none';
  const profBtn=$('#settings-primal-profile-btn');if(profBtn)profBtn.href=primalLink(currentUser.pubkey);
  // Pro: gold-ring toggle only for Pro members
  if(isPro){$('#settings-pro-section').classList.remove('hidden');$('#settings-pro-ring').checked=!!(currentUser.show_pro_ring??1);}
  else $('#settings-pro-section').classList.add('hidden');
  updateOwnAvatarRing();
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
      const data=await res.json();avatarUrl=absAvatarUrl(data.avatar_path);
    } else {
      await fetch(API_BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:currentUser.pubkey,display_name:currentUser.display_name,avatar_url:avatarUrl})});
    }
    currentUser.avatar_path=avatarUrl;saveUser(currentUser);
    $('#settings-avatar').src=avatarUrl;$('#settings-avatar').style.display='';
    if($('#user-avatar'))$('#user-avatar').src=avatarUrl;
    // Re-publish kind-0 to Nostr so Primal etc. see the new picture
    publishProfile(currentUser.display_name,avatarUrl,null);
    toast('Photo updated!');
  }catch{toast('Failed to update photo','error');}
});
$('#settings-modal .modal-backdrop').addEventListener('click',()=>$('#settings-modal').classList.add('hidden'));
$('#settings-modal .modal-close').addEventListener('click',()=>$('#settings-modal').classList.add('hidden'));

$('#delete-account-btn').addEventListener('click',async()=>{
  if(!currentUser)return;
  if(!confirm('Delete your account?\n\nThis permanently removes your sessions, comments, follows, and profile from Swellnotes. This cannot be undone.'))return;
  if(!confirm('Last chance, really delete your account and all your sessions?'))return;
  try{
    const res=await fetch(API_BASE+'/api/users',{method:'DELETE',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});
    if(!res.ok)throw new Error('Delete failed');
    currentUser=null;currentSpot=null;mySpots=[];followingSet.clear();
    clearUser();
    localStorage.removeItem('swellnotes_spot');
    localStorage.removeItem('nip46_pending');
    localStorage.removeItem('nip46_connected');
    toast('Account deleted');
    location.reload();
  }catch(e){toast('Failed to delete account','error');}
});

$('#logout-btn').addEventListener('click',async()=>{
  // Step 1: Show key and first warning
  let keyDisplay='';
  if(currentUser?.secretKey){
    try{const nsec=nip19.nsecEncode(hexToBytes(currentUser.secretKey));keyDisplay=nsec;}
    catch{keyDisplay=currentUser.secretKey;}
  }
  const msg=keyDisplay
    ?`⚠️ Save your secret key before logging out!\n\nYour key:\n${keyDisplay}\n\nCopy it somewhere safe, you cannot recover your account without it.\n\nAre you sure you want to log out?`
    :'⚠️ Are you sure you want to log out?';
  if(!confirm(msg))return;
  // Copy key to clipboard if available
  if(keyDisplay)try{await navigator.clipboard?.writeText(keyDisplay);toast('Key copied to clipboard');}catch{}
  // Step 2: Final confirmation
  if(!confirm('Last chance, are you really sure? You will lose access to this account if you haven\'t saved your key.'))return;
  currentUser=null;currentSpot=null;mySpots=[];followingSet.clear();clearUser();localStorage.removeItem('swellnotes_spot');updateAuthUI();location.reload();
});

function updateAuthUI(){
  document.body.classList.remove('pro-immersive');
  if(currentUser){
    $('#landing-page').classList.add('hidden');
    document.body.style.overflow='';
    $('#app-header').classList.remove('hidden');
    $('#auth-buttons').classList.add('hidden');$('#user-info').classList.remove('hidden');$('#spot-picker-auth')?.classList.add('hidden');$('#user-name').textContent=currentUser.display_name;const av=$('#user-avatar');if(currentUser.avatar_path){av.src=currentUser.avatar_path;av.style.display='';}else av.style.display='none';av.classList.toggle('pro-ring',!!ringCls(currentUser));$('#submit-btn').disabled=false;$('#submit-btn').textContent='Log Session';$('#comment-form')?.classList.remove('hidden');checkProStatus();
    if(!currentSpot){
      // No crew selected, show main app with Search tab active
      $('#spot-picker')?.classList.add('hidden');$('#main-content')?.classList.remove('hidden');
      $('#hero').classList.add('hidden');$('#app-header').classList.remove('hidden');
      $$('.nav-btn').forEach(x=>x.classList.remove('active'));$$('.nav-btn[data-view="pipeline"]').forEach(x=>x.classList.add('active'));
      $$('.view').forEach(v=>v.classList.remove('active'));$('#view-pipeline').classList.add('active');
      loadPipeline();
    } else{$('#hero').classList.remove('hidden');$('#app-header').classList.remove('hidden');}
    loadFollowing();loadMySpots().then(showMySpots);updateReportFab();
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
      const name=escapeHtml(s.name||s.region||'Unknown');
      return`<div class="spot-result" data-crew-id="${s.id}">
        <div class="spot-result-icon">${`<img src="${safeUrl(s.cover_image_url||defaultCover(s.id))}" style="width:36px;height:36px;border-radius:8px;object-fit:cover">`}</div>
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

let currentSurferTab='spot';
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
    crewSearch.classList.add('hidden');
    if(!currentSpot){$('#surfers-list').innerHTML='<div class="empty-state"><p>Select a spot to see its surfers.</p><button class="btn-select-spot" onclick="window.goToSpotPicker()">Select a spot</button></div>';desc.textContent='';return;}
    params=`?spot_id=${currentSpot.id}`;
    desc.textContent='Members of this crew. Follow to see their reports & analysis.';
  }
  try{const users=await(await fetch(API_BASE+'/api/users'+params)).json();const list=$('#surfers-list');
  // "This Crew" with only you in it -> invite CTA (highest-intent moment).
  const isThisCrew=params.includes('spot_id=');
  const onlyMe=!users.length||users.every(u=>u.pubkey===currentUser?.pubkey);
  if(isThisCrew&&onlyMe&&currentSpot){list.innerHTML=`<div class="empty-state empty-invite"><div class="empty-invite-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg></div><p class="empty-invite-title">Just you in this crew so far</p><p>Invite the people you actually surf ${escapeHtml(currentSpot.name)} with.</p><button class="btn-select-spot" onclick="window.inviteToCrew()">Invite your crew</button></div>`;return;}
  if(!users.length){list.innerHTML='<div class="empty-state"><p>No surfers found.</p></div>';return;}
  list.innerHTML=users.map(u=>{const me=currentUser?.pubkey===u.pubkey;const fol=followingSet.has(u.pubkey);let btn;if(me)btn='<button class="btn-follow is-you" disabled>You</button>';else if(!currentUser)btn='';else if(fol)btn=`<button class="btn-follow following" onclick="toggleFollow('${u.pubkey}')">Following</button>`;else btn=`<button class="btn-follow" onclick="toggleFollow('${u.pubkey}')">Follow</button>`;
  const isAdmin=currentSpot?.members?.some(m=>m.pubkey===currentUser?.pubkey&&m.role==='admin');
  const adminBtn=(!me&&isAdmin&&u.role!=='admin'&&currentSpot)?`<button class="btn-outline btn-xs" style="margin-left:0.3rem" onclick="event.stopPropagation();makeAdmin('${currentSpot.id}','${u.pubkey}')">Make Admin</button>`:'';
  return`<div class="surfer-card"><a href="${primalLink(u.pubkey)}" target="_blank" rel="noopener" class="surfer-profile-link" onclick="event.stopPropagation()">${u.avatar_path?`<img src="${safeUrl(u.avatar_path)}" class="surfer-av${ringCls(u)}" onerror="__avErr(this,'${avInitial(u.display_name)}')">`:`<div class="surfer-av-placeholder${ringCls(u)}">${avInitial(u.display_name)}</div>`}</a><div class="surfer-info"><a href="${primalLink(u.pubkey)}" target="_blank" rel="noopener" class="surfer-name-link">${escapeHtml(u.display_name||'Anon')}</a><div class="surfer-meta">${u.session_count} session${u.session_count!==1?'s':''}${u.total_barrels>0?` · 🤿 ${u.total_barrels} tube${u.total_barrels>1?'s':''}`:''}${u.role==='admin'?' · admin':''}</div></div><div class="surfer-actions">${btn}${adminBtn}</div></div>`;}).join('');}catch{}}

// ===== CONDITIONS =====
$('#session_date').value=new Date().toISOString().split('T')[0];
async function fetchConditions(){const d=$('#session_date').value,t=$('#time_of_day').value,p=$('#conditions-preview');
  if(!currentSpot){p.innerHTML='<div class="empty-state"><p>Join or create a crew first to log sessions.</p><p class="muted">Go to the Search tab to find a crew.</p></div>';$('#submit-btn').disabled=true;$('#submit-btn').textContent='Join a Crew First';return;}
  p.innerHTML='<div class="cond-loading">Fetching conditions...</div>';
  const spotParam=currentSpot?`&spot_id=${currentSpot.id}`:'';
  const condHeaders=currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{};
  try{const c=await(await fetch(`${API_BASE}/api/conditions?date=${d}&time_of_day=${t}${spotParam}`,{headers:condHeaders})).json();if(!c.surf_height_min_ft&&!c.swells?.length){p.innerHTML='<div class="cond-loading">No forecast data.</div>';return;}
  const sw=(c.swells||[]).map(s=>`<div class="swell-item"><span class="swell-compass">${s.direction_compass}</span><span class="swell-detail">${s.height_ft}ft ${s.period_s}s</span><span class="swell-meta">${s.direction_deg}°</span></div>`).join('');
  p.innerHTML=`<div class="cond-grid"><div class="cond-block"><h4>Surf</h4><div class="cond-val">${c.surf_height_min_ft||'?'}-${c.surf_height_max_ft||'?'} ft</div></div><div class="cond-block"><h4>Swells (${c.swells?.length||0})</h4><div class="swells-list">${sw||'-'}</div></div><div class="cond-block"><h4>Wind</h4><div class="cond-val">${c.wind_speed_mph||0} mph</div><div class="cond-sub">${c.wind_type||''} ${c.wind_gust_mph?'gusts '+c.wind_gust_mph:''}</div></div><div class="cond-block"><h4>Tide</h4><div class="cond-val">${c.tide_height_ft||'?'} ft</div></div></div>`;}catch{p.innerHTML='<div class="cond-loading">Could not fetch.</div>';}}
$('#session_date').addEventListener('change',fetchConditions);$('#time_of_day').addEventListener('change',fetchConditions);

// ===== TABS =====
$$('.shape-tab').forEach(btn=>{btn.addEventListener('click',()=>{const g=btn.dataset.group;if(g==='session_type'){$$('.shape-tab[data-group="session_type"]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');$('#session_type').value=btn.dataset.val;}else{btn.classList.toggle('active');$('#wave_shape').value=[...$$('.shape-tab[data-shape].active')].map(b=>b.dataset.shape).join(',');}});});
document.querySelector('.shape-tab[data-val="surfed"]')?.classList.add('active');

// ===== RATING =====
const rs=$('#rating'),rd=$('#rating-display');

function hapticTick(style){
  try{
    // iOS Capacitor: use native haptics via the bridge
    if(IS_CAPACITOR&&window.Capacitor?.Plugins?.Haptics){
      window.Capacitor.Plugins.Haptics.impact({style:style||'LIGHT'});return;
    }
    // Android/web fallback
    if(navigator.vibrate)navigator.vibrate(style==='HEAVY'?[30,20,30]:style==='MEDIUM'?[15]:[8]);
  }catch{}
}

let lastRatingVal=5;
function updateRating(){
  const v=+rs.value;
  const bc=v<=3?'#ccc':v<=5?'#999':v<=7?'#333':'#000';
  if(v>=8){rd.style.background='#000';rd.style.color='#fff';}else{rd.style.background='#fff';rd.style.color='#000';}
  rd.style.borderColor=bc;
  const scale=0.9+v*0.04;rd.style.transform=`scale(${scale})`;
  rd.style.boxShadow=v>=8?'0 0 16px rgba(0,0,0,0.15)':'none';
  const iv=Math.round(v);
  if(iv!==lastRatingVal){
    rd.classList.remove('pulse');void rd.offsetWidth;rd.classList.add('pulse');
    hapticTick(v>=8?'HEAVY':v>=5?'MEDIUM':'LIGHT');
    lastRatingVal=iv;
  }
  rd.textContent=v.toFixed(1);
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
let html=`<strong>${sd.spot_name} ${sd.session_type==='observed'?'check':'session'}</strong>`;if(sh)html+=` · ${sh}`;html+=` · ${sd.rating}/10 ${emoji}`;if(sw)html+=`<div class="share-stats">Swell: ${sw}</div>`;if(sd.video_url)html+=`<video src="${safeUrl(sd.video_url)}" controls muted preload="metadata"></video>`;
$('#share-preview').innerHTML=html;$('#share-text').value=sd.notes||`${sd.spot_name} was ${sd.rating>=8?'firing':sd.rating>=6?'fun':sd.rating>=4?'decent':'flat'} today! ${sh} ${emoji}`;$('#share-modal').classList.remove('hidden');}
function closeShareAndGoToFeed(){$('#share-modal').classList.add('hidden');$$('.nav-btn').forEach(x=>x.classList.remove('active'));$$('.nav-btn[data-view="history"]').forEach(x=>x.classList.add('active'));$$('.view').forEach(v=>v.classList.remove('active'));$('#view-history').classList.add('active');loadFeed();}
function getShareText(){
  let t=$('#share-text').value.trim();
  if(pendingShareData?.video_url&&!t.includes(pendingShareData.video_url))t+='\n'+pendingShareData.video_url;
  return t;
}
function getShareUrl(){return pendingShareData?.sessionUrl||'https://swellnotes.com';}
$('#share-skip-btn').addEventListener('click',closeShareAndGoToFeed);
$('#share-modal .modal-backdrop').addEventListener('click',closeShareAndGoToFeed);
$('#share-modal .modal-close').addEventListener('click',closeShareAndGoToFeed);
$('#share-whatsapp-btn').addEventListener('click',()=>{const t=getShareText()+'\n'+getShareUrl();window.open('https://wa.me/?text='+encodeURIComponent(t),'_blank');closeShareAndGoToFeed();});
$('#share-messages-btn').addEventListener('click',()=>{const t=getShareText()+'\n'+getShareUrl();window.open('sms:&body='+encodeURIComponent(t));closeShareAndGoToFeed();});
$('#share-native-btn').addEventListener('click',async()=>{const t=getShareText();try{await navigator.share({title:pendingShareData?.spot_name+' session',text:t,url:getShareUrl()});}catch{}closeShareAndGoToFeed();});
$('#share-post-btn').addEventListener('click',async()=>{if(!pendingShareData)return;try{$('#share-post-btn').disabled=true;$('#share-post-btn').textContent='Posting...';const sd=pendingShareData;const c=sd.conditions;const sw=(c.swells||[]).map(s=>`${s.height_ft}ft ${s.period_s}s ${s.direction_compass} ${s.direction_deg}°`).join(', ');const sh=c.surf_height_min_ft&&c.surf_height_max_ft?`${c.surf_height_min_ft}-${c.surf_height_max_ft}ft`:'';let content=$('#share-text').value.trim();if(!content.includes(sd.spot_name))content=`🌊 ${sd.spot_name} · ${sh} · ${sd.rating}/10\n\n${content}`;if(sw&&!content.includes(sw))content+=`\n\nSwell: ${sw}`;if(c.wind_type)content+=`\nWind: ${c.wind_speed_mph}mph ${c.wind_type}`;const tags=[['t','surf'],['t',sd.spot_name.toLowerCase().replace(/\s+/g,'')],['t','surfing']];
  if(sd.video_url){content+=`\n\n${sd.video_url}`;tags.push(['imeta',`url ${sd.video_url}`,`m video/mp4`]);tags.push(['r',sd.video_url]);}
  let ev;
  if(currentUser?.secretKey){ev=finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags,content},hexToBytes(currentUser.secretKey));}
  else if(currentUser?.nip46){ev=await nip46Sign({kind:1,created_at:Math.floor(Date.now()/1000),tags,content,pubkey:currentUser.pubkey});}
  else{toast('Cannot sign, log in first','error');return;}
  for(const u of RELAYS){try{const r=await Relay.connect(u);await r.publish(ev);r.close();}catch{}}toast('Shared!');closeShareAndGoToFeed();}catch(err){console.error('Share error:',err);toast('Share failed','error');}finally{$('#share-post-btn').disabled=false;$('#share-post-btn').textContent='Share';}});

// ===== MULTI-SPOT FEED =====
let spotFollowingSet=new Set();

let feedGroups=[];
let feedFilter=localStorage.getItem('swellnotes_feed_filter')||'__all'; // remembered Reports spot filter
// Unified reports feed, most recent reports across your crews, filterable by spot
async function loadFeed(){
  const feedEl=$('#report-feed');if(!feedEl)return;
  if(!currentUser){feedEl.innerHTML='<div class="empty-state"><p>Log in to see reports.</p></div>';return;}
  feedEl.innerHTML='<div class="cond-loading">Loading...</div>';
  try{
    await loadMySpots();
    feedGroups=await(await fetch(`${API_BASE}/api/feed?limit=50`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();
    const filter=$('#feed-filter');
    if(filter){
      const prev=filter.value;
      const spots=mySpots.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''));
      filter.innerHTML='<option value="__all">All spots</option>'+spots.map(s=>`<option value="${s.id}">${escapeHtml(s.name||'Spot')}</option>`).join('');
      filter.style.display=spots.length>1?'':'none';
      if(prev&&[...filter.options].some(o=>o.value===prev))filter.value=prev;
    }
    renderReportFeed();
  }catch{feedEl.innerHTML='<div class="empty-state">Error loading reports</div>';}
}
function renderReportFeed(){
  const feedEl=$('#report-feed');if(!feedEl)return;
  const sel=feedFilter;
  const multi=(mySpots?.length||0)>1;
  const items=[];
  for(const g of (feedGroups||[])){
    if(sel!=='__all'&&g.spot.id!==sel)continue;
    for(const s of g.sessions)items.push({...s,__spot:g.spot.name});
  }
  items.sort((a,b)=>(b.session_date||'').localeCompare(a.session_date||'')||((b.created_at||0)-(a.created_at||0)));
  const welcome=justJoinedSpot?`<div class="welcome-banner" id="welcome-banner"><span class="wb-em">🤙</span><div class="wb-body"><b>Welcome to ${escapeHtml(justJoinedSpot.name)}</b><span>${justJoinedSpot.members?justJoinedSpot.members+' surfer'+(justJoinedSpot.members!==1?'s':'')+' · ':''}Tap + to post your first report</span></div><button class="wb-close" onclick="window.dismissWelcome()" aria-label="Dismiss">&times;</button></div>`:'';
  if(!items.length){feedEl.innerHTML=(!mySpots||!mySpots.length)
    ?'<div class="empty-state"><p>No spots yet.</p><p class="muted">Select a spot to start logging and see reports.</p><button class="btn-select-spot" onclick="window.goToSpotPicker()">Select a spot</button></div>'
    :welcome+'<div class="empty-state"><p>No reports yet.</p><p class="muted">Tap the + button to log one.</p></div>';return;}
  feedEl.innerHTML=welcome+items.map(s=>renderSessionCard(s,multi&&sel==='__all')).join('');
  feedEl.querySelectorAll('.pcard').forEach(c=>c.addEventListener('click',()=>openSession(c.dataset.id)));
}
$('#feed-filter')?.addEventListener('change',renderReportFeed);

// ===== FORECAST TAB =====
function fcLocalHour(t,off){return new Date((t+off*3600)*1000).getUTCHours();}
function fcHourLabel(h){if(h===0)return'12a';if(h===12)return'12p';return h<12?h+'a':(h-12)+'p';}
function fcTimeLabel(t,off){const D=new Date((t+off*3600)*1000);let h=D.getUTCHours();const m=D.getUTCMinutes();const ap=h<12?'am':'pm';h=h%12||12;return `${h}:${String(m).padStart(2,'0')}${ap}`;}
const FC_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fcDayWindow(off,dayIndex=0){const nowU=Math.floor(Date.now()/1000);const local=nowU+off*3600;const todayStartLocal=Math.floor(local/86400)*86400;const startLocal=todayStartLocal+dayIndex*86400;return{start:startLocal-off*3600,end:startLocal-off*3600+86400,nowU};}
function fcScale(pts,start,w,h){const vs=pts.map(p=>p.v);let lo=Math.min(...vs),hi=Math.max(...vs);if(hi===lo){hi+=1;lo-=1;}const pad=(hi-lo)*0.18;lo-=pad;hi+=pad;const X=t=>(((t-start)/86400)*w);const Y=v=>h-((v-lo)/(hi-lo))*h;return{X,Y,lo,hi};}
function fcCurve(pts,start,w,h){const s=fcScale(pts,start,w,h);const line=pts.map((p,i)=>`${i?'L':'M'}${s.X(p.t).toFixed(1)},${s.Y(p.v).toFixed(1)}`).join(' ');const area=`${line} L${s.X(pts[pts.length-1].t).toFixed(1)},${h} L${s.X(pts[0].t).toFixed(1)},${h} Z`;return{...s,line,area};}
function fcNearest(arr,t){let best=null,bd=1/0;for(const a of arr){const d=Math.abs(a.t-t);if(d<bd){bd=d;best=a;}}return best;}
let fcData=null,fcDay=0;
async function loadForecast(){
  const el=$('#forecast-body');if(!el)return;
  if(!currentSpot){el.innerHTML='<div class="empty-state"><p>Select a spot to see its forecast.</p><button class="btn-select-spot" onclick="window.goToSpotPicker()">Select a spot</button></div>';return;}
  el.innerHTML='<div class="cond-loading">Loading forecast…</div>';
  try{
    const headers=currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{};
    const f=await(await fetch(`${API_BASE}/api/forecast?spot_id=${currentSpot.id}`,{headers})).json();
    if(f.error||!f.wave){el.innerHTML='<div class="empty-state"><p>Forecast unavailable.</p></div>';return;}
    fcData=f;fcDay=0;renderForecastDay();
  }catch{el.innerHTML='<div class="empty-state"><p>Could not load forecast.</p></div>';}
}
window.fcSelectDay=i=>{fcDay=i;renderForecastDay();window.scrollTo(0,0);};
let fcCur=null;
function fcTideAt(t){const a=fcCur?.tide||[];if(!a.length)return null;if(t<=a[0].t)return a[0].h;if(t>=a[a.length-1].t)return a[a.length-1].h;for(let i=1;i<a.length;i++){if(a[i].t>=t){const p=a[i-1],q=a[i];return p.h+(q.h-p.h)*((t-p.t)/(q.t-p.t));}}return a[a.length-1].h;}
function fcScrubUpdate(t){
  if(!fcCur)return;
  const {off,start,end,W,wave,en}=fcCur;
  t=Math.max(start,Math.min(end-1,t));fcCur.scrubT=t;
  const xv=((t-start)/86400)*W;
  const w=fcNearest(wave,t),eW=fcNearest(en,t),tideH=fcTideAt(t),tl=fcTimeLabel(t,off);
  const set=(id,v)=>{const el=$('#'+id);if(el!=null&&v!=null)el.textContent=v;};
  if(w)set('fc-head-big',`${w.min!=null?w.min+'-':''}${w.max}ft`);
  set('fc-head-sub',`${tl} · ${currentSpot?.name||''}`);
  set('fc-scrub-time',tl);
  if(tideH!=null)set('fc-tide-val',`${tideH.toFixed(1)}ft`);
  if(eW)set('fc-energy-val',`${Math.round(eW.power)} kJ`);
  const sb=$('#fc-swell-body');if(sb)sb.innerHTML=(w?.swells||[]).map(s=>`<div class="fc-swell-row"><span class="fc-swell-arrow" style="transform:rotate(${Math.round(s.dir+180)}deg)">↑</span><span class="fc-swell-main">${s.cdir} · ${s.p}s</span><span class="fc-swell-sub">${s.dir}° · ${s.h}ft</span></div>`).join('')||'<div class="muted" style="padding:.3rem 0">No swell</div>';
  ['fc-tide-cursor','fc-energy-cursor'].forEach(id=>{const ln=$('#'+id);if(ln){ln.setAttribute('x1',xv.toFixed(1));ln.setAttribute('x2',xv.toFixed(1));}});
}
function fcBindScrub(){
  const svg=$('#fc-tide-svg');if(!svg||!fcCur)return;
  const at=clientX=>{const r=svg.getBoundingClientRect();let frac=(clientX-r.left)/r.width;frac=Math.max(0,Math.min(1,frac));fcScrubUpdate(fcCur.start+frac*86400);};
  let drag=false;
  svg.addEventListener('pointerdown',e=>{drag=true;try{svg.setPointerCapture(e.pointerId);}catch{}at(e.clientX);e.preventDefault();});
  svg.addEventListener('pointermove',e=>{if(drag)at(e.clientX);});
  const up=()=>{drag=false;};svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',up);
}
function renderForecastDay(){
  const el=$('#forecast-body');const f=fcData;if(!el||!f)return;
  const off=f.utcOffset??-6;const {start,end,nowU}=fcDayWindow(off,fcDay);const isToday=fcDay===0;
  const W=320,H=110;
  const tabs=[0,1,2].map(d=>{const w=fcDayWindow(off,d);const lbl=d===0?'Today':FC_DOW[new Date((w.start+off*3600)*1000).getUTCDay()];return `<button class="fc-day ${d===fcDay?'on':''}" onclick="fcSelectDay(${d})">${lbl}</button>`;}).join('');
  const wave=f.wave.filter(w=>w.t>=start&&w.t<end&&w.max!=null);
  const en=f.wave.filter(w=>w.t>=start&&w.t<end&&w.power!=null);
  if(!wave.length){el.innerHTML=`<div class="fc-days">${tabs}</div><div class="empty-state"><p>No forecast data for this day yet.</p><p class="muted">Check back soon, forecasts refresh every couple of hours.</p></div>`;fcCur=null;return;}
  const maxSurf=Math.max(1,...wave.map(w=>w.max));
  const bars=wave.map(w=>{const pct=Math.max(6,Math.round((w.max/maxSurf)*100));const sw=(w.swells||[])[0];const swHTML=sw?`<span class="fc-sw"><span class="fc-sw-arrow" style="transform:rotate(${Math.round(sw.dir+180)}deg)">↑</span>${sw.p}s</span>`:'<span class="fc-sw">-</span>';return`<div class="fc-col"><div class="fc-track"><div class="fc-bar" style="height:${pct}%"></div></div><div class="fc-num">${w.min!=null?w.min+'-':''}${w.max}</div>${swHTML}<div class="fc-time">${fcHourLabel(fcLocalHour(w.t,off))}</div></div>`;}).join('');
  const axis=`<div class="fc-axis">${[start,start+21600,start+43200,start+64800,end-1].map(t=>`<span>${fcHourLabel(fcLocalHour(t,off))}</span>`).join('')}</div>`;
  // Tide chart (scrubber)
  const tide=f.tides.filter(t=>t.t>=start-7200&&t.t<end+7200);
  let tideHTML='';
  if(tide.length>1){
    const c=fcCurve(tide.map(t=>({t:t.t,v:t.h})),start,W,H);
    const ext=tide.filter(t=>(t.type==='HIGH'||t.type==='LOW')&&t.t>=start&&t.t<end);
    const dots=ext.map(t=>`<circle cx="${c.X(t.t).toFixed(1)}" cy="${c.Y(t.h).toFixed(1)}" r="3" fill="#1a4a7a"/><text x="${c.X(t.t).toFixed(1)}" y="${(c.Y(t.h)-8).toFixed(1)}" class="fc-svg-lbl" text-anchor="middle">${t.h}ft</text>`).join('');
    tideHTML=`<div class="fc-card"><div class="fc-card-head"><span class="fc-card-label">Tide · drag to scrub</span><span class="fc-card-now" id="fc-tide-val"></span></div>
      <svg id="fc-tide-svg" viewBox="0 0 ${W} ${H+18}" class="fc-svg fc-scrub" preserveAspectRatio="none"><path d="${c.area}" fill="rgba(26,74,122,0.12)"/><path d="${c.line}" fill="none" stroke="#1a4a7a" stroke-width="2"/><line id="fc-tide-cursor" x1="0" y1="0" x2="0" y2="${H}" class="fc-cursor"/>${dots}</svg>${axis}</div>`;
  }
  // Energy chart
  let enHTML='';
  if(en.length>1){
    const c=fcCurve(en.map(w=>({t:w.t,v:w.power})),start,W,H);
    enHTML=`<div class="fc-card"><div class="fc-card-head"><span class="fc-card-label">Swell energy</span><span class="fc-card-now" id="fc-energy-val"></span></div>
      <svg viewBox="0 0 ${W} ${H}" class="fc-svg" preserveAspectRatio="none"><path d="${c.area}" fill="rgba(56,189,248,0.14)"/><path d="${c.line}" fill="none" stroke="var(--cyan)" stroke-width="2"/><line id="fc-energy-cursor" x1="0" y1="0" x2="0" y2="${H}" class="fc-cursor"/></svg>${axis}</div>`;
  }
  el.innerHTML=`<div class="fc-days">${tabs}</div>
    <div class="fc-head"><div class="fc-head-big" id="fc-head-big">-</div><div class="fc-head-sub" id="fc-head-sub"></div></div>
    <div class="fc-card"><div class="fc-card-label">Surf height</div><div class="fc-bars">${bars||'<span class="muted">No data</span>'}</div></div>
    <div class="fc-card"><div class="fc-card-head"><span class="fc-card-label">Swell</span><span class="fc-card-now" id="fc-scrub-time"></span></div><div id="fc-swell-body"></div></div>
    ${tideHTML}${enHTML}`;
  fcCur={off,start,end,W,wave,en,tide:tide.map(t=>({t:t.t,h:t.h}))};
  fcBindScrub();
  fcScrubUpdate(isToday?nowU:start+12*3600);
}

function smallAvatar(u,cls){return u.avatar_path?`<img src="${safeUrl(u.avatar_path)}" class="${cls}" alt="" onerror="__avErr(this,'${avInitial(u.display_name)}')">`:`<div class="${cls}-ph">${avInitial(u.display_name)}</div>`;}
function renderInlineComment(c){return`<div class="cmt">${smallAvatar(c,'cmt-av')}<div class="cmt-body"><b>${escapeHtml(c.display_name||'Anon')}</b>${escapeHtml(c.body)}</div></div>`;}
function renderSessionCard(s,showSpot){
  const d=new Date(s.session_date+'T12:00:00');
  const dateStr=d.toLocaleDateString('en',{month:'short',day:'numeric'});
  const tags=[];
  if(s.surf_height_min_ft!=null)tags.push(`<span class="tag tag-height">${s.surf_height_min_ft}-${s.surf_height_max_ft}ft</span>`);
  if(s.session_type==='surfed')tags.push('<span class="tag tag-shape">surfed</span>');
  else if(s.session_type==='observed')tags.push('<span class="tag tag-observed">observed</span>');
  if(s.wave_shape)s.wave_shape.split(',').filter(Boolean).forEach(sh=>tags.push(`<span class="tag tag-shape">${escapeHtml(sh.trim())}</span>`));
  if(s.barrels>0)tags.push(`<span class="tag tag-barrel">🤿 ${s.barrels} tube${s.barrels>1?'s':''}</span>`);
  if(s.voice_memo_path)tags.push('<span class="tag tag-voice">🎙</span>');
  const capText=(s.notes||s.voice_transcript||'').trim();
  const cap=capText?`<div class="pcard-caption">${escapeHtml(capText)}</div>`:'';
  const av=s.avatar_path?`<img src="${safeUrl(s.avatar_path)}" class="pcard-av${ringCls(s)}" alt="" onerror="__avErr(this,'${avInitial(s.display_name)}')">`:`<div class="pcard-av-ph${ringCls(s)}">${avInitial(s.display_name)}</div>`;
  const spotChip=showSpot&&s.__spot?`<span class="pcard-spot">${escapeHtml(s.__spot)}</span>`:'';
  const imgs=(s.photos&&s.photos.length)?s.photos:(s.photo_path?[s.photo_path]:[]);
  let media='';
  if(s.video_path)media=`<div class="pcard-media" onclick="event.stopPropagation()"><video src="${s.video_path}#t=0.1" preload="metadata" muted playsinline onloadedmetadata="snVideoMeta(this)"></video><button class="pcard-play" onclick="snPlayVideo(this)" aria-label="Play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button></div>`;
  else if(imgs.length===1)media=`<div class="pcard-media"><img src="${safeUrl(imgs[0])}" alt="" onload="snImgMeta(this)"></div>`;
  else if(imgs.length>1)media=`<div class="pcard-gallery g${imgs.length}">${imgs.map(p=>`<img src="${safeUrl(p)}" alt="">`).join('')}</div>`;
  const voice=s.voice_memo_path?`<audio class="pcard-audio" controls preload="none" src="${safeUrl(s.voice_memo_path)}" onclick="event.stopPropagation()"></audio>`:'';
  const score=s.rating?`<div class="rbadge ${getRatingClass(s.rating)}">${fmtRating(s.rating)}</div>`:'<div class="rbadge">-</div>';
  const cmts=(s.comments||[]).map(renderInlineComment).join('');
  const more=(s.comment_count||0)>(s.comments||[]).length?`<button class="cmt-more" onclick="event.stopPropagation();openSession(${s.id})">View all ${s.comment_count} comments</button>`:'';
  const composer=currentUser?`<div class="cmt-compose" onclick="event.stopPropagation()">${smallAvatar(currentUser,'cmt-av')}<input class="cmt-input" type="text" placeholder="Add a comment…" onkeydown="if(event.key==='Enter')postInlineComment(${s.id},this)"><button class="cmt-send" onclick="postInlineComment(${s.id},this)">Post</button></div>`:'';
  return`<div class="pcard" data-id="${s.id}">
    <div class="pcard-top"><a class="pcard-who" href="${primalLink(s.pubkey)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${av}<span class="pcard-id"><span class="pcard-name">${escapeHtml(s.display_name||'Anon')}</span><span class="pcard-time">· ${formatTOD(s.time_of_day)}</span></span></a>${spotChip}</div>
    ${cap}
    ${tags.length?`<div class="pcard-tags">${tags.join('')}</div>`:''}
    ${media}${voice}
    <div class="pcard-foot"><span class="foot-date">${dateStr}</span>${score}</div>
    <div class="pcard-comments">${cmts}${more}${composer}</div>
  </div>`;
}
window.snVideoMeta=function(v){const w=v.videoWidth,h=v.videoHeight;if(w&&h)v.closest('.pcard-media').classList.add(h>w?'portrait':'landscape');};
window.snImgMeta=function(img){const w=img.naturalWidth,h=img.naturalHeight;if(w&&h)img.closest('.pcard-media').classList.add(h>w?'portrait':'landscape');};
window.snPlayVideo=function(btn){const m=btn.closest('.pcard-media');const v=m.querySelector('video');v.controls=true;v.muted=false;v.play();btn.remove();};
window.postInlineComment=async function(id,el){
  const card=el.closest('.pcard');const input=card.querySelector('.cmt-input');const body=(input.value||'').trim();
  if(!body||!currentUser)return;
  input.value='';input.disabled=true;
  try{
    await fetch(`${API_BASE}/api/sessions/${id}/comments`,{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({body})});
    card.querySelector('.cmt-compose').insertAdjacentHTML('beforebegin',renderInlineComment({display_name:currentUser.display_name,avatar_path:currentUser.avatar_path,body}));
  }catch{toast('Comment failed','error');}
  finally{input.disabled=false;}
};

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
      const displayName=escapeHtml(s.name||s.region||'Unknown');
      let btn;
      if(isMember)btn='<button class="btn-follow is-you" disabled>Member</button>';
      else if(!s.is_private&&currentUser)btn=`<button class="btn-follow" onclick="joinPublicCrew('${s.id}')">Join</button>`;
      else if(s.has_pending_request)btn='<button class="btn-follow" disabled>Requested</button>';
      else if(s.is_private&&currentUser)btn=`<button class="btn-follow" onclick="openJoinRequest('${s.id}','${escapeHtml(s.name||s.region||'')}')">Request</button>`;
      else if(!currentUser)btn='';
      else if(isFollowing)btn=`<button class="btn-follow following" onclick="toggleSpotFollow('${s.id}')">Following</button>`;
      else btn=`<button class="btn-follow" onclick="toggleSpotFollow('${s.id}')">Follow</button>`;
      return`<div class="browse-spot-card">
        ${s.cover_image_url?`<img src="${safeUrl(s.cover_image_url)}" class="browse-spot-img" alt="">`:`<img src="${defaultCover(s.id)}" class="browse-spot-img" alt="">`}
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

// Kept as an alias, the unified reports feed replaced the per-spot session list
async function loadSessions(){return loadFeed();}

// ===== DETAIL =====
async function openSession(id){try{const{session:s,comments}=await(await fetch(`${API_BASE}/api/sessions/${id}`)).json();const d=new Date(s.session_date+'T12:00:00');const ds=d.toLocaleDateString('en',{weekday:'long',year:'numeric',month:'long',day:'numeric'});const sw=JSON.parse(s.swells_json||'[]');const swH=sw.map((x,i)=>`<div class="detail-block"><h4>${i?'Secondary':'Primary'} Swell</h4><p>${x.height_ft}ft ${x.period_s}s ${x.direction_compass} ${x.direction_deg}° <small style="opacity:.5">(${x.impact}%)</small></p></div>`).join('');
// Check if user can delete (own session or spot admin)
const canDelete=currentUser&&(s.pubkey===currentUser.pubkey||(currentSpot?.members?.some(m=>m.pubkey===currentUser.pubkey&&m.role==='admin')));
$('#session-detail').innerHTML=`<h2>${ds}</h2><p class="muted"><a href="${primalLink(s.pubkey)}" target="_blank" rel="noopener" class="user-link-inline">${escapeHtml(s.display_name||'Anon')}</a> · ${formatTOD(s.time_of_day)}</p><div style="margin:.75rem 0"><div class="rbadge ${getRatingClass(s.rating)}" style="width:52px;height:52px;font-size:1.2rem;display:inline-flex">${fmtRating(s.rating)}/10</div></div><div class="detail-grid"><div class="detail-block"><h4>Surf</h4><p>${s.surf_height_min_ft||'?'}-${s.surf_height_max_ft||'?'} ft</p></div>${swH}<div class="detail-block"><h4>Wind</h4><p>${s.wind_speed_mph||'?'} mph ${s.wind_type?'('+s.wind_type+')':''}</p></div><div class="detail-block"><h4>Tide</h4><p>${s.tide_height_ft||'?'} ft</p></div>${s.wave_shape?`<div class="detail-block"><h4>Shape</h4><p style="text-transform:capitalize">${escapeHtml(s.wave_shape.split(',').map(x=>x.trim()).join(', '))}</p></div>`:''}${s.barrels>0?`<div class="detail-block"><h4>Tubes</h4><p>🤿 ${s.barrels}</p></div>`:''}</div>${((s.photos&&s.photos.length)?s.photos:(s.photo_path?[s.photo_path]:[])).map(p=>`<div class="detail-photo"><img src="${safeUrl(p)}" alt=""></div>`).join('')}${s.video_path?`<div class="detail-video"><video controls src="${safeUrl(s.video_path)}" preload="metadata"></video></div>`:''}${s.voice_memo_path?`<div class="detail-voice"><audio controls src="${safeUrl(s.voice_memo_path)}" style="width:100%;height:36px"></audio>${s.voice_transcript?`<div class="detail-transcript">"${escapeHtml(s.voice_transcript)}"</div>`:''}</div>`:''}${s.notes?`<div class="detail-notes">${escapeHtml(s.notes)}</div>`:''}${canDelete?`<button class="btn-delete-session" onclick="deleteSession(${s.id})">Delete Log</button>`:''}${currentUser&&s.pubkey!==currentUser.pubkey?`<div class="detail-actions"><button class="btn-report" onclick="reportContent('session','${s.id}')">Report</button><button class="btn-report" onclick="blockUser('${s.pubkey}')">Block User</button></div>`:''}`;
$('#comments-list').innerHTML=comments.length?comments.map(c=>`<div class="comment"><div class="comment-meta"><a href="${primalLink(c.pubkey)}" target="_blank" rel="noopener" class="user-link-inline">${escapeHtml(c.display_name||'Anon')}</a> · ${new Date(c.created_at*1000).toLocaleDateString()}${currentUser&&c.pubkey!==currentUser.pubkey?` · <button class="btn-report-inline" onclick="event.stopPropagation();reportContent('comment','${c.id}')">Report</button>`:''}</div><div class="comment-body">${escapeHtml(c.body)}</div></div>`).join(''):'<p class="muted" style="font-size:.82rem">No comments yet</p>';
$('#comment-form').onsubmit=async e=>{e.preventDefault();if(!currentUser)return;const b=$('#comment-body').value.trim();if(!b)return;await fetch(`${API_BASE}/api/sessions/${id}/comments`,{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({body:b})});$('#comment-body').value='';openSession(id);};
$('#session-modal').classList.remove('hidden');}catch{toast('Error','error');}}
window.openSession=openSession;
window.openLoginModal=openLoginModal;

async function deleteSession(id){
  if(!confirm('Delete this log? This cannot be undone.'))return;
  try{
    const res=await fetch(`${API_BASE}/api/sessions/${id}`,{method:'DELETE',headers:{'X-Nostr-Pubkey':currentUser.pubkey}});
    if(res.ok){toast('Log deleted');$('#session-modal').classList.add('hidden');loadFeed();}
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
$('#search-btn').addEventListener('click',runSearch);$('#search-clear').addEventListener('click',()=>{['search-dir-min','search-dir-max','search-height-min','search-height-max','search-period-min','search-period-max','search-rating-min','search-rating-max','search-date-from','search-date-to'].forEach(id=>$(`#${id}`).value='');$('#search-results').innerHTML='';});
async function runSearch(){const p=new URLSearchParams();if(currentUser)p.set('pubkey',currentUser.pubkey);if(currentSpot)p.set('spot_id',currentSpot.id);const fields={dir_min:'search-dir-min',dir_max:'search-dir-max',height_min:'search-height-min',height_max:'search-height-max',period_min:'search-period-min',period_max:'search-period-max',rating_min:'search-rating-min',rating_max:'search-rating-max',date_from:'search-date-from',date_to:'search-date-to'};Object.entries(fields).forEach(([k,id])=>{const v=$(`#${id}`).value;if(v)p.set(k,v);});
try{const{sessions,summary}=await(await fetch(`${API_BASE}/api/search?${p}`)).json();const sr=$('#search-results');if(!sessions.length){sr.innerHTML='<div class="empty-state"><p>No matches.</p></div>';return;}
sr.innerHTML=`<div class="search-summary"><div class="search-stat"><span class="search-stat-label">Sessions</span><span class="search-stat-value">${summary.count}</span></div><div class="search-stat"><span class="search-stat-label">Avg</span><span class="search-stat-value">${summary.avg_rating||'-'}/10</span></div><div class="search-stat"><span class="search-stat-label">Best</span><span class="search-stat-value">${summary.best_rating||'-'}</span></div><div class="search-stat"><span class="search-stat-label">Worst</span><span class="search-stat-value">${summary.worst_rating||'-'}</span></div></div><div class="search-result-list">${sessions.map(s=>{const d=new Date(s.session_date+'T12:00:00'),sw=JSON.parse(s.swells_json||'[]');return`<div class="feed-card" onclick="openSession(${s.id})"><div class="feed-date"><div class="day">${d.getDate()}</div><div class="mo">${d.toLocaleString('en',{month:'short'})}</div></div><div class="feed-body"><div class="feed-user">${avatarHTML(s.avatar_path,s.display_name,'feed-avatar',!!ringCls(s))}<span class="feed-name">${escapeHtml(s.display_name||'Anon')}</span></div><div class="feed-tags">${sw.map(x=>`<span class="tag tag-swell">${x.height_ft}ft ${x.period_s}s ${x.direction_compass}</span>`).join('')}</div></div><div class="feed-rating">${s.rating?`<div class="rbadge ${getRatingClass(s.rating)}">${s.rating}</div>`:''}</div></div>`;}).join('')}</div>`;}catch{$('#search-results').innerHTML='<div class="empty-state">Failed</div>';}}

// ===== FORECAST MATCH =====
async function loadAnalysis(){
  const el=$('#forecast-match');
  if(!currentSpot){el.innerHTML='<div class="empty-state"><p>Select a spot to see forecast matches.</p><button class="btn-select-spot" onclick="window.goToSpotPicker()">Select a spot</button></div>';return;}
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

// ===== MEMBERS MODAL =====
async function showMembers(spotId,spotName){
  $('#members-modal-title').textContent=(spotName||'Crew')+' Members';
  $('#members-modal-list').innerHTML='<div class="cond-loading">Loading...</div>';
  $('#members-modal').classList.remove('hidden');
  try{
    const users=await(await fetch(`${API_BASE}/api/users?spot_id=${spotId}`)).json();
    if(!users.length){$('#members-modal-list').innerHTML='<p class="muted">No members yet.</p>';return;}
    $('#members-modal-list').innerHTML=users.map(u=>{
      const isMe=currentUser?.pubkey===u.pubkey;
      const fol=followingSet.has(u.pubkey);
      let btn='';
      if(isMe)btn='<span class="muted" style="font-size:0.75rem">You</span>';
      else if(currentUser&&fol)btn=`<button class="btn-follow following" onclick="toggleFollow('${u.pubkey}');showMembers('${spotId}','${escapeHtml(spotName||'')}')">Following</button>`;
      else if(currentUser)btn=`<button class="btn-follow" onclick="toggleFollow('${u.pubkey}');showMembers('${spotId}','${escapeHtml(spotName||'')}')">Follow</button>`;
      return`<div class="surfer-card"><a href="${primalLink(u.pubkey)}" target="_blank" rel="noopener" class="surfer-profile-link" onclick="event.stopPropagation()">${u.avatar_path?`<img src="${safeUrl(u.avatar_path)}" class="surfer-av${ringCls(u)}" onerror="__avErr(this,'${avInitial(u.display_name)}')">`:`<div class="surfer-av-placeholder${ringCls(u)}">${avInitial(u.display_name)}</div>`}</a><div class="surfer-info"><a href="${primalLink(u.pubkey)}" target="_blank" rel="noopener" class="surfer-name-link">${escapeHtml(u.display_name||'Anon')}</a><div class="surfer-meta">${u.session_count||0} session${u.session_count!==1?'s':''}${u.total_barrels>0?` · 🤿 ${u.total_barrels}`:''}</div></div><div class="surfer-actions">${btn}</div></div>`;
    }).join('');
  }catch{$('#members-modal-list').innerHTML='<p class="muted">Error loading members.</p>';}
}
window.showMembers=showMembers;
$('#members-modal .modal-backdrop').addEventListener('click',()=>$('#members-modal').classList.add('hidden'));
$('#members-modal .modal-close').addEventListener('click',()=>$('#members-modal').classList.add('hidden'));

// ===== PRO SUBSCRIPTION =====
let proPriceStr='$2.99';  // overwritten with live StoreKit price when available
async function fetchProPrice(){
  if(StoreKit){
    try{const r=await StoreKit.getProducts();const p=r?.products?.[0];if(p?.displayPrice)proPriceStr=p.displayPrice;}catch{}
  }
  applyProPrice();
}
function applyProPrice(){const t=$('#pro-tab-price');if(t)t.textContent=proPriceStr;const m=$('#pro-price');if(m)m.textContent=`${proPriceStr}/mo`;const mp=$('#pro-modal-price');if(mp)mp.textContent=proPriceStr;}

function updateOwnAvatarRing(){const on=!!ringCls(currentUser);['#user-avatar','#settings-avatar'].forEach(sel=>{const el=$(sel);if(el)el.classList.toggle('pro-ring',on);});}

// Render the Pro tab between buy and owned states
function renderProTab(){
  const owned=$('#pro-tab-owned'),buy=$('#pro-tab-buy');
  if(!owned||!buy)return;
  owned.classList.toggle('hidden',!isPro);
  buy.classList.toggle('hidden',isPro);
  applyProPrice();
}

async function checkProStatus(){
  if(!currentUser)return;
  // Native StoreKit reports the signed entitlement; the server verifies it before granting
  if(StoreKit){
    try{const r=await StoreKit.getStatus();if(r.isPro&&r.jws)await activatePro(r.jws);}catch{}
  }
  // Server is authoritative for Pro flag (verified + unexpired) + ring preference
  try{const r=await(await fetch(API_BASE+'/api/pro/status',{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();isPro=!!r.isPro;currentUser.show_pro_ring=r.showRing??1;}catch{}
  currentUser.is_pro=isPro?1:0;saveUser(currentUser);
  updateOwnAvatarRing();renderProTab();fetchProPrice();
}

function showProModal(){$('#pro-modal').classList.remove('hidden');applyProPrice();fetchProPrice();}
function requirePro(feature){if(isPro)return true;showProModal();return false;}
// Send Apple's signed transaction to the server, which verifies before granting Pro
async function activatePro(jws){
  try{const r=await fetch(API_BASE+'/api/pro/activate',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({jws})});if(!r.ok)return false;const j=await r.json();return !!j.isPro;}catch{return false;}
}

// Reject a native call if it hangs, so the button never sits on "Processing..." forever
function withTimeout(p,ms,msg){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error(msg)),ms))]);}

// Shared purchase / restore, used by both the Pro tab and the upsell modal
async function doProPurchase(btn){
  if(!StoreKit){toast('In-app purchases are only available in the iOS app','error');return;}
  const orig=btn?btn.innerHTML:'';
  try{
    if(btn){btn.disabled=true;btn.textContent='Processing...';}
    // Confirm StoreKit can actually see the product before opening the purchase sheet.
    // A newly created subscription can take a few hours to reach the sandbox.
    let prods;
    try{prods=await withTimeout(StoreKit.getProducts(),20000,'Could not reach the App Store (timed out).');}
    catch(e){throw new Error('Could not reach the App Store: '+(e.message||e));}
    if(!prods||!prods.products||!prods.products.length){
      throw new Error('Pro isn’t available from the App Store yet. A new subscription can take a few hours to reach the sandbox, try again later.');
    }
    const r=await withTimeout(StoreKit.purchase(),120000,'The App Store didn’t respond. Try again in a bit.');
    if(r.success){
      const ok=await activatePro(r.jws);
      if(!ok){toast('Could not verify purchase','error');return;}
      isPro=true;currentUser.is_pro=1;currentUser.show_pro_ring=currentUser.show_pro_ring??1;saveUser(currentUser);
      toast('Welcome to Pro!');$('#pro-modal').classList.add('hidden');
      updateOwnAvatarRing();renderProTab();
    }else if(r.cancelled){toast('Purchase cancelled','error');}
    else if(r.pending){toast('Purchase pending, check back soon');}
  }catch(e){toast('Purchase failed: '+e.message,'error');}
  finally{if(btn){btn.disabled=false;btn.innerHTML=orig;}}
}
async function doProRestore(){
  if(!StoreKit){toast('Restore is only available in the iOS app','error');return;}
  try{
    const r=await StoreKit.restorePurchases();
    if(r.isPro&&r.jws&&await activatePro(r.jws)){
      isPro=true;currentUser.is_pro=1;saveUser(currentUser);
      toast('Pro restored!');$('#pro-modal').classList.add('hidden');
      updateOwnAvatarRing();renderProTab();
    }else{toast('No active subscription found','error');}
  }catch(e){toast('Restore failed','error');}
}

$('#pro-modal .modal-backdrop').addEventListener('click',()=>$('#pro-modal').classList.add('hidden'));
$('#pro-modal .modal-close').addEventListener('click',()=>$('#pro-modal').classList.add('hidden'));
$('#pro-purchase-btn').addEventListener('click',e=>doProPurchase(e.currentTarget));
$('#pro-restore-btn').addEventListener('click',doProRestore);
$('#pro-tab-purchase-btn')?.addEventListener('click',e=>doProPurchase(e.currentTarget));
$('#pro-tab-restore-btn')?.addEventListener('click',e=>{e.preventDefault();doProRestore();});

// Pro ring toggle (settings)
$('#settings-pro-ring')?.addEventListener('change',async e=>{
  const show=e.target.checked;
  currentUser.show_pro_ring=show?1:0;saveUser(currentUser);updateOwnAvatarRing();
  try{await fetch(API_BASE+'/api/pro/ring',{method:'POST',headers:{'Content-Type':'application/json','X-Nostr-Pubkey':currentUser.pubkey},body:JSON.stringify({show})});toast(show?'Gold ring on':'Gold ring off');}catch{toast('Could not save','error');}
});

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
      const spot=await(await fetch(`${API_BASE}/api/spots/${data.spot_id}`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}})).json();
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

// Surfline spot search in pipeline view (for creating new crews)
let pipelineSpotTimeout;
$('#pipeline-spot-search')?.addEventListener('input',e=>{
  clearTimeout(pipelineSpotTimeout);
  const q=e.target.value.trim();
  if(q.length<2){$('#pipeline-spot-results').innerHTML='';return;}
  pipelineSpotTimeout=setTimeout(async()=>{
    try{
      const results=await(await fetch(`${API_BASE}/api/spots/search?q=${encodeURIComponent(q)}`)).json();
      $('#pipeline-spot-results').innerHTML=results.map(r=>`
        <div class="spot-result" data-surfline="${r.surfline_id}" data-name="${escapeHtml(r.name)}" data-loc="${escapeHtml(r.location)}" data-lat="${r.lat}" data-lng="${r.lng}">
          <div class="spot-result-icon">🌊</div>
          <div><div class="spot-result-name">${escapeHtml(r.name)}</div><div class="spot-result-loc">${escapeHtml(r.location)}</div></div>
        </div>
      `).join('')||'<p class="muted" style="padding:1rem;text-align:center">No spots found</p>';
      $$('#pipeline-spot-results .spot-result').forEach(el=>el.addEventListener('click',()=>{
        if(!currentUser)return toast('Create an account first','error');
        // Free users: 1 crew max. Check if they already admin one.
        if(!isPro){const adminCrews=mySpots.filter(s=>s.role==='admin'||s.created_by===currentUser.pubkey);if(adminCrews.length>=1){showProModal();return;}}
        pendingSpotData={surfline_spot_id:el.dataset.surfline,name:el.dataset.name,location_text:el.dataset.loc,lat:parseFloat(el.dataset.lat),lng:parseFloat(el.dataset.lng)};
        $('#create-spot-name').textContent=`Forecasts from ${el.dataset.name} · kept private`;if($('#spot-name'))$('#spot-name').value='';
        $('#create-spot-modal').classList.remove('hidden');
      }));
    }catch{}
  },300);
});

async function loadPipeline(q=''){
  const params=new URLSearchParams();if(q)params.set('q',q);
  const headers=currentUser?{'X-Nostr-Pubkey':currentUser.pubkey}:{};
  const list=$('#pipeline-list');
  try{
    const spots=await(await fetch(`${API_BASE}/api/spots/browse?${params}`,{headers})).json();
    if(!spots.length){list.innerHTML='<div class="empty-state"><p>No crews found.</p></div>';return;}
    list.innerHTML=spots.map(s=>renderPipelineCard(s)).join('');
    const isNewUser=currentUser&&!q&&!localStorage.getItem('swellnotes_onboarded');
    if(isNewUser&&!document.getElementById('onboard-overlay')){
      const overlay=document.createElement('div');
      overlay.id='onboard-overlay';
      overlay.className='onboard-overlay';
      overlay.innerHTML=`<div class="card" style="position:relative">
        <button class="onboard-close" onclick="window.dismissOnboard()" aria-label="Close">&times;</button>
        <h2>Select a spot</h2>
        <p class="muted">Search any surf break worldwide to pick your spot.</p>
        <div class="field" style="margin:0.75rem 0">
          <input type="text" id="onboard-spot-search" placeholder="Search surf breaks... (e.g. Pipeline, Uluwatu)" autocomplete="off">
        </div>
        <div id="onboard-spot-results" class="spot-results"></div>
        <button class="link-btn" style="margin-top:0.75rem;font-size:0.85rem;color:var(--text-muted)" onclick="window.revealCrews()">Explore existing spots</button>
      </div>`;
      document.body.appendChild(overlay);
      const input=overlay.querySelector('#onboard-spot-search');
      input.addEventListener('input',()=>{
        const origInput=$('#pipeline-spot-search');
        if(origInput){origInput.value=input.value;origInput.dispatchEvent(new Event('input'));}
        // mirror results into overlay
        setTimeout(()=>{
          const origResults=$('#pipeline-spot-results');
          const overlayResults=overlay.querySelector('#onboard-spot-results');
          if(origResults&&overlayResults)overlayResults.innerHTML=origResults.innerHTML;
        },350);
      });
    }
  }catch{list.innerHTML='<div class="empty-state"><p>Error loading crews.</p></div>';}
}

function packAvatar(u,cls){return u.avatar_path?`<img src="${safeUrl(u.avatar_path)}" class="${cls}" title="${escapeHtml(u.display_name||'')}" alt="">`:`<div class="${cls}-ph" title="${escapeHtml(u.display_name||'')}">${(u.display_name||'?')[0].toUpperCase()}</div>`;}
function renderPipelineCard(s){
  const name=escapeHtml(s.name||s.region||'Unknown');
  const cover=s.cover_image_url||defaultCover(s.id);
  const creator=s.creator?`<div class="pack-creator">${packAvatar(s.creator,'pack-creator-av')}<span>Started by <strong>${escapeHtml(s.creator.display_name||'Anon')}</strong></span></div>`:'';
  const previews=(s.members_preview||[]).slice(0,6);
  const avs=previews.map(m=>packAvatar(m,'pack-av')).join('');
  const more=s.member_count>previews.length?`<span class="pack-av-more">+${s.member_count-previews.length}</span>`:'';
  const active=s.recent_sessions>0?'<span class="pack-active">Active</span>':'';
  let actionBtn='';
  if(s.is_member)actionBtn='<button class="pack-btn is-member" disabled>Member</button>';
  else if(!s.is_private&&currentUser)actionBtn=`<button class="pack-btn pack-btn-join" onclick="event.stopPropagation();joinPublicCrew('${s.id}')">Join</button>`;
  else if(s.has_pending_request)actionBtn='<button class="pack-btn" disabled>Requested</button>';
  else if(currentUser)actionBtn=`<button class="pack-btn pack-btn-join" onclick="event.stopPropagation();openJoinRequest('${s.id}','${name}')">Request</button>`;
  return`<div class="pack-card" onclick="${s.is_member?`joinExistingSpot('${s.id}')`:''}">
    <div class="pack-cover-wrap"><img src="${safeUrl(cover)}" class="pack-cover" alt="">${active}</div>
    <div class="pack-body">
      <div class="pack-head"><h3 class="pack-title">${name}</h3>${actionBtn}</div>
      ${creator}
      ${s.description?`<div class="pack-desc">${escapeHtml(s.description)}</div>`:''}
      <div class="pack-foot"><div class="pack-avatars">${avs}${more}</div><span class="pack-count">${s.member_count} member${s.member_count!==1?'s':''} · ${s.is_private?'Private':'Public'}</span></div>
    </div>
  </div>`;
}

// ===== JOIN REQUESTS =====
window.revealCrews=()=>{
  localStorage.setItem('swellnotes_onboarded','1');
  const overlay=document.getElementById('onboard-overlay');
  if(overlay)overlay.remove();
};

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
    if(res.ok){localStorage.setItem('swellnotes_onboarded','1');await loadMySpots();loadBrowseSpots();const spot=await(await fetch(`${API_BASE}/api/spots/${id}`)).json();landInSpot(spot,{welcome:true});toast(`Joined ${spot?.name||'spot'} 🤙`);}
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
        ${avatarHTML(r.avatar_path,r.display_name,'feed-avatar',!!ringCls(r))}
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
          $('#create-spot-name').textContent=`Forecasts from ${el.dataset.name} · kept private`;if($('#spot-name'))$('#spot-name').value='';
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

// ===== HIDE NAV ON SCROLL DOWN =====
(()=>{const hdr=document.getElementById('app-header');if(!hdr)return;let lastY=window.scrollY,ticking=false;const onScroll=()=>{const y=window.scrollY;const dy=y-lastY;if(y<30){hdr.classList.remove('nav-hidden');}else if(dy>4){hdr.classList.add('nav-hidden');}else if(dy<-4){hdr.classList.remove('nav-hidden');}lastY=y;ticking=false;};window.addEventListener('scroll',()=>{if(!ticking){requestAnimationFrame(onScroll);ticking=true;}},{passive:true});})();

// ===== GOOGLE / APPLE LOGIN (Wisp-style nostr key backup) =====
const KeychainBackup=IS_CAPACITOR?resolveNativePlugin('Keychain',['save','load','clear','list']):null;
let pinSubmitHandler=null;
function showPinModal({title,subtitle,confirm,onSubmit}){
  $('#pin-title').textContent=title;$('#pin-subtitle').textContent=subtitle;
  $('#pin-confirm').classList.toggle('hidden',!confirm);
  $('#pin-input').value='';$('#pin-confirm').value='';
  $('#pin-error').classList.add('hidden');$('#pin-loading').classList.add('hidden');
  $('#pin-submit').classList.remove('hidden');
  $('#pin-modal').classList.remove('hidden');$('#pin-input').focus();
  pinSubmitHandler=onSubmit;
}
function hidePinModal(){$('#pin-modal').classList.add('hidden');pinSubmitHandler=null;}
function pinError(msg){const e=$('#pin-error');e.textContent=msg;e.classList.remove('hidden');pinBusy(false);}
function pinBusy(b,text){$('#pin-loading-text').textContent=text||'Working…';$('#pin-loading').classList.toggle('hidden',!b);$('#pin-submit').classList.toggle('hidden',b);}
function validPin(p){return /^[0-9]{4,8}$/.test(p);}
$('#pin-submit')?.addEventListener('click',()=>{pinSubmitHandler&&pinSubmitHandler();});
$('#pin-modal-close')?.addEventListener('click',hidePinModal);
$('#pin-modal .modal-backdrop')?.addEventListener('click',hidePinModal);
$('#chooser-modal-close')?.addEventListener('click',()=>$('#chooser-modal').classList.add('hidden'));
$('#chooser-modal .modal-backdrop')?.addEventListener('click',()=>$('#chooser-modal').classList.add('hidden'));

async function finishOAuthLogin(account,isNew){
  let name=null,avatar=null;
  try{const u=await(await fetch(`${API_BASE}/api/users/${account.pubkey}`)).json();if(u&&!u.error&&u.display_name){name=u.display_name;avatar=u.avatar_path;}}catch{}
  if(!name){
    name='surfer-'+account.pubkey.slice(0,6);
    try{await fetch(`${API_BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:account.pubkey,display_name:name})});}catch{}
  }
  currentUser={pubkey:account.pubkey,secretKey:account.secretKey,display_name:name,avatar_path:absAvatarUrl(avatar)};
  saveUser(currentUser);
  if(isNew){markFreshAccount();autoFollowDefault();}
  updateAuthUI();hidePinModal();$('#chooser-modal').classList.add('hidden');
  $('.landing-page')?.classList.add('hidden');$('#login-modal')?.classList.add('hidden');
  await selectFirstSpotIfNone();
  toast(`Welcome${isNew?'':' back'}, ${name}!`);
  if(isNew)maybeStartTour(700);
}
function showChooser(accounts){
  const list=$('#chooser-list');list.innerHTML='';
  accounts.forEach(a=>{const b=document.createElement('button');b.className='chooser-item';
    b.innerHTML=`<span class="chooser-name">${escapeHtml(a.npub.slice(0,16))}…</span><span class="chooser-npub">${escapeHtml(a.npub)}</span>`;
    b.onclick=()=>finishOAuthLogin(a,false);list.appendChild(b);});
  $('#chooser-modal').classList.remove('hidden');
}

// ---- Profile setup / edit modal (name + photo) ----
let profileAvatarFile=null,profileSubmitHandler=null;
function openProfileModal({title,sub,name,submitLabel,onSubmit}){
  $('#profile-modal-title').textContent=title;$('#profile-modal-sub').textContent=sub;
  $('#profile-name-input').value=name||'';$('#profile-submit').textContent=submitLabel||'Continue';
  $('#profile-error').classList.add('hidden');$('#profile-loading').classList.add('hidden');$('#profile-submit').classList.remove('hidden');
  profileAvatarFile=null;
  const img=$('#profile-avatar-img'),ph=$('#profile-avatar-ph');
  if(currentUser?.avatar_path&&name){img.src=currentUser.avatar_path;img.style.display='';ph.style.display='none';}
  else{img.style.display='none';ph.style.display='';}
  profileSubmitHandler=onSubmit;
  $('#profile-modal').classList.remove('hidden'); // no autofocus: keeps title clear of the notch until they tap
}
function closeProfileModal(){$('#profile-modal').classList.add('hidden');profileSubmitHandler=null;profileAvatarFile=null;}
function profileError(msg){const e=$('#profile-error');e.textContent=msg;e.classList.remove('hidden');profileBusy(false);}
function profileBusy(b,text){$('#profile-loading-text').textContent=text||'Saving…';$('#profile-loading').classList.toggle('hidden',!b);$('#profile-submit').classList.toggle('hidden',b);}
$('#profile-modal-close')?.addEventListener('click',closeProfileModal);
$('#profile-avatar-upload')?.addEventListener('click',()=>$('#profile-avatar-file').click());
$('#profile-avatar-file')?.addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;profileAvatarFile=f;
  const img=$('#profile-avatar-img'),ph=$('#profile-avatar-ph');const r=new FileReader();r.onload=()=>{img.src=r.result;img.style.display='';ph.style.display='none';};r.readAsDataURL(f);});
$('#profile-submit')?.addEventListener('click',()=>{profileSubmitHandler&&profileSubmitHandler();});

// Build the avatar portion of an /api/auth/login body (Blossom URL, else base64).
async function avatarBody(file){
  if(!file)return {body:{},url:null};
  const url=await uploadToBlossom(file);
  if(url)return {body:{avatar_url:url},url};
  const r=new FileReader();const b64=await new Promise(res=>{r.onloadend=()=>res(r.result.split(',')[1]);r.readAsDataURL(file);});
  return {body:{avatar_base64:b64},url:null};
}

// New Apple account → collect name + photo, register, log in.
function openProfileSetup(account){
  openProfileModal({title:'Set up your profile',sub:'Pick a surfer name and photo. You can change these later in Settings.',name:'',submitLabel:'Start surfing',
    onSubmit:async()=>{
      const name=$('#profile-name-input').value.trim();
      if(name.length<2)return profileError('Pick a name (at least 2 characters)');
      profileBusy(true,'Creating your profile…');
      try{
        const {body:ab,url:abUrl}=await avatarBody(profileAvatarFile);
        const res=await fetch(`${API_BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:account.pubkey,display_name:name,...ab})});
        const data=await res.json();
        if(!res.ok)return profileError(data?.error==='name_taken'?(data.message||'That name is taken. Try another.'):(data?.error||'Failed'));
        const avatarUrl=absAvatarUrl(data.avatar_path)||abUrl||null;
        currentUser={pubkey:account.pubkey,secretKey:account.secretKey,display_name:name,avatar_path:avatarUrl};
        saveUser(currentUser);markFreshAccount();autoFollowDefault();
        publishProfile(name,avatarUrl,data.nip05_full).catch(()=>{}); // fire-and-forget: relay publish must not block signup
        updateAuthUI();closeProfileModal();$('.landing-page')?.classList.add('hidden');$('#login-modal')?.classList.add('hidden');
        toast(`Welcome, ${name}!`);maybeStartTour(700);
      }catch(e){profileError(e.message||'Failed');}
    }});
}

// Edit name + photo from Settings.
function openProfileEdit(){
  if(!currentUser)return;
  openProfileModal({title:'Edit profile',sub:'Update your surfer name or photo.',name:currentUser.display_name||'',submitLabel:'Save',
    onSubmit:async()=>{
      const name=$('#profile-name-input').value.trim();
      if(name.length<2)return profileError('Pick a name (at least 2 characters)');
      profileBusy(true,'Saving…');
      try{
        const {body:ab,url:abUrl}=await avatarBody(profileAvatarFile);
        const body={pubkey:currentUser.pubkey,display_name:name,...ab};
        if(!profileAvatarFile&&currentUser.avatar_path)body.avatar_url=currentUser.avatar_path;
        const res=await fetch(`${API_BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data=await res.json();
        if(!res.ok)return profileError(data?.error==='name_taken'?(data.message||'That name is taken. Try another.'):(data?.error||'Failed'));
        const avatarUrl=absAvatarUrl(data.avatar_path)||abUrl||currentUser.avatar_path||null;
        currentUser.display_name=name;currentUser.avatar_path=avatarUrl;saveUser(currentUser);
        publishProfile(name,avatarUrl,null).catch(()=>{}); // fire-and-forget: relay publish must not block saving
        $('#settings-name').textContent=name;
        if(avatarUrl){$('#settings-avatar').src=avatarUrl;$('#settings-avatar').style.display='';}
        if($('#user-avatar')&&avatarUrl)$('#user-avatar').src=avatarUrl;
        updateAuthUI();closeProfileModal();toast('Profile updated!');
      }catch(e){profileError(e.message||'Failed');}
    }});
}
$('#settings-edit-name')?.addEventListener('click',openProfileEdit);
async function startOAuthLogin(){
  if(!IS_CAPACITOR){toast('Use the app to sign in with Apple','error');return;}
  try{
    const {ctx,mode}=await authBackup.beginSignIn(KeychainBackup);
    if(mode==='setup'){
      showPinModal({title:'Set a backup PIN',subtitle:'This PIN encrypts your account key in your own cloud, you\'ll need it to log in on another device. Pick 4-8 digits.',confirm:true,
        onSubmit:async()=>{const p=$('#pin-input').value,c=$('#pin-confirm').value;
          if(!validPin(p))return pinError('PIN must be 4-8 digits');
          if(p!==c)return pinError('PINs don\'t match');
          pinBusy(true,'Creating your account…');
          try{const acct=await authBackup.createAccount(ctx,p);hidePinModal();openProfileSetup(acct);}catch(e){pinError(e.message||'Failed');}}});
    }else{
      showPinModal({title:'Enter your PIN',subtitle:'Enter the PIN you set when you first created your account.',confirm:false,
        onSubmit:async()=>{const p=$('#pin-input').value;
          if(!validPin(p))return pinError('PIN must be 4-8 digits');
          pinBusy(true,'Restoring…');
          try{const accts=await authBackup.restoreWithPin(ctx,p);
            if(accts.length===1)await finishOAuthLogin(accts[0],false);
            else{hidePinModal();showChooser(accts);}
          }catch(e){pinError(e.message||'Incorrect PIN');}}});
    }
  }catch(e){console.error('[oauth]',e);toast(e.message||'Sign-in failed','error');}
}
if(authBackup.appleConfigured())$('#landing-apple-btn')?.classList.remove('hidden');
$('#landing-apple-btn')?.addEventListener('click',()=>startOAuthLogin());

// ===== LOG IN WITH NOSTR (paste nsec, device-only) =====
// Parse an nsec (bech32) or 64-char hex private key → {secretKey, pubkey}, or null.
function parseNsec(input){
  const t=(input||'').trim();
  let skHex=null;
  if(/^nsec1[0-9a-z]+$/i.test(t)){try{const d=nip19.decode(t);if(d.type==='nsec')skHex=bytesToHex(d.data);}catch{}}
  else if(/^[0-9a-fA-F]{64}$/.test(t))skHex=t.toLowerCase();
  if(!skHex)return null;
  try{const pubkey=getPublicKey(hexToBytes(skHex));return{secretKey:skHex,pubkey};}catch{return null;}
}
function openNostrModal(){
  $('#nostr-nsec').value='';$('#nostr-nsec').type='password';
  $('#nostr-error').classList.add('hidden');$('#nostr-loading').classList.add('hidden');$('#nostr-submit').classList.remove('hidden');
  $('#nostr-modal').classList.remove('hidden');
}
function closeNostrModal(){$('#nostr-modal').classList.add('hidden');}
function nostrError(m){const e=$('#nostr-error');e.textContent=m;e.classList.remove('hidden');$('#nostr-loading').classList.add('hidden');$('#nostr-submit').classList.remove('hidden');}
function nostrBusy(b){$('#nostr-loading').classList.toggle('hidden',!b);$('#nostr-submit').classList.toggle('hidden',b);}
$('#landing-nostr-btn')?.addEventListener('click',openNostrModal);
$('#nostr-back')?.addEventListener('click',closeNostrModal);
$('#nostr-eye')?.addEventListener('click',()=>{const f=$('#nostr-nsec');f.type=f.type==='password'?'text':'password';});
$('#nostr-submit')?.addEventListener('click',async()=>{
  const acct=parseNsec($('#nostr-nsec').value);
  if(!acct)return nostrError("That doesn't look like a valid nsec or hex private key.");
  nostrBusy(true);
  try{
    // Resolve a display name/photo: server first, then the Nostr profile, else a default.
    let name=null,avatar=null;
    try{const u=await(await fetch(`${API_BASE}/api/users/${acct.pubkey}`)).json();if(u&&!u.error&&u.display_name){name=u.display_name;avatar=u.avatar_path;}}catch{}
    if(!name){try{const p=await fetchProfile(acct.pubkey);if(p&&(p.name||p.display_name)){name=p.name||p.display_name;avatar=p.picture||null;}}catch{}}
    const isNew=!name; // no profile anywhere → brand-new Nostr identity
    // First time this nsec logs into Swellnotes on this device (even an established
    // Nostr account) → treat as a fresh onboarding: reset flags + fire the tour.
    const seen=JSON.parse(localStorage.getItem('swellnotes_accounts')||'[]');
    const firstTime=!seen.includes(acct.pubkey);
    if(firstTime){seen.push(acct.pubkey);localStorage.setItem('swellnotes_accounts',JSON.stringify(seen));markFreshAccount();}
    if(!name){name='surfer-'+acct.pubkey.slice(0,6);
      try{await fetch(`${API_BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:acct.pubkey,display_name:name})});}catch{}}
    currentUser={pubkey:acct.pubkey,secretKey:acct.secretKey,display_name:name,avatar_path:absAvatarUrl(avatar),source:'nsec'};
    saveUser(currentUser); // device-only (no iCloud sync)
    if(isNew)autoFollowDefault();
    updateAuthUI();closeNostrModal();$('.landing-page')?.classList.add('hidden');$('#login-modal')?.classList.add('hidden');
    await selectFirstSpotIfNone();
    toast(`Welcome, ${name}!`);if(firstTime)maybeStartTour(700);
  }catch(e){nostrError(e.message||'Login failed');}
});

// ===== GUIDED WALKTHROUGH (spotlight tour over the real UI) =====
const WALK_KEY='swellnotes_tour_v1';
const TOUR_STEPS=[
  {view:'pipeline', target:'#pipeline-spot-search', demo:'Pipeline', title:'Pick your spot',
   text:'Search any surf break on earth. Every spot gets a private feed for its crew, the surfers who ride it.'},
  {view:'history', target:'#report-fab', fallback:'.nav-btn[data-view="history"]', title:'File a report',
   text:'After a surf, tap ＋ to log it. Swell, wind and tide for that moment are saved automatically.'},
  {view:'analysis', target:'.nav-btn[data-view="analysis"]', title:'Read the swell',
   text:'Analysis shows which conditions have scored best, so you know exactly when to paddle out.'},
  {view:'surfers', target:'.nav-btn[data-view="surfers"]', title:'Find your crew',
   text:'See who else surfs your break and follow them to build a shared logbook together.'},
  {view:'forecast', target:'.nav-btn[data-view="forecast"]', title:'Check the forecast',
   text:'Live swell, wind and tide for your break. Scrub the tide chart to plan the perfect window.'}
];
let tourIdx=0, tourPrev=null, tourEls=null;
function switchTourView(v){
  $$('.nav-btn').forEach(x=>x.classList.remove('active'));
  $(`.nav-btn[data-view="${v}"]`)?.classList.add('active');
  $$('.view').forEach(x=>x.classList.remove('active'));
  $(`#view-${v}`)?.classList.add('active');
  window.scrollTo(0,0);
}
function tourTarget(step){
  let el=step.target&&$(step.target);
  if(!el||el.getBoundingClientRect().width<2)el=step.fallback?$(step.fallback):null;
  if(!el||el.getBoundingClientRect().width<2)el=$(`.nav-btn[data-view="${step.view}"]`);
  return el;
}
function positionTour(){
  if(!tourEls)return;
  const step=TOUR_STEPS[tourIdx],el=tourTarget(step),{spot,tip}=tourEls;
  if(!el){spot.style.opacity='0';return;}
  // Fill the spotlighted input with demo text (forced dark, it renders light on its white bg)
  if(step.demo&&el.tagName==='INPUT'){el.value=step.demo;el.style.setProperty('color','#0f1729','important');}
  const r=el.getBoundingClientRect(),pad=8;
  const x=r.left-pad,y=r.top-pad,w=r.width+pad*2,h=r.height+pad*2;
  spot.style.cssText=`left:${x}px;top:${y}px;width:${w}px;height:${h}px;opacity:1`;
  const vh=window.innerHeight,roomBelow=vh-(y+h);
  if(roomBelow>230){tip.style.top=(y+h+14)+'px';tip.style.bottom='';}
  else{tip.style.bottom=(vh-y+14)+'px';tip.style.top='';}
}
function renderTip(){
  const step=TOUR_STEPS[tourIdx],last=tourIdx===TOUR_STEPS.length-1,{tip}=tourEls;
  tip.innerHTML=`
    <div class="wt-top"><div class="wt-dots">${TOUR_STEPS.map((_,i)=>`<span class="wt-dot${i===tourIdx?' active':''}"></span>`).join('')}</div><button class="wt-skip">Skip</button></div>
    <div class="wt-step-no">Step ${tourIdx+1} of ${TOUR_STEPS.length}</div>
    <div class="wt-title">${step.title}</div>
    <div class="wt-text">${step.text}</div>
    <div class="wt-nav"><button class="wt-back" ${tourIdx===0?'disabled':''} aria-label="Back">‹</button><button class="wt-next">${last?'Start surfing 🤙':'Next'}</button></div>`;
  tip.querySelector('.wt-skip').onclick=closeTour;
  tip.querySelector('.wt-back').onclick=()=>{if(tourIdx>0)tourStep(tourIdx-1);};
  tip.querySelector('.wt-next').onclick=()=>last?closeTour():tourStep(tourIdx+1);
}
function tourStep(i){
  tourIdx=i;switchTourView(TOUR_STEPS[i].view);renderTip();
  // Clear any prior demo text when entering a non-demo step
  if(!TOUR_STEPS[i].demo)['#pipeline-spot-search','#onboard-spot-search'].forEach(sel=>{const el=$(sel);if(el){el.value='';el.style.removeProperty('color');}});
  // Scroll the target to just below the nav header (not under it), then position the spotlight
  const place=()=>{
    document.getElementById('onboard-overlay')?.remove(); // drop the competing duplicate search field
    const el=tourTarget(TOUR_STEPS[tourIdx]);
    if(el){
      const hdr=document.getElementById('app-header');
      const headerBottom=(hdr&&!hdr.classList.contains('hidden'))?Math.max(0,hdr.getBoundingClientRect().bottom):0;
      const want=headerBottom+18;
      const r=el.getBoundingClientRect();
      if(r.top>want+24)window.scrollBy(0,r.top-want);
    }
    positionTour();
  };
  requestAnimationFrame(()=>requestAnimationFrame(place));
  setTimeout(place,250);setTimeout(place,650);
}
function startTour(){
  if(tourEls)return;
  // Reveal the real app chrome so the tour can drive actual nav + views
  tourPrev={header:$('#app-header')?.classList.contains('hidden'),main:$('#main-content')?.classList.contains('hidden'),view:$('.nav-btn.active')?.dataset.view};
  $('#app-header')?.classList.remove('hidden','nav-hidden');
  $('#main-content')?.classList.remove('hidden');
  const back=document.createElement('div');back.className='tour-backdrop';
  const spot=document.createElement('div');spot.className='tour-spot';
  const tip=document.createElement('div');tip.className='tour-tip';
  document.body.append(back,spot,tip);
  tourEls={back,spot,tip};
  window.addEventListener('resize',positionTour);
  tourStep(0);
}
function closeTour(){
  if(!tourEls)return;
  ['#pipeline-spot-search','#onboard-spot-search'].forEach(sel=>{const el=$(sel);if(el){el.value='';el.style.removeProperty('color');}}); // clear demo
  localStorage.setItem(WALK_KEY,'1');
  window.removeEventListener('resize',positionTour);
  Object.values(tourEls).forEach(e=>e.remove());tourEls=null;
  if(tourPrev){
    if(tourPrev.header)$('#app-header')?.classList.add('hidden');
    if(tourPrev.main)$('#main-content')?.classList.add('hidden');
    if(tourPrev.view)switchTourView(tourPrev.view);
  }
  tourPrev=null;
}
function maybeStartTour(delay=500){if(!localStorage.getItem(WALK_KEY))setTimeout(startTour,delay);}
window.startWalkthrough=startTour; // replay hook

// ===== INIT =====
const saved=localStorage.getItem('swellnotes_user');if(saved){try{currentUser=JSON.parse(saved);}catch{localStorage.removeItem('swellnotes_user');}}
// nsec device-only key: migrate a legacy localStorage secret into the Keychain, or
// re-attach the secret from the Keychain to the secret-free stub (async; only needed to sign).
if(currentUser?.source==='nsec'&&window.Capacitor?.Plugins?.Keychain){
  if(currentUser.secretKey){saveUser(currentUser);} // one-time migration off localStorage
  else{window.Capacitor.Plugins.Keychain.load({key:KEYCHAIN_USER_KEY}).then(r=>{if(r?.value){try{const full=JSON.parse(r.value);if(full.secretKey&&currentUser)currentUser.secretKey=full.secretKey;}catch{}}}).catch(()=>{});}
}
initTabHints();
// Restore from Keychain if localStorage was cleared/evicted. For nsec, write back only the
// secret-free stub so the secret never lands in localStorage (the secret is re-attached above).
if(!currentUser&&window.Capacitor?.Plugins?.Keychain){window.Capacitor.Plugins.Keychain.load({key:KEYCHAIN_USER_KEY}).then(r=>{if(r?.value){let store=r.value;try{const u=JSON.parse(r.value);if(u.source==='nsec')store=JSON.stringify({pubkey:u.pubkey,display_name:u.display_name,avatar_path:u.avatar_path,source:'nsec'});}catch{}localStorage.setItem(KEYCHAIN_USER_KEY,store);location.reload();}}).catch(e=>console.warn('[Keychain] restore failed',e));}
const savedSpot=localStorage.getItem('swellnotes_spot');if(savedSpot){try{currentSpot=JSON.parse(savedSpot);selectSpot(currentSpot);}catch{localStorage.removeItem('swellnotes_spot');}}
// Heal stale spot cache: re-fetch from server with auth so missing fields (name, location, members, cover) populate
if(currentSpot&&currentUser){fetch(`${API_BASE}/api/spots/${currentSpot.id}`,{headers:{'X-Nostr-Pubkey':currentUser.pubkey}}).then(r=>r.json()).then(fresh=>{if(fresh&&!fresh.error&&fresh.name)selectSpot(fresh);}).catch(()=>{});}
console.log('[Init] user:',currentUser?.display_name||'none','spot:',currentSpot?.name||'none');
updateAuthUI();checkProStatus();checkCallback();checkInviteURL();
// First-run guided walkthrough (once per device, for a logged-in user with a spot)
if(currentUser&&currentSpot&&!localStorage.getItem(WALK_KEY)){maybeStartTour(700);}
if(currentUser&&currentSpot){
  $$('.nav-btn').forEach(x=>x.classList.remove('active'));$$('.nav-btn[data-view="history"]').forEach(x=>x.classList.add('active'));
  $$('.view').forEach(v=>v.classList.remove('active'));$('#view-history').classList.add('active');
  fetchConditions();loadFeed();
} else if(currentSpot){fetchConditions();}
updateReportFab();syncHero();
// Service worker: register for PWA in production, but stay out of the way under
// live-reload (a cached SW serves stale assets and defeats hot reload during dev).
if('serviceWorker' in navigator){
  if(IS_LIVE_RELOAD){
    navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));
    if(window.caches)caches.keys().then(ks=>ks.forEach(k=>caches.delete(k)));
  } else {
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  }
}
// Capacitor: listen for deep link returns (NIP-46 callback)
if(IS_CAPACITOR){try{const CapApp=window.Capacitor.Plugins.App;if(CapApp)CapApp.addListener('appUrlOpen',data=>{if(!data.url)return;if(authBackup.handleOAuthRedirect(data.url))return;if(data.url.includes('login-callback')){checkCallback();return;}try{const u=new URL(data.url);const m=u.pathname.match(/^\/join\/(\w+)$/);if(m){history.replaceState(null,'',u.pathname);checkInviteURL();}}catch{}});}catch{}}
