const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const crypto = require('crypto');
if(!globalThis.crypto)globalThis.crypto={};
if(!globalThis.crypto.getRandomValues)globalThis.crypto.getRandomValues=b=>{const r=crypto.randomBytes(b.length);b.set(r);return b;};

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting: 500 requests per minute per IP
const rateLimits=new Map();
setInterval(()=>rateLimits.clear(),60000);
app.use((req,res,next)=>{
  if(req.path.startsWith('/api/')){
    const ip=req.ip||req.connection.remoteAddress;
    const count=(rateLimits.get(ip)||0)+1;
    rateLimits.set(ip,count);
    res.setHeader('X-RateLimit-Remaining',Math.max(0,500-count));
    if(count>500){return res.status(429).json({error:'Too many requests. Try again in a minute.'});}
  }
  next();
});

app.use((req,res,next)=>{const origin=req.headers.origin;if(origin==='capacitor://localhost'||origin==='ionic://localhost'){res.header('Access-Control-Allow-Origin',origin);res.header('Access-Control-Allow-Headers','Content-Type,X-Nostr-Pubkey');res.header('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(204);}next();});
// Request logging
const logFile=path.join(__dirname,'error.log');
function logError(msg){const line=`[${new Date().toISOString()}] ${msg}\n`;fs.appendFileSync(logFile,line);console.error(msg);}
app.use((req,res,next)=>{
  const start=Date.now();
  res.on('finish',()=>{
    const ms=Date.now()-start;
    if(res.statusCode>=400||ms>2000){
      logError(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ${req.ip||''}`);
    }
  });
  next();
});

app.use(express.json({ limit: '100mb' }));
app.get('/.well-known/apple-app-site-association',(req,res)=>{
  const aasa=fs.readFileSync(path.join(__dirname,'public','.well-known','apple-app-site-association'),'utf8');
  res.setHeader('Content-Type','application/json');
  res.end(aasa);
});
app.use(express.static(path.join(__dirname, 'public')));
['audio','videos','avatars'].forEach(d=>{const p=path.join(__dirname,d);if(!fs.existsSync(p))fs.mkdirSync(p);app.use(`/${d}`,express.static(p));});

function genId(len=12){return crypto.randomBytes(len).toString('base64url').slice(0,len);}

// ===== DB ABSTRACTION =====
const USE_PG=!!process.env.DATABASE_URL;
let db;
if(USE_PG){const{Pool}=require('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}});
db={query:async(sql,p=[])=>(await pool.query(sql,p)).rows,get:async(sql,p=[])=>(await pool.query(sql,p)).rows[0]||null,run:async(sql,p=[])=>{const isInsert=sql.trimStart().toUpperCase().startsWith('INSERT');const q=isInsert?sql+' RETURNING *':sql;const r=await pool.query(q,p);return{lastID:r.rows?.[0]?.id,rows:r.rows||[]};},exec:async sql=>pool.query(sql)};}
else{let Database;try{Database=require('better-sqlite3');}catch{console.error('better-sqlite3 not available and no DATABASE_URL set');process.exit(1);}const sq=new Database(path.join(__dirname,'swellnotes.db'));sq.pragma('journal_mode=WAL');sq.pragma('foreign_keys=ON');
db={query:async(sql,p=[])=>sq.prepare(sql.replace(/\$(\d+)/g,'?')).all(...p),get:async(sql,p=[])=>sq.prepare(sql.replace(/\$(\d+)/g,'?')).get(...p)||null,run:async(sql,p=[])=>{const r=sq.prepare(sql.replace(/\$(\d+)/g,'?').replace(/ RETURNING \*/,'')).run(...p);return{lastID:r.lastInsertRowid};},exec:async sql=>sq.exec(sql)};}

async function initDB(){
  const ts=USE_PG?'(EXTRACT(EPOCH FROM NOW())::int)':'(unixepoch())';
  const serial=USE_PG?'SERIAL PRIMARY KEY':'INTEGER PRIMARY KEY AUTOINCREMENT';

  // Execute each CREATE TABLE separately so one failure doesn't roll back others
  const tables=[
    `CREATE TABLE IF NOT EXISTS users(pubkey TEXT PRIMARY KEY,display_name TEXT,avatar_path TEXT,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS spots(id TEXT PRIMARY KEY,surfline_spot_id TEXT NOT NULL,name TEXT NOT NULL,location_text TEXT,lat REAL,lng REAL,cover_image_url TEXT,is_private INTEGER DEFAULT 1,description TEXT,region TEXT,created_by TEXT,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS spot_members(spot_id TEXT NOT NULL,pubkey TEXT NOT NULL,role TEXT DEFAULT 'member',invited_by TEXT,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(spot_id,pubkey))`,
    `CREATE TABLE IF NOT EXISTS spot_invites(id TEXT PRIMARY KEY,spot_id TEXT NOT NULL,created_by TEXT NOT NULL,max_uses INTEGER,use_count INTEGER DEFAULT 0,expires_at INTEGER,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS sessions(id ${serial},pubkey TEXT NOT NULL,spot_id TEXT,session_date TEXT NOT NULL,time_of_day TEXT NOT NULL,swells_json TEXT,surf_height_min_ft REAL,surf_height_max_ft REAL,wind_speed_mph REAL,wind_direction_deg REAL,wind_type TEXT,wind_gust_mph REAL,tide_height_ft REAL,rating INTEGER,wave_shape TEXT,session_type TEXT DEFAULT 'surfed',notes TEXT,voice_memo_path TEXT,voice_transcript TEXT,video_path TEXT,barrels INTEGER DEFAULT 0,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS comments(id ${serial},session_id INTEGER NOT NULL,pubkey TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS follows(follower_pubkey TEXT NOT NULL,followed_pubkey TEXT NOT NULL,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(follower_pubkey,followed_pubkey))`,
    `CREATE TABLE IF NOT EXISTS forecast_cache(id ${serial},spot_id TEXT,fetched_at INTEGER DEFAULT ${ts},data_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS spot_follows(pubkey TEXT NOT NULL,spot_id TEXT NOT NULL,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(pubkey,spot_id))`,
    `CREATE TABLE IF NOT EXISTS reports(id ${serial},reporter_pubkey TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT NOT NULL,reason TEXT,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS blocks(blocker_pubkey TEXT NOT NULL,blocked_pubkey TEXT NOT NULL,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(blocker_pubkey,blocked_pubkey))`,
    `CREATE TABLE IF NOT EXISTS spot_join_requests(id TEXT PRIMARY KEY,spot_id TEXT NOT NULL,pubkey TEXT NOT NULL,message TEXT,status TEXT DEFAULT 'pending',created_at INTEGER DEFAULT ${ts},resolved_by TEXT,resolved_at INTEGER)`,
  ];
  for(const sql of tables){try{await db.exec(sql);console.log('✅',sql.slice(0,60));}catch(err){console.log('⚠️ Table:',err.message?.slice(0,100));}}
  // Migrations
  try{await db.exec('ALTER TABLE sessions ADD COLUMN barrels INTEGER DEFAULT 0');}catch{}
  try{await db.exec('ALTER TABLE users ADD COLUMN is_pro INTEGER DEFAULT 0');}catch{}
  try{await db.exec('ALTER TABLE users ADD COLUMN show_pro_ring INTEGER DEFAULT 1');}catch{}
  try{await db.exec('ALTER TABLE spots ADD COLUMN description TEXT');}catch{}
  try{await db.exec('ALTER TABLE spots ADD COLUMN region TEXT');}catch{}
  try{await db.exec('ALTER TABLE users ADD COLUMN nip05 TEXT');}catch{}
  try{await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nip05 ON users(nip05) WHERE nip05 IS NOT NULL');}catch{
    try{await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nip05 ON users(nip05)');}catch{}
  }
  // Indexes for query performance
  const indexes=[
    'CREATE INDEX IF NOT EXISTS idx_sessions_pubkey ON sessions(pubkey)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_spot_id ON sessions(spot_id)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(session_date DESC)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_spot_date ON sessions(spot_id,session_date DESC)',
    'CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_pubkey)',
    'CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_pubkey)',
    'CREATE INDEX IF NOT EXISTS idx_spot_members_spot ON spot_members(spot_id)',
    'CREATE INDEX IF NOT EXISTS idx_spot_members_pubkey ON spot_members(pubkey)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_cache_spot ON forecast_cache(spot_id,fetched_at DESC)',
  ];
  for(const sql of indexes){try{await db.exec(sql);}catch{}}
  // Check what's actually in the DB
  if(USE_PG){try{const r=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");console.log('📋 Tables:',r.map(t=>t.tablename).join(', '));for(const t of r){try{const c=await db.get(`SELECT COUNT(*) as n FROM ${t.tablename}`);console.log(`  ${t.tablename}: ${c?.n||0} rows`);}catch{}}}catch(e){console.log('Table check error:',e.message);}}
  console.log(`📦 Database: ${USE_PG?'PostgreSQL':'SQLite'}, URL: ${process.env.DATABASE_URL?.slice(0,30)}...`);
}

// ===== SURFLINE =====
const HEADERS={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'};
// Surfline's API sits behind Cloudflare bot protection that fingerprints
// non-browser clients (plain Node/curl get 403). Route requests through
// curl-impersonate, which mimics a real Chrome TLS/HTTP2 fingerprint.
// Falls back to plain fetch where the binary isn't installed (e.g. local dev).
const {execFile}=require('child_process');
const CURL_IMPERSONATE=process.env.CURL_IMPERSONATE||'/opt/curl-impersonate/curl_chrome136';
const USE_IMPERSONATE=fs.existsSync(CURL_IMPERSONATE);
console.log(USE_IMPERSONATE?`🛡️  Surfline via curl-impersonate: ${CURL_IMPERSONATE}`:'⚠️  curl-impersonate not found, using plain fetch for Surfline');
function surflineFetch(url){
  if(!USE_IMPERSONATE)return fetch(url,{headers:HEADERS});
  return new Promise(resolve=>{
    execFile(CURL_IMPERSONATE,['-s','-w','\n%{http_code}',url],{maxBuffer:20*1024*1024,timeout:20000},(err,stdout)=>{
      if(err)return resolve({ok:false,status:0,statusText:err.message,json:async()=>({}),text:async()=>String(err.message||'')});
      const i=stdout.lastIndexOf('\n');
      const body=i>=0?stdout.slice(0,i):stdout;
      const code=parseInt((i>=0?stdout.slice(i+1):'').trim(),10)||0;
      resolve({ok:code>=200&&code<300,status:code,statusText:String(code),json:async()=>JSON.parse(body),text:async()=>body});
    });
  });
}
function degreesToCompass(deg){const d=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];return d[Math.round(deg/22.5)%16];}
function metersToFeet(m){return Math.round(m*3.28084*10)/10;}
function timeOfDayToHours(t){const h={'5am':[5,6],'6am':[6,7],'7am':[7,8],'8am':[8,9],'9am':[9,10],'10am':[10,11],'11am':[11,12],'12pm':[12,13],'1pm':[13,14],'2pm':[14,15],'3pm':[15,16],'4pm':[16,17],'5pm':[17,18],'6pm':[18,19]};const l={dawn:[5,7],morning:[7,10],midday:[10,13],afternoon:[13,16],evening:[16,18]};return h[t]||l[t]||[7,10];}

async function fetchSurflineData(spotId){
  const urls=[
    `https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${spotId}&days=3&intervalHours=3&units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT`,
    `https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=${spotId}&days=3&intervalHours=3&units%5BwindSpeed%5D=MPH`,
    `https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${spotId}&days=3&units%5BtideHeight%5D=FT`,
  ];
  const responses=await Promise.all(urls.map(u=>surflineFetch(u)));
  for(const r of responses){if(!r.ok)console.error('Surfline API error:',r.status,r.statusText,await r.text().catch(()=>''));}
  const[wave,wind,tides]=await Promise.all(responses.map(r=>r.ok?r.json():{}));
  const data=JSON.stringify({wave:wave.data||{wave:[]},wind:wind.data||{wind:[]},tides:tides.data||{tides:[]},utcOffset:wave.associated?.utcOffset||-6});
  try{await db.run('INSERT INTO forecast_cache(spot_id,data_json)VALUES($1,$2)',[spotId,data]);}catch(e){console.error('Cache insert error:',e.message);}
  return JSON.parse(data);
}

function findClosest(entries,ts){if(!entries?.length)return null;let c=entries[0],m=Math.abs(entries[0].timestamp-ts);for(const e of entries){const d=Math.abs(e.timestamp-ts);if(d<m){m=d;c=e;}}return c;}

function getConditions(forecast,date,tod){
  const[sh,eh]=timeOfDayToHours(tod),mid=Math.floor((sh+eh)/2),off=forecast.utcOffset||-6;
  const[y,m,d]=date.split('-').map(Number);
  const ts=Math.floor(new Date(Date.UTC(y,m-1,d,mid-off,0,0)).getTime()/1000);
  const we=findClosest(forecast.wave?.wave,ts),wi=findClosest(forecast.wind?.wind,ts),te=findClosest(forecast.tides?.tides,ts);
  const c={};
  if(we){c.surf_height_min_ft=we.surf?.min;c.surf_height_max_ft=we.surf?.max;c.swells=(we.swells||[]).filter(s=>s.height>0).map(s=>({height_ft:Math.round(s.height*10)/10,period_s:s.period,direction_deg:Math.round(s.direction),direction_compass:degreesToCompass(s.direction),impact:Math.round(s.impact*100)}));}
  if(wi){c.wind_speed_mph=Math.round(wi.speed*10)/10;c.wind_direction_deg=Math.round(wi.direction);c.wind_type=wi.directionType;c.wind_gust_mph=Math.round((wi.gust||wi.speed)*10)/10;}
  if(te)c.tide_height_ft=Math.round(te.height*10)/10;
  return c;
}

// Dedup concurrent Surfline fetches — if a fetch is already in-flight for a spot, reuse it
const inFlightFetches=new Map();
async function getForecast(spotId){
  const c=await db.get('SELECT data_json,fetched_at FROM forecast_cache WHERE spot_id=$1 ORDER BY fetched_at DESC LIMIT 1',[spotId]);
  if(c&&c.fetched_at>Math.floor(Date.now()/1000)-7200)return JSON.parse(c.data_json);
  if(inFlightFetches.has(spotId))return inFlightFetches.get(spotId);
  const p=fetchSurflineData(spotId).finally(()=>inFlightFetches.delete(spotId));
  inFlightFetches.set(spotId,p);
  return p;
}

function saveFile(base64,dir,ext){const fn=`${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;fs.writeFileSync(path.join(__dirname,dir,fn),Buffer.from(base64,'base64'));return`/${dir}/${fn}`;}

// Image upload endpoint (fallback for NIP-46 users who can't sign Blossom auth)
app.post('/api/upload',requireAuth,async(req,res)=>{
  const{base64,type}=req.body;
  if(!base64)return res.status(400).json({error:'No data'});
  const dir=type==='avatar'?'avatars':'avatars';
  const ext='jpg';
  const p=saveFile(base64,dir,ext);
  res.json({url:`https://swellnotes.com${p}`});
});

// Make media paths absolute so Capacitor local mode can resolve them
function absUrl(p,req){if(!p||p.startsWith('http'))return p;const host=req?.headers?.origin||`http://localhost:${PORT}`;return`https://swellnotes.com${p}`;}
function absSession(s,req){if(!s)return s;if(s.voice_memo_path)s.voice_memo_path=absUrl(s.voice_memo_path,req);if(s.video_path)s.video_path=absUrl(s.video_path,req);if(s.avatar_path)s.avatar_path=absUrl(s.avatar_path,req);return s;}
function absUser(u,req){if(!u)return u;if(u.avatar_path)u.avatar_path=absUrl(u.avatar_path,req);return u;}

// ===== NIP-05 =====
// Sanitize a display name into a valid NIP-05 local-part per spec: [a-z0-9-_.]
function sanitizeNip05Name(name){
  if(!name)return '';
  return String(name).toLowerCase().replace(/[^a-z0-9._-]/g,'').replace(/^[._-]+|[._-]+$/g,'').slice(0,30);
}

app.get('/.well-known/nostr.json',async(req,res)=>{
  res.set('Access-Control-Allow-Origin','*');
  const name=(req.query.name||'').toString().toLowerCase();
  if(!name||!/^[a-z0-9._-]+$/.test(name))return res.json({names:{}});
  const u=await db.get('SELECT pubkey FROM users WHERE nip05=$1',[name]);
  if(!u)return res.json({names:{}});
  res.json({names:{[name]:u.pubkey}});
});

// ===== AUTH =====
function requireAuth(req,res,next){const p=req.headers['x-nostr-pubkey'];if(!p||!/^[0-9a-f]{64}$/.test(p))return res.status(401).json({error:'Missing pubkey'});req.pubkey=p;next();}

// ===== SPOTS =====
app.get('/api/spots/search',async(req,res)=>{
  try{
    const r=await surflineFetch(`https://services.surfline.com/search/site?q=${encodeURIComponent(req.query.q||'')}&querySize=10`);
    const data=await r.json();
    const spots=(data[0]?.hits?.hits||[]).map(h=>({
      surfline_id:h._id,name:h._source.name,
      location:h._source.breadCrumbs?.join(', ')||'',
      lat:h._source.location?.lat,lng:h._source.location?.lng,
      href:h._source.href
    }));
    res.json(spots);
  }catch(err){console.error('Spot search error:',err.message||err);res.status(500).json({error:'Search failed'});}
});

app.get('/api/spots',requireAuth,async(req,res)=>{
  const spots=await db.query('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.id IN(SELECT spot_id FROM spot_members WHERE pubkey=$1) ORDER BY s.name',[req.pubkey]);
  res.json(spots);
});

app.get('/api/spots/browse',async(req,res)=>{
  const q=req.query.q;const pk=req.headers['x-nostr-pubkey']||null;
  let spots;
  if(q){spots=await db.query('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count,(SELECT MAX(created_at)FROM sessions WHERE spot_id=s.id) as last_active FROM spots s WHERE (LOWER(s.name) LIKE LOWER($1) OR LOWER(s.region) LIKE LOWER($1)) ORDER BY last_active DESC NULLS LAST',[`%${q}%`]);}
  else{spots=await db.query('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count,(SELECT MAX(created_at)FROM sessions WHERE spot_id=s.id) as last_active FROM spots s ORDER BY last_active DESC NULLS LAST');}
  // Enrich each spot with admin profiles, activity, membership status
  const now=Math.floor(Date.now()/1000);const weekAgo=now-7*86400;
  let memberSet=new Set(),followSet=new Set(),pendingSet=new Set();
  if(pk){
    const membered=await db.query('SELECT spot_id FROM spot_members WHERE pubkey=$1',[pk]);memberSet=new Set(membered.map(r=>r.spot_id));
    const followed=await db.query('SELECT spot_id FROM spot_follows WHERE pubkey=$1',[pk]);followSet=new Set(followed.map(r=>r.spot_id));
    const pending=await db.query("SELECT spot_id FROM spot_join_requests WHERE pubkey=$1 AND status='pending'",[pk]);pendingSet=new Set(pending.map(r=>r.spot_id));
  }
  const result=[];
  for(const s of spots){
    const admins=await db.query("SELECT sm.pubkey,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM spot_members sm LEFT JOIN users u ON sm.pubkey=u.pubkey WHERE sm.spot_id=$1 AND sm.role='admin'",[s.id]);
    const activity=await db.get('SELECT COUNT(*) as c FROM sessions WHERE spot_id=$1 AND created_at>$2',[s.id,weekAgo]);
    const isMember=memberSet.has(s.id);
    const out={
      id:s.id,region:s.region||null,description:s.description||null,
      cover_image_url:s.cover_image_url||null,member_count:s.member_count,
      is_private:s.is_private,is_member:isMember?1:0,is_following:followSet.has(s.id)?1:0,
      has_pending_request:pendingSet.has(s.id)?1:0,
      recent_sessions:activity?.c||0,
      admins:admins.map(a=>absUser(a,req))
    };
    // Only reveal name and surfline_spot_id to members or if public
    if(!s.is_private||isMember){out.name=s.name;out.surfline_spot_id=s.surfline_spot_id;out.location_text=s.location_text;}
    else{out.name=null;}
    result.push(out);
  }
  res.json(result);
});

app.get('/api/spots/following',requireAuth,async(req,res)=>{
  const spots=await db.query('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.id IN(SELECT spot_id FROM spot_follows WHERE pubkey=$1) ORDER BY s.name',[req.pubkey]);
  res.json(spots);
});

app.get('/api/spots/:id',async(req,res)=>{
  const spot=await db.get('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.id=$1',[req.params.id]);
  if(!spot)return res.status(404).json({error:'Not found'});
  const pk=req.headers['x-nostr-pubkey']||null;
  const isMember=pk?!!(await db.get('SELECT 1 FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,pk])):false;
  if(spot.is_private&&!isMember){
    // Non-members of private crews see limited info
    const admins=await db.query("SELECT sm.pubkey,sm.role,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM spot_members sm LEFT JOIN users u ON sm.pubkey=u.pubkey WHERE sm.spot_id=$1 AND sm.role='admin'",[req.params.id]);
    return res.json({id:spot.id,name:spot.name,region:spot.region,description:spot.description,cover_image_url:spot.cover_image_url,member_count:spot.member_count,is_private:1,members:admins.map(a=>absUser(a,req))});
  }
  const members=await db.query('SELECT sm.pubkey,sm.role,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM spot_members sm LEFT JOIN users u ON sm.pubkey=u.pubkey WHERE sm.spot_id=$1',[req.params.id]);
  res.json({...spot,members:members.map(m=>absUser(m,req))});
});

app.post('/api/spots',requireAuth,async(req,res)=>{
  const{surfline_spot_id,name,location_text,lat,lng,cover_image_url,is_private,description,region}=req.body;
  if(!surfline_spot_id||!name)return res.status(400).json({error:'Missing fields'});
  // Free users limited to 1 crew (as admin)
  const user=await db.get('SELECT is_pro FROM users WHERE pubkey=$1',[req.pubkey]);
  if(!user?.is_pro){const crews=await db.get('SELECT COUNT(*) as c FROM spots WHERE created_by=$1',[req.pubkey]);if(crews?.c>=1)return res.status(403).json({error:'pro_required',message:'Upgrade to Pro to create more crews'});}
  const id=genId();
  await db.run('INSERT INTO spots(id,surfline_spot_id,name,location_text,lat,lng,cover_image_url,is_private,description,region,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id,surfline_spot_id,name,location_text||null,lat||null,lng||null,cover_image_url||null,is_private===false?0:1,description||null,region||null,req.pubkey]);
  await db.run('INSERT INTO spot_members(spot_id,pubkey,role)VALUES($1,$2,$3)',[id,req.pubkey,'admin']);
  res.json({ok:true,id});
});

app.put('/api/spots/:id',requireAuth,async(req,res)=>{
  const member=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(!member||member.role!=='admin')return res.status(403).json({error:'Admin only'});
  const{cover_image_url,is_private,name,description,region}=req.body;
  if(cover_image_url!==undefined)await db.run('UPDATE spots SET cover_image_url=$1 WHERE id=$2',[cover_image_url,req.params.id]);
  if(is_private!==undefined)await db.run('UPDATE spots SET is_private=$1 WHERE id=$2',[is_private?1:0,req.params.id]);
  if(name)await db.run('UPDATE spots SET name=$1 WHERE id=$2',[name,req.params.id]);
  if(description!==undefined)await db.run('UPDATE spots SET description=$1 WHERE id=$2',[description,req.params.id]);
  if(region!==undefined)await db.run('UPDATE spots SET region=$1 WHERE id=$2',[region,req.params.id]);
  res.json({ok:true});
});

// Join public spot
app.post('/api/spots/:id/join',requireAuth,async(req,res)=>{
  const spot=await db.get('SELECT*FROM spots WHERE id=$1',[req.params.id]);
  if(!spot)return res.status(404).json({error:'Not found'});
  if(spot.is_private)return res.status(403).json({error:'Private spot — need invite link'});
  await db.run('INSERT INTO spot_members(spot_id,pubkey,role)VALUES($1,$2,$3)ON CONFLICT DO NOTHING',[req.params.id,req.pubkey,'member']);
  res.json({ok:true});
});

// ===== JOIN REQUESTS =====
app.post('/api/spots/:id/join-request',requireAuth,async(req,res)=>{
  const spot=await db.get('SELECT*FROM spots WHERE id=$1',[req.params.id]);
  if(!spot)return res.status(404).json({error:'Not found'});
  const member=await db.get('SELECT 1 FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(member)return res.status(400).json({error:'Already a member'});
  const existing=await db.get("SELECT 1 FROM spot_join_requests WHERE spot_id=$1 AND pubkey=$2 AND status='pending'",[req.params.id,req.pubkey]);
  if(existing)return res.status(400).json({error:'Request already pending'});
  const id=genId();
  await db.run('INSERT INTO spot_join_requests(id,spot_id,pubkey,message)VALUES($1,$2,$3,$4)',[id,req.params.id,req.pubkey,req.body.message||null]);
  res.json({ok:true,id});
});

app.get('/api/spots/:id/join-requests',requireAuth,async(req,res)=>{
  const member=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(!member||member.role!=='admin')return res.status(403).json({error:'Admin only'});
  const requests=await db.query("SELECT jr.*,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM spot_join_requests jr LEFT JOIN users u ON jr.pubkey=u.pubkey WHERE jr.spot_id=$1 AND jr.status='pending' ORDER BY jr.created_at DESC",[req.params.id]);
  res.json(requests.map(r=>absUser(r,req)));
});

app.put('/api/spots/:id/join-requests/:requestId',requireAuth,async(req,res)=>{
  const member=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(!member||member.role!=='admin')return res.status(403).json({error:'Admin only'});
  const jr=await db.get('SELECT*FROM spot_join_requests WHERE id=$1 AND spot_id=$2',[req.params.requestId,req.params.id]);
  if(!jr)return res.status(404).json({error:'Not found'});
  const{status}=req.body;
  if(!['approved','denied'].includes(status))return res.status(400).json({error:'Invalid status'});
  const now=Math.floor(Date.now()/1000);
  await db.run('UPDATE spot_join_requests SET status=$1,resolved_by=$2,resolved_at=$3 WHERE id=$4',[status,req.pubkey,now,jr.id]);
  if(status==='approved')await db.run('INSERT INTO spot_members(spot_id,pubkey,role)VALUES($1,$2,$3)ON CONFLICT DO NOTHING',[req.params.id,jr.pubkey,'member']);
  res.json({ok:true});
});

// ===== INVITES =====
app.post('/api/spots/:id/invites',requireAuth,async(req,res)=>{
  const member=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(!member||member.role!=='admin')return res.status(403).json({error:'Admin only'});
  const id=genId(8);
  const maxUses=req.body.max_uses||null;
  const expiresAt=req.body.expires_hours?Math.floor(Date.now()/1000)+req.body.expires_hours*3600:null;
  await db.run('INSERT INTO spot_invites(id,spot_id,created_by,max_uses,expires_at)VALUES($1,$2,$3,$4,$5)',[id,req.params.id,req.pubkey,maxUses,expiresAt]);
  const origin=req.headers.origin;
  const base=(origin&&origin.startsWith('http'))?origin:'https://swellnotes.com';
  res.json({ok:true,invite_code:id,link:`${base}/join/${id}`});
});

app.get('/api/invite/:code',async(req,res)=>{
  const inv=await db.get('SELECT i.*,s.name as spot_name,s.cover_image_url,s.location_text,(SELECT COUNT(*)FROM spot_members WHERE spot_id=i.spot_id) as member_count FROM spot_invites i LEFT JOIN spots s ON i.spot_id=s.id WHERE i.id=$1',[req.params.code]);
  if(!inv)return res.status(404).json({error:'Invalid invite'});
  if(inv.expires_at&&inv.expires_at<Math.floor(Date.now()/1000))return res.status(410).json({error:'Invite expired'});
  if(inv.max_uses&&inv.use_count>=inv.max_uses)return res.status(410).json({error:'Invite used up'});
  res.json({spot_id:inv.spot_id,spot_name:inv.spot_name,cover_image_url:inv.cover_image_url,location_text:inv.location_text,member_count:inv.member_count});
});

app.post('/api/invite/:code/claim',requireAuth,async(req,res)=>{
  const inv=await db.get('SELECT*FROM spot_invites WHERE id=$1',[req.params.code]);
  if(!inv)return res.status(404).json({error:'Invalid invite'});
  if(inv.expires_at&&inv.expires_at<Math.floor(Date.now()/1000))return res.status(410).json({error:'Expired'});
  if(inv.max_uses&&inv.use_count>=inv.max_uses)return res.status(410).json({error:'Used up'});
  await db.run('INSERT INTO spot_members(spot_id,pubkey,role,invited_by)VALUES($1,$2,$3,$4)ON CONFLICT DO NOTHING',[inv.spot_id,req.pubkey,'member',inv.created_by]);
  await db.run('UPDATE spot_invites SET use_count=use_count+1 WHERE id=$1',[req.params.code]);
  res.json({ok:true,spot_id:inv.spot_id});
});

// ===== SPOT FOLLOW =====
app.post('/api/spots/:id/follow',requireAuth,async(req,res)=>{
  const spot=await db.get('SELECT*FROM spots WHERE id=$1',[req.params.id]);
  if(!spot)return res.status(404).json({error:'Not found'});
  if(spot.is_private)return res.status(403).json({error:'Cannot follow private spot'});
  await db.run('INSERT INTO spot_follows(pubkey,spot_id)VALUES($1,$2)ON CONFLICT DO NOTHING',[req.pubkey,req.params.id]);
  res.json({ok:true});
});

app.delete('/api/spots/:id/follow',requireAuth,async(req,res)=>{
  await db.run('DELETE FROM spot_follows WHERE pubkey=$1 AND spot_id=$2',[req.pubkey,req.params.id]);
  res.json({ok:true});
});

// ===== MULTI-SPOT FEED =====
app.get('/api/feed',requireAuth,async(req,res)=>{
  const{swell_dir,month,limit=10}=req.query;
  // Get all spot IDs: member spots + followed spots
  const memberSpots=await db.query('SELECT spot_id FROM spot_members WHERE pubkey=$1',[req.pubkey]);
  const followedSpots=await db.query('SELECT spot_id FROM spot_follows WHERE pubkey=$1',[req.pubkey]);
  const allIds=[...new Set([...memberSpots.map(r=>r.spot_id),...followedSpots.map(r=>r.spot_id)])];
  if(!allIds.length)return res.json([]);
  // Get spot details
  const spotDetails=await db.query(`SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.id IN(${allIds.map((_,i)=>`$${i+1}`).join(',')})`,allIds);
  // For each spot, get recent sessions
  const result=[];
  for(const spot of spotDetails.sort((a,b)=>a.name.localeCompare(b.name))){
    let w=['s.spot_id=$1'],p=[spot.id],n=2;
    if(month){w.push(`substring(session_date,1,7)=$${n++}`);p.push(month);}
    if(swell_dir){w.push(`swells_json LIKE $${n++}`);p.push(`%"direction_compass":"${swell_dir}"%`);}
    const wc='WHERE '+w.join(' AND ');
    const sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring,COALESCE(bst.tb,0) as total_barrels FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey LEFT JOIN (SELECT pubkey,SUM(barrels) as tb FROM sessions GROUP BY pubkey) bst ON bst.pubkey=s.pubkey ${wc} ORDER BY s.session_date DESC,s.created_at DESC LIMIT $${n++}`,[...p,+limit]);
    if(sessions.length)result.push({spot:{id:spot.id,name:spot.name,location_text:spot.location_text,cover_image_url:spot.cover_image_url,member_count:spot.member_count},sessions:sessions.map(s=>absSession(s,req))});
  }
  res.json(result);
});

// ===== CONDITIONS (spot-aware) =====
app.get('/api/conditions',async(req,res)=>{
  try{
    const spotId=req.query.spot_id;
    let surflineSpotId='5842041f4e65fad6a7708b9c'; // default Dominical
    if(spotId){
      const spot=await db.get('SELECT surfline_spot_id,is_private FROM spots WHERE id=$1',[spotId]);
      if(spot){
        // Privacy: don't serve conditions for private spots to non-members
        if(spot.is_private){
          const pk=req.headers['x-nostr-pubkey']||null;
          if(!pk)return res.status(403).json({error:'Private crew'});
          const mem=await db.get('SELECT 1 FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[spotId,pk]);
          if(!mem)return res.status(403).json({error:'Private crew'});
        }
        surflineSpotId=spot.surfline_spot_id;
      }
    }
    else if(req.query.surfline_spot_id)surflineSpotId=req.query.surfline_spot_id;
    const forecast=await getForecast(surflineSpotId);
    res.json(getConditions(forecast,req.query.date||new Date().toISOString().split('T')[0],req.query.time_of_day||'morning'));
  }catch(err){console.error('Conditions error:',err.message||err);res.status(500).json({error:'Failed to fetch conditions'});}
});

// ===== NIP-46 =====
app.get('/api/nip46/init',async(req,res)=>{try{const{generateSecretKey,getPublicKey}=await import('nostr-tools');const sk=generateSecretKey();const secretKey=Buffer.from(sk).toString('hex');const publicKey=getPublicKey(sk);const rh=crypto.randomBytes(16).toString('hex');const secret=`sec-${rh.slice(0,8)}-${rh.slice(8,12)}-${rh.slice(12,16)}-${rh.slice(16,20)}-${rh.slice(20,32)}`;const relay='wss://relay.primal.net';const p=new URLSearchParams();p.append('relay',relay);p.append('secret',secret);p.append('name','Swellnotes');p.append('url',req.query.origin||`http://localhost:${PORT}`);p.append('image','https://swellnotes.com/sn-logo.png');const qrURI=`nostrconnect://${publicKey}?${p.toString()}`;const cp=new URLSearchParams(p);const callbackBase=req.query.platform==='ios'?'swellnotes://login-callback':`${req.query.origin||`http://localhost:${PORT}`}/login-callback`;cp.append('callback',callbackBase);res.json({secretKey,publicKey,secret,relay,qrDataUrl:await QRCode.toDataURL(qrURI,{width:280,margin:2}),qrURI,mobileURI:`nostrconnect://${publicKey}?${cp.toString()}`});}catch(err){console.error('NIP-46 init error:',err);res.status(500).json({error:'NIP-46 init failed: '+(err.message||'unknown')});}});

// ===== AUTH =====
// Pro subscription
app.get('/api/pro/status',requireAuth,async(req,res)=>{
  const user=await db.get('SELECT is_pro,show_pro_ring FROM users WHERE pubkey=$1',[req.pubkey]);
  res.json({isPro:!!(user?.is_pro),showRing:user?.show_pro_ring??1});
});
app.post('/api/pro/ring',requireAuth,async(req,res)=>{
  const show=req.body.show?1:0;
  await db.run('UPDATE users SET show_pro_ring=$1 WHERE pubkey=$2',[show,req.pubkey]);
  res.json({ok:true,showRing:show});
});
app.post('/api/pro/activate',requireAuth,async(req,res)=>{
  // Called from client after StoreKit verifies the purchase
  await db.run('UPDATE users SET is_pro=1 WHERE pubkey=$1',[req.pubkey]);
  res.json({ok:true,isPro:true});
});
app.post('/api/pro/deactivate',requireAuth,async(req,res)=>{
  await db.run('UPDATE users SET is_pro=0 WHERE pubkey=$1',[req.pubkey]);
  res.json({ok:true,isPro:false});
});

app.post('/api/auth/login',async(req,res)=>{
  try{
    const{pubkey,display_name,avatar_base64,avatar_url}=req.body;
    if(!pubkey||!/^[0-9a-f]{64}$/.test(pubkey))return res.status(400).json({error:'Invalid pubkey'});
    let avatarPath=avatar_url||null;
    if(!avatarPath&&avatar_base64)avatarPath=saveFile(avatar_base64,'avatars','jpg');
    // Use separate INSERT and UPDATE to avoid Postgres parameter conflicts
    const existing=await db.get('SELECT pubkey FROM users WHERE pubkey=$1',[pubkey]);
    if(existing){
      // Existing users: update display_name and avatar only. NIP-05 is immutable once claimed.
      if(avatarPath)await db.run('UPDATE users SET display_name=$1,avatar_path=$2 WHERE pubkey=$3',[display_name||'Anon',avatarPath,pubkey]);
      else await db.run('UPDATE users SET display_name=$1 WHERE pubkey=$2',[display_name||'Anon',pubkey]);
    }else{
      // New user: try to claim a NIP-05 handle derived from the display name.
      const nip05Name=sanitizeNip05Name(display_name);
      let nip05=null;
      if(nip05Name){
        const taken=await db.get('SELECT pubkey FROM users WHERE nip05=$1',[nip05Name]);
        if(taken)return res.status(409).json({error:'name_taken',message:'That name is already taken. Please pick another.'});
        nip05=nip05Name;
      }
      if(avatarPath)await db.run('INSERT INTO users(pubkey,display_name,avatar_path,nip05)VALUES($1,$2,$3,$4)',[pubkey,display_name||'Anon',avatarPath,nip05]);
      else await db.run('INSERT INTO users(pubkey,display_name,nip05)VALUES($1,$2,$3)',[pubkey,display_name||'Anon',nip05]);
    }
    const user=await db.get('SELECT*FROM users WHERE pubkey=$1',[pubkey]);
    const host=req.headers.host||`localhost:${PORT}`;
    res.json({ok:true,...user,nip05_full:user.nip05?`${user.nip05}@${host}`:null});
  }catch(err){console.error('Login error:',err);res.status(500).json({error:'Login failed'});}
});

app.get('/api/users',async(req,res)=>{
  const{spot_id:spotId,sort,crew_id}=req.query;
  let users;
  // Use JOIN with pre-aggregated stats instead of correlated subqueries
  const statsQ='(SELECT pubkey,COUNT(*) as session_count,COALESCE(SUM(barrels),0) as total_barrels,MAX(created_at) as last_active FROM sessions GROUP BY pubkey) st';
  if(spotId){
    const spotStatsQ='(SELECT pubkey,COUNT(*) as spot_sessions FROM sessions WHERE spot_id=$1 GROUP BY pubkey) ss';
    users=await db.query(`SELECT u.pubkey,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring,sm.role,COALESCE(ss.spot_sessions,0) as session_count,COALESCE(st.total_barrels,0) as total_barrels FROM spot_members sm LEFT JOIN users u ON sm.pubkey=u.pubkey LEFT JOIN ${statsQ} ON st.pubkey=u.pubkey LEFT JOIN ${spotStatsQ} ON ss.pubkey=u.pubkey WHERE sm.spot_id=$2 ORDER BY session_count DESC`,[spotId,spotId]);
  } else if(crew_id){
    users=await db.query(`SELECT u.pubkey,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring,sm.role,COALESCE(st.session_count,0) as session_count,COALESCE(st.total_barrels,0) as total_barrels,st.last_active FROM spot_members sm LEFT JOIN users u ON sm.pubkey=u.pubkey LEFT JOIN ${statsQ} ON st.pubkey=u.pubkey WHERE sm.spot_id=$1 ORDER BY st.last_active DESC NULLS LAST`,[crew_id]);
  } else if(sort==='recent'){
    users=await db.query(`SELECT u.pubkey,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring,COALESCE(st.session_count,0) as session_count,COALESCE(st.total_barrels,0) as total_barrels,st.last_active FROM users u INNER JOIN ${statsQ} ON st.pubkey=u.pubkey ORDER BY st.last_active DESC NULLS LAST`);
  } else {
    users=await db.query(`SELECT u.pubkey,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring,COALESCE(st.session_count,0) as session_count,COALESCE(st.total_barrels,0) as total_barrels FROM users u LEFT JOIN ${statsQ} ON st.pubkey=u.pubkey ORDER BY session_count DESC`);
  }
  res.json(users.map(u=>absUser(u,req)));
});
app.get('/api/users/:pubkey',async(req,res)=>{const u=await db.get('SELECT*FROM users WHERE pubkey=$1',[req.params.pubkey]);if(!u)return res.status(404).json({error:'Not found'});const c=await db.get('SELECT COUNT(*) as c,COALESCE(SUM(barrels),0) as b FROM sessions WHERE pubkey=$1',[req.params.pubkey]);res.json(absUser({...u,session_count:c?.c||0,total_barrels:c?.b||0},req));});

// Delete the authenticated user's account and all associated data.
app.delete('/api/users',requireAuth,async(req,res)=>{
  try{
    const pk=req.pubkey;
    const user=await db.get('SELECT avatar_path FROM users WHERE pubkey=$1',[pk]);
    if(!user)return res.status(404).json({error:'Not found'});
    const mediaRows=await db.query('SELECT voice_memo_path,video_path FROM sessions WHERE pubkey=$1',[pk]);
    const filesToRemove=[];
    if(user.avatar_path)filesToRemove.push(user.avatar_path);
    for(const r of mediaRows){if(r.voice_memo_path)filesToRemove.push(r.voice_memo_path);if(r.video_path)filesToRemove.push(r.video_path);}
    filesToRemove.forEach(p=>{if(p&&p.startsWith('/'))try{fs.unlinkSync(path.join(__dirname,p));}catch{}});
    await db.run('DELETE FROM comments WHERE pubkey=$1',[pk]);
    await db.run('DELETE FROM sessions WHERE pubkey=$1',[pk]);
    await db.run('DELETE FROM follows WHERE follower_pubkey=$1 OR followed_pubkey=$2',[pk,pk]);
    await db.run('DELETE FROM spot_follows WHERE pubkey=$1',[pk]);
    await db.run('DELETE FROM spot_members WHERE pubkey=$1',[pk]);
    await db.run('DELETE FROM blocks WHERE blocker_pubkey=$1 OR blocked_pubkey=$2',[pk,pk]);
    await db.run('DELETE FROM spot_join_requests WHERE pubkey=$1',[pk]);
    await db.run('DELETE FROM reports WHERE reporter_pubkey=$1',[pk]);
    await db.run('DELETE FROM users WHERE pubkey=$1',[pk]);
    res.json({ok:true});
  }catch(err){logError('Account delete failed: '+err.message);res.status(500).json({error:'Delete failed'});}
});

// ===== FOLLOWS =====
app.get('/api/follows',requireAuth,async(req,res)=>{
  res.json({following:await db.query('SELECT f.followed_pubkey as pubkey,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring,(SELECT COUNT(*)FROM sessions WHERE pubkey=f.followed_pubkey) as session_count FROM follows f LEFT JOIN users u ON f.followed_pubkey=u.pubkey WHERE f.follower_pubkey=$1',[req.pubkey]),
    followers:await db.query('SELECT f.follower_pubkey as pubkey,u.display_name FROM follows f LEFT JOIN users u ON f.follower_pubkey=u.pubkey WHERE f.followed_pubkey=$1',[req.pubkey])});
});
app.post('/api/follows/:pubkey',requireAuth,async(req,res)=>{if(req.params.pubkey===req.pubkey)return res.status(400).json({error:'Cannot follow yourself'});await db.run('INSERT INTO follows(follower_pubkey,followed_pubkey)VALUES($1,$2)ON CONFLICT DO NOTHING',[req.pubkey,req.params.pubkey]);res.json({ok:true});});
app.delete('/api/follows/:pubkey',requireAuth,async(req,res)=>{await db.run('DELETE FROM follows WHERE follower_pubkey=$1 AND followed_pubkey=$2',[req.pubkey,req.params.pubkey]);res.json({ok:true});});

// Admin: change member role
app.put('/api/spots/:id/members/:pubkey',requireAuth,async(req,res)=>{
  const mem=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(!mem||mem.role!=='admin')return res.status(403).json({error:'Admin only'});
  const{role}=req.body;if(!['admin','member'].includes(role))return res.status(400).json({error:'Invalid role'});
  await db.run('UPDATE spot_members SET role=$1 WHERE spot_id=$2 AND pubkey=$3',[role,req.params.id,req.params.pubkey]);
  res.json({ok:true});
});

async function getFeedPubkeys(pk){const rows=await db.query('SELECT followed_pubkey FROM follows WHERE follower_pubkey=$1',[pk]);return[pk,...rows.map(r=>r.followed_pubkey)];}

// ===== SESSIONS (spot-aware) =====
app.get('/api/sessions',async(req,res)=>{
  const{limit=50,offset=0,month,swell_dir,feed_for,pubkey:fp,spot_id}=req.query;let w=[],p=[],n=1;
  const pk=req.headers['x-nostr-pubkey']||null;
  // Privacy: if requesting a specific private spot, verify membership
  if(spot_id){
    const spot=await db.get('SELECT is_private FROM spots WHERE id=$1',[spot_id]);
    if(spot&&spot.is_private){
      if(!pk)return res.json({sessions:[],total:0});
      const mem=await db.get('SELECT 1 FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[spot_id,pk]);
      if(!mem)return res.json({sessions:[],total:0});
    }
    w.push(`s.spot_id=$${n++}`);p.push(spot_id);
  }else{
    // Filter out sessions from private spots the user isn't a member of
    if(pk){
      const memberSpotIds=await db.query('SELECT spot_id FROM spot_members WHERE pubkey=$1',[pk]);
      const mset=memberSpotIds.map(r=>r.spot_id);
      if(mset.length){w.push(`(s.spot_id IS NULL OR s.spot_id IN(${mset.map(()=>`$${n++}`).join(',')}) OR s.spot_id IN(SELECT id FROM spots WHERE is_private=0))`);p.push(...mset);}
      else{w.push(`(s.spot_id IS NULL OR s.spot_id IN(SELECT id FROM spots WHERE is_private=0))`);}
    }else{
      w.push(`(s.spot_id IS NULL OR s.spot_id IN(SELECT id FROM spots WHERE is_private=0))`);
    }
  }
  if(feed_for){const pks=await getFeedPubkeys(feed_for);w.push(`s.pubkey IN(${pks.map(()=>`$${n++}`).join(',')})`);p.push(...pks);}
  if(fp){w.push(`s.pubkey=$${n++}`);p.push(fp);}
  if(month){w.push(`substring(session_date,1,7)=$${n++}`);p.push(month);}
  if(swell_dir){w.push(`swells_json LIKE $${n++}`);p.push(`%"direction_compass":"${swell_dir}"%`);}
  const wc=w.length?'WHERE '+w.join(' AND '):'';
  const sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring,COALESCE(bst.tb,0) as total_barrels FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey LEFT JOIN (SELECT pubkey,SUM(barrels) as tb FROM sessions GROUP BY pubkey) bst ON bst.pubkey=s.pubkey ${wc} ORDER BY s.session_date DESC,s.created_at DESC LIMIT $${n++} OFFSET $${n++}`,[...p,+limit,+offset]);
  const total=await db.get(`SELECT COUNT(*) as count FROM sessions s ${wc}`,p);
  res.json({sessions:sessions.map(s=>absSession(s,req)),total:total?.count||0});
});

app.get('/api/sessions/:id',async(req,res)=>{
  const s=await db.get('SELECT s.*,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.id=$1',[req.params.id]);
  if(!s)return res.status(404).json({error:'Not found'});
  const comments=await db.query('SELECT c.*,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM comments c LEFT JOIN users u ON c.pubkey=u.pubkey WHERE c.session_id=$1 ORDER BY c.created_at ASC',[req.params.id]);
  res.json({session:absSession(s,req),comments:comments.map(c=>absUser(c,req))});
});

app.post('/api/sessions',requireAuth,async(req,res)=>{
  const b=req.body;let c={};
  // Get surfline spot ID from spot
  let surflineSpotId='5842041f4e65fad6a7708b9c';
  if(b.spot_id){const spot=await db.get('SELECT surfline_spot_id FROM spots WHERE id=$1',[b.spot_id]);if(spot)surflineSpotId=spot.surfline_spot_id;}
  try{c=getConditions(await getForecast(surflineSpotId),b.session_date,b.time_of_day);}catch{}
  let voicePath=b.voice_url||null,videoPath=b.video_url||null;
  if(!voicePath&&b.voice_memo_base64)voicePath=saveFile(b.voice_memo_base64,'audio',b.voice_ext||'webm');
  if(!videoPath&&b.video_base64)videoPath=saveFile(b.video_base64,'videos','mp4');
  const r=await db.run('INSERT INTO sessions(pubkey,spot_id,session_date,time_of_day,swells_json,surf_height_min_ft,surf_height_max_ft,wind_speed_mph,wind_direction_deg,wind_type,wind_gust_mph,tide_height_ft,rating,wave_shape,session_type,notes,voice_memo_path,voice_transcript,video_path,barrels)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)',
    [req.pubkey,b.spot_id||null,b.session_date,b.time_of_day,JSON.stringify(c.swells||[]),c.surf_height_min_ft??null,c.surf_height_max_ft??null,c.wind_speed_mph??null,c.wind_direction_deg??null,c.wind_type??null,c.wind_gust_mph??null,c.tide_height_ft??null,b.rating,b.wave_shape||null,b.session_type||'surfed',b.notes||null,voicePath,b.voice_transcript||null,videoPath,b.barrels||0]);
  res.json({ok:true,id:r.lastID,conditions:c});
});

app.delete('/api/sessions/:id',requireAuth,async(req,res)=>{
  const s=await db.get('SELECT pubkey,spot_id,voice_memo_path,video_path FROM sessions WHERE id=$1',[req.params.id]);
  if(!s)return res.status(404).json({error:'Not found'});
  // Allow delete if: own session OR admin of the spot
  let allowed=s.pubkey===req.pubkey;
  if(!allowed&&s.spot_id){const mem=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[s.spot_id,req.pubkey]);if(mem?.role==='admin')allowed=true;}
  if(!allowed)return res.status(403).json({error:'Forbidden'});
  [s.voice_memo_path,s.video_path].forEach(p=>{if(p&&p.startsWith('/'))try{fs.unlinkSync(path.join(__dirname,p));}catch{}});
  await db.run('DELETE FROM sessions WHERE id=$1',[req.params.id]);res.json({ok:true});
});

app.post('/api/sessions/:id/comments',requireAuth,async(req,res)=>{
  if(!req.body.body?.trim())return res.status(400).json({error:'Empty'});
  if(!await db.get('SELECT id FROM sessions WHERE id=$1',[req.params.id]))return res.status(404).json({error:'Not found'});
  await db.run('INSERT INTO comments(session_id,pubkey,body)VALUES($1,$2,$3)',[req.params.id,req.pubkey,req.body.body.trim()]);res.json({ok:true});
});

// ===== SEARCH (spot-aware) =====
app.get('/api/search',async(req,res)=>{
  const{pubkey,spot_id,dir_min,dir_max,height_min,height_max,period_min,period_max,rating_min,rating_max,date_from,date_to}=req.query;
  let sessions;
  const safeSpotId=spot_id?.replace(/[^a-zA-Z0-9_-]/g,'')||null;
  if(pubkey){const pks=await getFeedPubkeys(pubkey);let n=pks.length+1;const ph=pks.map((_,i)=>`$${i+1}`).join(',');const spotClause=safeSpotId?` AND s.spot_id=$${n}`:'';const params=[...pks];if(safeSpotId)params.push(safeSpotId);sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.pubkey IN(${ph})${spotClause} ORDER BY s.session_date DESC`,params);}
  else sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path,u.is_pro,u.show_pro_ring FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ${baseWhere} ORDER BY s.session_date DESC`);
  const results=sessions.filter(s=>{const swells=JSON.parse(s.swells_json||'[]');if(!swells.length)return false;if(dir_min||dir_max){const dmin=parseFloat(dir_min)||0,dmax=parseFloat(dir_max)||360;if(!swells.some(sw=>sw.direction_deg>=dmin&&sw.direction_deg<=dmax))return false;}if(height_min&&swells[0].height_ft<parseFloat(height_min))return false;if(height_max&&swells[0].height_ft>parseFloat(height_max))return false;if(period_min&&swells[0].period_s<parseFloat(period_min))return false;if(period_max&&swells[0].period_s>parseFloat(period_max))return false;if(rating_min&&(s.rating||0)<parseInt(rating_min))return false;if(rating_max&&(s.rating||0)>parseInt(rating_max))return false;if(date_from&&s.session_date<date_from)return false;if(date_to&&s.session_date>date_to)return false;return true;});
  const ratings=results.filter(s=>s.rating).map(s=>s.rating);
  res.json({sessions:results.slice(0,100).map(s=>absSession(s,req)),summary:{count:results.length,avg_rating:ratings.length?Math.round(ratings.reduce((a,b)=>a+b,0)/ratings.length*10)/10:null,best_rating:ratings.length?Math.max(...ratings):null,worst_rating:ratings.length?Math.min(...ratings):null}});
});

// ===== ANALYSIS (spot-aware) =====
async function getAnalysisSessions(pk,spotId){
  const safeSpot=spotId?.replace(/[^a-zA-Z0-9_-]/g,'')||null;let extra=safeSpot?` AND spot_id='${safeSpot}'`:'';
  if(!pk)return await db.query(`SELECT*FROM sessions WHERE swells_json IS NOT NULL AND rating IS NOT NULL${extra}`);
  const pks=await getFeedPubkeys(pk);const ph=pks.map((_,i)=>`$${i+1}`).join(',');
  return await db.query(`SELECT*FROM sessions WHERE pubkey IN(${ph})AND swells_json IS NOT NULL AND rating IS NOT NULL${extra}`,pks);
}

app.get('/api/analysis/forecast-match',async(req,res)=>{
  const{spot_id}=req.query;
  if(!spot_id)return res.status(400).json({error:'spot_id required'});
  const spot=await db.get('SELECT surfline_spot_id FROM spots WHERE id=$1',[spot_id]);
  if(!spot)return res.status(404).json({error:'Spot not found'});
  try{
    const forecast=await getForecast(spot.surfline_spot_id);
    const off=forecast.utcOffset||-6;
    // Get all sessions at this spot with swell data
    const sessions=await db.query('SELECT id,session_date,time_of_day,rating,swells_json,wind_type,surf_height_min_ft,surf_height_max_ft,barrels,pubkey FROM sessions WHERE spot_id=$1 AND swells_json IS NOT NULL AND rating IS NOT NULL',[spot_id]);
    // Build forecast time slots for next 3 days, every 3 hours during daylight
    const now=new Date();const slots=[];
    for(let d=0;d<3;d++){
      const day=new Date(now);day.setDate(day.getDate()+d);
      const dateStr=day.toISOString().split('T')[0];
      const dayLabel=d===0?'Today':d===1?'Tomorrow':day.toLocaleDateString('en',{weekday:'long'});
      for(const tod of['6am','5pm']){
        const c=getConditions(forecast,dateStr,tod);
        if(!c.swells?.length)continue;
        const primary=c.swells[0];
        // Match tolerances — consider primary AND secondary swell, with direction, height, AND period
        const DIR_TOL=3,HEIGHT_TOL=0.5,PERIOD_TOL=1.5;
        const swellMatch=(a,b)=>{let dd=Math.abs(a.direction_deg-b.direction_deg);if(dd>180)dd=360-dd;return dd<=DIR_TOL&&Math.abs(a.height_ft-b.height_ft)<=HEIGHT_TOL&&Math.abs(a.period_s-b.period_s)<=PERIOD_TOL;};
        const forecastSwells=c.swells.slice(0,2); // primary + secondary
        const matches=[];
        for(const s of sessions){
          const sw=JSON.parse(s.swells_json);if(!sw.length)continue;
          // Every forecast swell (primary + secondary) must find a matching session swell
          const allMatched=forecastSwells.every(fs=>sw.some(ss=>swellMatch(fs,ss)));
          if(!allMatched)continue;
          matches.push({id:s.id,rating:s.rating,date:s.session_date,time:s.time_of_day,
            swell_height:sw[0].height_ft,swell_dir:sw[0].direction_deg,swell_compass:sw[0].direction_compass,
            wind_type:s.wind_type,barrels:s.barrels||0,pubkey:s.pubkey});
        }
        const ratings=matches.map(m=>m.rating);
        const avg=ratings.length?Math.round(ratings.reduce((a,b)=>a+b,0)/ratings.length*10)/10:null;
        slots.push({
          day:dayLabel,date:dateStr,time:tod,
          swell:{height_ft:primary.height_ft,period_s:primary.period_s,direction_deg:primary.direction_deg,direction_compass:primary.direction_compass},
          wind:{speed_mph:c.wind_speed_mph,type:c.wind_type},
          surf:{min_ft:c.surf_height_min_ft,max_ft:c.surf_height_max_ft},
          match_count:matches.length,
          avg_rating:avg,
          best_rating:ratings.length?Math.max(...ratings):null,
          worst_rating:ratings.length?Math.min(...ratings):null,
          sessions:matches.sort((a,b)=>b.rating-a.rating).slice(0,10)
        });
      }
    }
    res.json(slots);
  }catch(err){console.error('Forecast match error:',err);res.status(500).json({error:'Failed'});}
});

// ===== REPORT & BLOCK =====
app.post('/api/report',requireAuth,async(req,res)=>{
  const{target_type,target_id,reason}=req.body;
  if(!target_type||!target_id)return res.status(400).json({error:'Missing fields'});
  if(!['session','comment','user'].includes(target_type))return res.status(400).json({error:'Invalid type'});
  await db.run('INSERT INTO reports(reporter_pubkey,target_type,target_id,reason)VALUES($1,$2,$3,$4)',[req.pubkey,target_type,target_id,reason||null]);
  res.json({ok:true});
});
app.post('/api/blocks/:pubkey',requireAuth,async(req,res)=>{
  if(req.params.pubkey===req.pubkey)return res.status(400).json({error:'Cannot block yourself'});
  await db.run('INSERT INTO blocks(blocker_pubkey,blocked_pubkey)VALUES($1,$2)ON CONFLICT DO NOTHING',[req.pubkey,req.params.pubkey]);
  res.json({ok:true});
});
app.delete('/api/blocks/:pubkey',requireAuth,async(req,res)=>{
  await db.run('DELETE FROM blocks WHERE blocker_pubkey=$1 AND blocked_pubkey=$2',[req.pubkey,req.params.pubkey]);
  res.json({ok:true});
});
app.get('/api/blocks',requireAuth,async(req,res)=>{
  const blocks=await db.query('SELECT blocked_pubkey FROM blocks WHERE blocker_pubkey=$1',[req.pubkey]);
  res.json(blocks.map(b=>b.blocked_pubkey));
});

app.get('/api/debug',async(req,res)=>{try{if(USE_PG){const tables=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");const counts={};for(const t of tables){try{const c=await db.get(`SELECT COUNT(*) as n FROM ${t.tablename}`);counts[t.tablename]=+(c?.n||0);}catch{counts[t.tablename]='error';}}res.json({use_pg:true,db_url:process.env.DATABASE_URL?.slice(0,40)+'...',tables:counts});}else{res.json({use_pg:false});}}catch(err){res.json({error:err.message});}});
app.get('/login-callback',(req,res)=>res.sendFile(path.join(__dirname,'public','login-callback.html')));
app.get('/join/:code',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
initDB().then(()=>app.listen(PORT,()=>console.log(`🏄 Swellnotes running at http://localhost:${PORT}`))).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
