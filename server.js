const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Media directories
const dirs = ['audio', 'videos', 'avatars'];
dirs.forEach(d => { const p = path.join(__dirname, d); if (!fs.existsSync(p)) fs.mkdirSync(p); app.use(`/${d}`, express.static(p)); });

// --- Database ---
const db = new Database(path.join(__dirname, 'surf-diary.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    pubkey TEXT PRIMARY KEY,
    display_name TEXT,
    avatar_path TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT NOT NULL,
    session_date TEXT NOT NULL,
    time_of_day TEXT NOT NULL,
    swells_json TEXT,
    surf_height_min_ft REAL, surf_height_max_ft REAL,
    wind_speed_mph REAL, wind_direction_deg REAL, wind_type TEXT, wind_gust_mph REAL,
    tide_height_ft REAL,
    rating INTEGER, notes TEXT,
    voice_memo_path TEXT, voice_transcript TEXT,
    video_path TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (pubkey) REFERENCES users(pubkey)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL, pubkey TEXT NOT NULL, body TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (pubkey) REFERENCES users(pubkey)
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower_pubkey TEXT NOT NULL, followed_pubkey TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (follower_pubkey, followed_pubkey)
  );
  CREATE TABLE IF NOT EXISTS forecast_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at INTEGER DEFAULT (unixepoch()),
    data_json TEXT NOT NULL
  );
`);

// Migrations
const migrations = [
  'ALTER TABLE sessions ADD COLUMN swells_json TEXT',
  'ALTER TABLE sessions ADD COLUMN voice_memo_path TEXT',
  'ALTER TABLE sessions ADD COLUMN voice_transcript TEXT',
  'ALTER TABLE sessions ADD COLUMN rating INTEGER',
  'ALTER TABLE sessions ADD COLUMN wind_direction_deg REAL',
  'ALTER TABLE sessions ADD COLUMN wind_gust_mph REAL',
  'ALTER TABLE sessions ADD COLUMN video_path TEXT',
  'ALTER TABLE users ADD COLUMN avatar_path TEXT',
  'ALTER TABLE sessions ADD COLUMN wave_shape TEXT',
  'ALTER TABLE sessions ADD COLUMN session_type TEXT DEFAULT \'surfed\'',
];
migrations.forEach(m => { try { db.exec(m); } catch {} });

// --- Surfline ---
const SPOT_ID = '5842041f4e65fad6a7708b9c';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
function degreesToCompass(deg) { const d=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']; return d[Math.round(deg/22.5)%16]; }
function metersToFeet(m) { return Math.round(m*3.28084*10)/10; }
function timeOfDayToHours(t) {
  const hourMap = {'5am':[5,6],'6am':[6,7],'7am':[7,8],'8am':[8,9],'9am':[9,10],'10am':[10,11],'11am':[11,12],'12pm':[12,13],'1pm':[13,14],'2pm':[14,15],'3pm':[15,16],'4pm':[16,17],'5pm':[17,18],'6pm':[18,19]};
  const legacy = {dawn:[5,7],morning:[7,10],midday:[10,13],afternoon:[13,16],evening:[16,18]};
  return hourMap[t] || legacy[t] || [7,10];
}

async function fetchSurflineData() {
  const [w,wi,t] = await Promise.all([
    fetch(`https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${SPOT_ID}&days=3&intervalHours=3&units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT`,{headers:HEADERS}),
    fetch(`https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=${SPOT_ID}&days=3&intervalHours=3&units%5BwindSpeed%5D=MPH`,{headers:HEADERS}),
    fetch(`https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${SPOT_ID}&days=3`,{headers:HEADERS}),
  ]);
  const [wave,wind,tides] = await Promise.all([w.json(),wi.json(),t.json()]);
  db.prepare('INSERT INTO forecast_cache (data_json) VALUES (?)').run(JSON.stringify({wave:wave.data,wind:wind.data,tides:tides.data,utcOffset:wave.associated?.utcOffset||-6}));
  return {wave:wave.data,wind:wind.data,tides:tides.data,utcOffset:wave.associated?.utcOffset||-6};
}

function findClosest(entries,ts) { if(!entries?.length)return null; let c=entries[0],m=Math.abs(entries[0].timestamp-ts); for(const e of entries){const d=Math.abs(e.timestamp-ts);if(d<m){m=d;c=e;}} return c; }

function getConditions(forecast,date,tod) {
  const[sh,eh]=timeOfDayToHours(tod),mid=Math.floor((sh+eh)/2),off=forecast.utcOffset||-6;
  const[y,m,d]=date.split('-').map(Number);
  const ts=Math.floor(new Date(Date.UTC(y,m-1,d,mid-off,0,0)).getTime()/1000);
  const we=findClosest(forecast.wave?.wave,ts),wi=findClosest(forecast.wind?.wind,ts),te=findClosest(forecast.tides?.tides,ts);
  const c={};
  if(we){c.surf_height_min_ft=we.surf?.min;c.surf_height_max_ft=we.surf?.max;c.swells=(we.swells||[]).filter(s=>s.height>0).map(s=>({height_ft:Math.round(s.height*10)/10,period_s:s.period,direction_deg:Math.round(s.direction),direction_compass:degreesToCompass(s.direction),impact:Math.round(s.impact*100)}));}
  if(wi){c.wind_speed_mph=Math.round(wi.speed*10)/10;c.wind_direction_deg=Math.round(wi.direction);c.wind_type=wi.directionType;c.wind_gust_mph=Math.round((wi.gust||wi.speed)*10)/10;}
  if(te)c.tide_height_ft=metersToFeet(te.height);
  return c;
}

async function getForecast(){const c=db.prepare('SELECT data_json,fetched_at FROM forecast_cache ORDER BY fetched_at DESC LIMIT 1').get();if(c&&c.fetched_at>Math.floor(Date.now()/1000)-7200)return JSON.parse(c.data_json);return await fetchSurflineData();}

function saveFile(base64,dir,ext){const fn=`${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;fs.writeFileSync(path.join(__dirname,dir,fn),Buffer.from(base64,'base64'));return`/${dir}/${fn}`;}

// --- Routes ---
app.get('/api/conditions',async(req,res)=>{try{res.json(getConditions(await getForecast(),req.query.date||new Date().toISOString().split('T')[0],req.query.time_of_day||'morning'));}catch(e){res.status(500).json({error:'Failed'});}});

app.get('/api/nip46/init',async(req,res)=>{try{const{generateSecretKey,getPublicKey}=await import('nostr-tools');const sk=generateSecretKey();const secretKey=Buffer.from(sk).toString('hex');const publicKey=getPublicKey(sk);const rh=crypto.randomBytes(16).toString('hex');const secret=`sec-${rh.slice(0,8)}-${rh.slice(8,12)}-${rh.slice(12,16)}-${rh.slice(16,20)}-${rh.slice(20,32)}`;const relay='wss://relay.primal.net';const p=new URLSearchParams();p.append('relay',relay);p.append('secret',secret);p.append('name','Dominical Surf Diary');p.append('url',req.query.origin||`http://localhost:${PORT}`);const qrURI=`nostrconnect://${publicKey}?${p.toString()}`;const cp=new URLSearchParams(p);cp.append('callback',`${req.query.origin||`http://localhost:${PORT}`}/login-callback`);res.json({secretKey,publicKey,secret,relay,qrDataUrl:await QRCode.toDataURL(qrURI,{width:280,margin:2}),qrURI,mobileURI:`nostrconnect://${publicKey}?${cp.toString()}`});}catch(e){res.status(500).json({error:'Failed'});}});

function requireAuth(req,res,next){const p=req.headers['x-nostr-pubkey'];if(!p||!/^[0-9a-f]{64}$/.test(p))return res.status(401).json({error:'Missing pubkey'});req.pubkey=p;next();}

app.post('/api/auth/login',(req,res)=>{
  const{pubkey,display_name,avatar_base64,avatar_url}=req.body;
  if(!pubkey||!/^[0-9a-f]{64}$/.test(pubkey))return res.status(400).json({error:'Invalid pubkey'});
  let avatarPath=avatar_url||null;
  if(!avatarPath&&avatar_base64)avatarPath=saveFile(avatar_base64,'avatars','jpg');
  if(avatarPath)db.prepare('INSERT INTO users(pubkey,display_name,avatar_path)VALUES(?,?,?)ON CONFLICT(pubkey)DO UPDATE SET display_name=excluded.display_name,avatar_path=excluded.avatar_path').run(pubkey,display_name||'Anon',avatarPath);
  else db.prepare('INSERT INTO users(pubkey,display_name)VALUES(?,?)ON CONFLICT(pubkey)DO UPDATE SET display_name=excluded.display_name').run(pubkey,display_name||'Anon');
  const user=db.prepare('SELECT * FROM users WHERE pubkey=?').get(pubkey);
  res.json({ok:true,...user});
});

app.get('/api/users',(req,res)=>{res.json(db.prepare('SELECT u.pubkey,u.display_name,u.avatar_path,(SELECT COUNT(*)FROM sessions WHERE pubkey=u.pubkey)as session_count FROM users u ORDER BY session_count DESC').all());});
app.get('/api/users/:pubkey',(req,res)=>{const u=db.prepare('SELECT*FROM users WHERE pubkey=?').get(req.params.pubkey);if(!u)return res.status(404).json({error:'Not found'});res.json({...u,session_count:db.prepare('SELECT COUNT(*)as c FROM sessions WHERE pubkey=?').get(req.params.pubkey).c});});

// Follows
app.get('/api/follows',requireAuth,(req,res)=>{res.json({following:db.prepare('SELECT f.followed_pubkey as pubkey,u.display_name,u.avatar_path,(SELECT COUNT(*)FROM sessions WHERE pubkey=f.followed_pubkey)as session_count FROM follows f LEFT JOIN users u ON f.followed_pubkey=u.pubkey WHERE f.follower_pubkey=?').all(req.pubkey),followers:db.prepare('SELECT f.follower_pubkey as pubkey,u.display_name FROM follows f LEFT JOIN users u ON f.follower_pubkey=u.pubkey WHERE f.followed_pubkey=?').all(req.pubkey)});});
app.post('/api/follows/:pubkey',requireAuth,(req,res)=>{if(req.params.pubkey===req.pubkey)return res.status(400).json({error:'Cannot follow yourself'});db.prepare('INSERT OR IGNORE INTO follows(follower_pubkey,followed_pubkey)VALUES(?,?)').run(req.pubkey,req.params.pubkey);res.json({ok:true});});
app.delete('/api/follows/:pubkey',requireAuth,(req,res)=>{db.prepare('DELETE FROM follows WHERE follower_pubkey=? AND followed_pubkey=?').run(req.pubkey,req.params.pubkey);res.json({ok:true});});

function getFeedPubkeys(pk){return[pk,...db.prepare('SELECT followed_pubkey FROM follows WHERE follower_pubkey=?').all(pk).map(r=>r.followed_pubkey)];}

// Sessions
app.get('/api/sessions',(req,res)=>{
  const{limit=50,offset=0,month,swell_dir,feed_for,pubkey:fp}=req.query;let w=[],p=[];
  if(feed_for){const pks=getFeedPubkeys(feed_for);w.push(`s.pubkey IN(${pks.map(()=>'?').join(',')})`);p.push(...pks);}
  if(fp){w.push('s.pubkey=?');p.push(fp);}
  if(month){w.push("strftime('%Y-%m',session_date)=?");p.push(month);}
  if(swell_dir){w.push("swells_json LIKE ?");p.push(`%"direction_compass":"${swell_dir}"%`);}
  const wc=w.length?'WHERE '+w.join(' AND '):'';
  res.json({sessions:db.prepare(`SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ${wc} ORDER BY s.session_date DESC,s.created_at DESC LIMIT ? OFFSET ?`).all(...p,+limit,+offset),total:db.prepare(`SELECT COUNT(*)as count FROM sessions s ${wc}`).get(...p).count});
});

app.get('/api/sessions/:id',(req,res)=>{
  const s=db.prepare('SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.id=?').get(req.params.id);
  if(!s)return res.status(404).json({error:'Not found'});
  res.json({session:s,comments:db.prepare('SELECT c.*,u.display_name,u.avatar_path FROM comments c LEFT JOIN users u ON c.pubkey=u.pubkey WHERE c.session_id=? ORDER BY c.created_at ASC').all(req.params.id)});
});

app.post('/api/sessions',requireAuth,async(req,res)=>{
  const b=req.body;let c={};try{c=getConditions(await getForecast(),b.session_date,b.time_of_day);}catch{}
  // Accept Blossom URLs directly, or fall back to base64 local storage
  let voicePath=b.voice_url||null,videoPath=b.video_url||null;
  if(!voicePath&&b.voice_memo_base64)voicePath=saveFile(b.voice_memo_base64,'audio','webm');
  if(!videoPath&&b.video_base64)videoPath=saveFile(b.video_base64,'videos','mp4');
  const r=db.prepare('INSERT INTO sessions(pubkey,session_date,time_of_day,swells_json,surf_height_min_ft,surf_height_max_ft,wind_speed_mph,wind_direction_deg,wind_type,wind_gust_mph,tide_height_ft,rating,wave_shape,session_type,notes,voice_memo_path,voice_transcript,video_path)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    req.pubkey,b.session_date,b.time_of_day,JSON.stringify(c.swells||[]),
    c.surf_height_min_ft??null,c.surf_height_max_ft??null,c.wind_speed_mph??null,c.wind_direction_deg??null,c.wind_type??null,c.wind_gust_mph??null,c.tide_height_ft??null,
    b.rating,b.wave_shape||null,b.session_type||'surfed',b.notes||null,voicePath,b.voice_transcript||null,videoPath);
  res.json({ok:true,id:r.lastInsertRowid,conditions:c});
});

app.delete('/api/sessions/:id',requireAuth,(req,res)=>{const s=db.prepare('SELECT pubkey,voice_memo_path,video_path FROM sessions WHERE id=?').get(req.params.id);if(!s)return res.status(404).json({error:'Not found'});if(s.pubkey!==req.pubkey)return res.status(403).json({error:'Forbidden'});[s.voice_memo_path,s.video_path].forEach(p=>{if(p)try{fs.unlinkSync(path.join(__dirname,p));}catch{}});db.prepare('DELETE FROM sessions WHERE id=?').run(req.params.id);res.json({ok:true});});

app.post('/api/sessions/:id/comments',requireAuth,(req,res)=>{if(!req.body.body?.trim())return res.status(400).json({error:'Empty'});if(!db.prepare('SELECT id FROM sessions WHERE id=?').get(req.params.id))return res.status(404).json({error:'Not found'});db.prepare('INSERT INTO comments(session_id,pubkey,body)VALUES(?,?,?)').run(req.params.id,req.pubkey,req.body.body.trim());res.json({ok:true});});

// Search
app.get('/api/search',(req,res)=>{
  const{pubkey,dir_min,dir_max,height_min,height_max,period_min,period_max,rating_min,rating_max}=req.query;
  let sessions;
  if(pubkey){const pks=getFeedPubkeys(pubkey);sessions=db.prepare(`SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.pubkey IN(${pks.map(()=>'?').join(',')}) ORDER BY s.session_date DESC`).all(...pks);}
  else sessions=db.prepare('SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ORDER BY s.session_date DESC').all();

  const results=sessions.filter(s=>{
    const swells=JSON.parse(s.swells_json||'[]');
    if(!swells.length)return false;
    // Direction filter: check if ANY swell falls in the degree range
    if(dir_min||dir_max){
      const dmin=parseFloat(dir_min)||0,dmax=parseFloat(dir_max)||360;
      const match=swells.some(sw=>sw.direction_deg>=dmin&&sw.direction_deg<=dmax);
      if(!match)return false;
    }
    // Height filter: check primary swell
    if(height_min&&swells[0].height_ft<parseFloat(height_min))return false;
    if(height_max&&swells[0].height_ft>parseFloat(height_max))return false;
    // Period filter
    if(period_min&&swells[0].period_s<parseFloat(period_min))return false;
    if(period_max&&swells[0].period_s>parseFloat(period_max))return false;
    // Rating filter
    if(rating_min&&(s.rating||0)<parseInt(rating_min))return false;
    if(rating_max&&(s.rating||0)>parseInt(rating_max))return false;
    return true;
  });

  // Compute summary stats
  const ratings=results.filter(s=>s.rating).map(s=>s.rating);
  const summary={
    count:results.length,
    avg_rating:ratings.length?Math.round(ratings.reduce((a,b)=>a+b,0)/ratings.length*10)/10:null,
    best_rating:ratings.length?Math.max(...ratings):null,
    worst_rating:ratings.length?Math.min(...ratings):null,
  };

  res.json({sessions:results.slice(0,100),summary});
});

// Analysis
function getAnalysisSessions(pk){if(!pk)return db.prepare('SELECT*FROM sessions WHERE swells_json IS NOT NULL AND rating IS NOT NULL').all();const pks=getFeedPubkeys(pk);return db.prepare(`SELECT*FROM sessions WHERE pubkey IN(${pks.map(()=>'?').join(',')})AND swells_json IS NOT NULL AND rating IS NOT NULL`).all(...pks);}

app.get('/api/analysis/by-direction',(req,res)=>{const ss=getAnalysisSessions(req.query.pubkey);const m={};for(const s of ss){const sw=JSON.parse(s.swells_json||'[]');if(!sw.length)continue;const d=sw[0].direction_compass;if(!m[d])m[d]={r:[],sh:[],sp:[]};m[d].r.push(s.rating);m[d].sh.push(sw[0].height_ft);m[d].sp.push(sw[0].period_s);}res.json(Object.entries(m).map(([d,v])=>({direction:d,session_count:v.r.length,avg_rating:Math.round(v.r.reduce((a,b)=>a+b,0)/v.r.length*10)/10,avg_swell_height:Math.round(v.sh.reduce((a,b)=>a+b,0)/v.sh.length*10)/10,avg_swell_period:Math.round(v.sp.reduce((a,b)=>a+b,0)/v.sp.length*10)/10})).sort((a,b)=>b.avg_rating-a.avg_rating));});

app.get('/api/analysis/best-conditions',(req,res)=>{const ss=getAnalysisSessions(req.query.pubkey);const c={};for(const s of ss){const sw=JSON.parse(s.swells_json||'[]');if(!sw.length)continue;const w=sw[0];const k=`${w.direction_compass}|${Math.round(w.height_ft)}|${w.period_s<10?'s':w.period_s<15?'m':'l'}|${s.wind_type||'-'}`;if(!c[k])c[k]={r:[],dir:w.direction_compass,swell:Math.round(w.height_ft)+'ft',period:w.period_s<10?'short (<10s)':w.period_s<15?'medium (10-15s)':'long (15s+)',wind:s.wind_type||'-'};c[k].r.push(s.rating);}res.json(Object.values(c).filter(x=>x.r.length>=2).map(x=>({direction:x.dir,swell_bucket:x.swell,period_bucket:x.period,wind_type:x.wind,count:x.r.length,avg_rating:Math.round(x.r.reduce((a,b)=>a+b,0)/x.r.length*10)/10})).sort((a,b)=>b.avg_rating-a.avg_rating).slice(0,20));});

app.get('/api/analysis/timeline',(req,res)=>{const pk=req.query.pubkey;let ss;if(pk){const pks=getFeedPubkeys(pk);ss=db.prepare(`SELECT session_date,ROUND(AVG(rating),1)as avg_rating,ROUND(AVG(surf_height_min_ft),1)as avg_min,ROUND(AVG(surf_height_max_ft),1)as avg_max,COUNT(*)as entries FROM sessions WHERE pubkey IN(${pks.map(()=>'?').join(',')})GROUP BY session_date ORDER BY session_date DESC LIMIT 90`).all(...pks);}else{ss=db.prepare('SELECT session_date,ROUND(AVG(rating),1)as avg_rating,ROUND(AVG(surf_height_min_ft),1)as avg_min,ROUND(AVG(surf_height_max_ft),1)as avg_max,COUNT(*)as entries FROM sessions GROUP BY session_date ORDER BY session_date DESC LIMIT 90').all();}for(const r of ss){const s=db.prepare('SELECT swells_json FROM sessions WHERE session_date=? AND swells_json IS NOT NULL LIMIT 1').get(r.session_date);if(s?.swells_json)r.directions=JSON.parse(s.swells_json).filter(w=>w.height_ft>0).map(w=>w.direction_compass).join(',');}res.json(ss);});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`🏄 Surf Diary running at http://localhost:${PORT}`));
