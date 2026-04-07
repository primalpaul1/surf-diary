const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const crypto = require('crypto');
if(!globalThis.crypto)globalThis.crypto={};
if(!globalThis.crypto.getRandomValues)globalThis.crypto.getRandomValues=b=>{const r=crypto.randomBytes(b.length);b.set(r);return b;};

const app = express();
const PORT = process.env.PORT || 3000;
app.use((req,res,next)=>{const origin=req.headers.origin;if(origin==='capacitor://localhost'||origin==='ionic://localhost'){res.header('Access-Control-Allow-Origin',origin);res.header('Access-Control-Allow-Headers','Content-Type,X-Nostr-Pubkey');res.header('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(204);}next();});
app.use(express.json({ limit: '100mb' }));
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
    `CREATE TABLE IF NOT EXISTS spots(id TEXT PRIMARY KEY,surfline_spot_id TEXT NOT NULL,name TEXT NOT NULL,location_text TEXT,lat REAL,lng REAL,cover_image_url TEXT,is_private INTEGER DEFAULT 0,created_by TEXT,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS spot_members(spot_id TEXT NOT NULL,pubkey TEXT NOT NULL,role TEXT DEFAULT 'member',invited_by TEXT,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(spot_id,pubkey))`,
    `CREATE TABLE IF NOT EXISTS spot_invites(id TEXT PRIMARY KEY,spot_id TEXT NOT NULL,created_by TEXT NOT NULL,max_uses INTEGER,use_count INTEGER DEFAULT 0,expires_at INTEGER,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS sessions(id ${serial},pubkey TEXT NOT NULL,spot_id TEXT,session_date TEXT NOT NULL,time_of_day TEXT NOT NULL,swells_json TEXT,surf_height_min_ft REAL,surf_height_max_ft REAL,wind_speed_mph REAL,wind_direction_deg REAL,wind_type TEXT,wind_gust_mph REAL,tide_height_ft REAL,rating INTEGER,wave_shape TEXT,session_type TEXT DEFAULT 'surfed',notes TEXT,voice_memo_path TEXT,voice_transcript TEXT,video_path TEXT,barrels INTEGER DEFAULT 0,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS comments(id ${serial},session_id INTEGER NOT NULL,pubkey TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS follows(follower_pubkey TEXT NOT NULL,followed_pubkey TEXT NOT NULL,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(follower_pubkey,followed_pubkey))`,
    `CREATE TABLE IF NOT EXISTS forecast_cache(id ${serial},spot_id TEXT,fetched_at INTEGER DEFAULT ${ts},data_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS spot_follows(pubkey TEXT NOT NULL,spot_id TEXT NOT NULL,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(pubkey,spot_id))`,
    `CREATE TABLE IF NOT EXISTS reports(id ${serial},reporter_pubkey TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT NOT NULL,reason TEXT,created_at INTEGER DEFAULT ${ts})`,
    `CREATE TABLE IF NOT EXISTS blocks(blocker_pubkey TEXT NOT NULL,blocked_pubkey TEXT NOT NULL,created_at INTEGER DEFAULT ${ts},PRIMARY KEY(blocker_pubkey,blocked_pubkey))`,
  ];
  for(const sql of tables){try{await db.exec(sql);console.log('✅',sql.slice(0,60));}catch(err){console.log('⚠️ Table:',err.message?.slice(0,100));}}
  // Migrations
  try{await db.exec('ALTER TABLE sessions ADD COLUMN barrels INTEGER DEFAULT 0');}catch{}
  // Check what's actually in the DB
  if(USE_PG){try{const r=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");console.log('📋 Tables:',r.map(t=>t.tablename).join(', '));for(const t of r){try{const c=await db.get(`SELECT COUNT(*) as n FROM ${t.tablename}`);console.log(`  ${t.tablename}: ${c?.n||0} rows`);}catch{}}}catch(e){console.log('Table check error:',e.message);}}
  console.log(`📦 Database: ${USE_PG?'PostgreSQL':'SQLite'}, URL: ${process.env.DATABASE_URL?.slice(0,30)}...`);
}

// ===== SURFLINE =====
const HEADERS={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'};
function degreesToCompass(deg){const d=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];return d[Math.round(deg/22.5)%16];}
function metersToFeet(m){return Math.round(m*3.28084*10)/10;}
function timeOfDayToHours(t){const h={'5am':[5,6],'6am':[6,7],'7am':[7,8],'8am':[8,9],'9am':[9,10],'10am':[10,11],'11am':[11,12],'12pm':[12,13],'1pm':[13,14],'2pm':[14,15],'3pm':[15,16],'4pm':[16,17],'5pm':[17,18],'6pm':[18,19]};const l={dawn:[5,7],morning:[7,10],midday:[10,13],afternoon:[13,16],evening:[16,18]};return h[t]||l[t]||[7,10];}

async function fetchSurflineData(spotId){
  const urls=[
    `https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${spotId}&days=3&intervalHours=3&units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT`,
    `https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=${spotId}&days=3&intervalHours=3&units%5BwindSpeed%5D=MPH`,
    `https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${spotId}&days=3&units%5BtideHeight%5D=FT`,
  ];
  const responses=await Promise.all(urls.map(u=>fetch(u,{headers:HEADERS})));
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

async function getForecast(spotId){
  const c=await db.get('SELECT data_json,fetched_at FROM forecast_cache WHERE spot_id=$1 ORDER BY fetched_at DESC LIMIT 1',[spotId]);
  if(c&&c.fetched_at>Math.floor(Date.now()/1000)-7200)return JSON.parse(c.data_json);
  return await fetchSurflineData(spotId);
}

function saveFile(base64,dir,ext){const fn=`${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;fs.writeFileSync(path.join(__dirname,dir,fn),Buffer.from(base64,'base64'));return`/${dir}/${fn}`;}

// Make media paths absolute so Capacitor local mode can resolve them
function absUrl(p,req){if(!p||p.startsWith('http'))return p;const host=req?.headers?.origin||`http://localhost:${PORT}`;return`https://swellnotes.com${p}`;}
function absSession(s,req){if(!s)return s;if(s.voice_memo_path)s.voice_memo_path=absUrl(s.voice_memo_path,req);if(s.video_path)s.video_path=absUrl(s.video_path,req);if(s.avatar_path)s.avatar_path=absUrl(s.avatar_path,req);return s;}
function absUser(u,req){if(!u)return u;if(u.avatar_path)u.avatar_path=absUrl(u.avatar_path,req);return u;}

// ===== AUTH =====
function requireAuth(req,res,next){const p=req.headers['x-nostr-pubkey'];if(!p||!/^[0-9a-f]{64}$/.test(p))return res.status(401).json({error:'Missing pubkey'});req.pubkey=p;next();}

// ===== SPOTS =====
app.get('/api/spots/search',async(req,res)=>{
  try{
    const r=await fetch(`https://services.surfline.com/search/site?q=${encodeURIComponent(req.query.q||'')}&querySize=10`,{headers:HEADERS});
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
  if(q){spots=await db.query('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.is_private=0 AND LOWER(s.name) LIKE LOWER($1) ORDER BY s.name',[`%${q}%`]);}
  else{spots=await db.query('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.is_private=0 ORDER BY s.name');}
  if(pk){const followed=await db.query('SELECT spot_id FROM spot_follows WHERE pubkey=$1',[pk]);const fset=new Set(followed.map(r=>r.spot_id));const membered=await db.query('SELECT spot_id FROM spot_members WHERE pubkey=$1',[pk]);const mset=new Set(membered.map(r=>r.spot_id));spots=spots.map(s=>({...s,is_following:fset.has(s.id)?1:0,is_member:mset.has(s.id)?1:0}));}
  res.json(spots);
});

app.get('/api/spots/following',requireAuth,async(req,res)=>{
  const spots=await db.query('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.id IN(SELECT spot_id FROM spot_follows WHERE pubkey=$1) ORDER BY s.name',[req.pubkey]);
  res.json(spots);
});

app.get('/api/spots/:id',async(req,res)=>{
  const spot=await db.get('SELECT s.*,(SELECT COUNT(*)FROM spot_members WHERE spot_id=s.id) as member_count FROM spots s WHERE s.id=$1',[req.params.id]);
  if(!spot)return res.status(404).json({error:'Not found'});
  const members=await db.query('SELECT sm.pubkey,sm.role,u.display_name,u.avatar_path FROM spot_members sm LEFT JOIN users u ON sm.pubkey=u.pubkey WHERE sm.spot_id=$1',[req.params.id]);
  res.json({...spot,members});
});

app.post('/api/spots',requireAuth,async(req,res)=>{
  const{surfline_spot_id,name,location_text,lat,lng,cover_image_url,is_private}=req.body;
  if(!surfline_spot_id||!name)return res.status(400).json({error:'Missing fields'});
  const id=genId();
  await db.run('INSERT INTO spots(id,surfline_spot_id,name,location_text,lat,lng,cover_image_url,is_private,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id,surfline_spot_id,name,location_text||null,lat||null,lng||null,cover_image_url||null,is_private?1:0,req.pubkey]);
  await db.run('INSERT INTO spot_members(spot_id,pubkey,role)VALUES($1,$2,$3)',[id,req.pubkey,'admin']);
  res.json({ok:true,id});
});

app.put('/api/spots/:id',requireAuth,async(req,res)=>{
  const member=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(!member||member.role!=='admin')return res.status(403).json({error:'Admin only'});
  const{cover_image_url,is_private,name}=req.body;
  if(cover_image_url!==undefined)await db.run('UPDATE spots SET cover_image_url=$1 WHERE id=$2',[cover_image_url,req.params.id]);
  if(is_private!==undefined)await db.run('UPDATE spots SET is_private=$1 WHERE id=$2',[is_private?1:0,req.params.id]);
  if(name)await db.run('UPDATE spots SET name=$1 WHERE id=$2',[name,req.params.id]);
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

// ===== INVITES =====
app.post('/api/spots/:id/invites',requireAuth,async(req,res)=>{
  const member=await db.get('SELECT role FROM spot_members WHERE spot_id=$1 AND pubkey=$2',[req.params.id,req.pubkey]);
  if(!member||member.role!=='admin')return res.status(403).json({error:'Admin only'});
  const id=genId(8);
  const maxUses=req.body.max_uses||null;
  const expiresAt=req.body.expires_hours?Math.floor(Date.now()/1000)+req.body.expires_hours*3600:null;
  await db.run('INSERT INTO spot_invites(id,spot_id,created_by,max_uses,expires_at)VALUES($1,$2,$3,$4,$5)',[id,req.params.id,req.pubkey,maxUses,expiresAt]);
  res.json({ok:true,invite_code:id,link:`${req.headers.origin||`http://localhost:${PORT}`}/join/${id}`});
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
    const sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path,(SELECT COALESCE(SUM(barrels),0)FROM sessions WHERE pubkey=s.pubkey) as total_barrels FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ${wc} ORDER BY s.session_date DESC,s.created_at DESC LIMIT $${n++}`,[...p,+limit]);
    if(sessions.length)result.push({spot:{id:spot.id,name:spot.name,location_text:spot.location_text,cover_image_url:spot.cover_image_url,member_count:spot.member_count},sessions:sessions.map(s=>absSession(s,req))});
  }
  res.json(result);
});

// ===== CONDITIONS (spot-aware) =====
app.get('/api/conditions',async(req,res)=>{
  try{
    const spotId=req.query.spot_id;
    let surflineSpotId='5842041f4e65fad6a7708b9c'; // default Dominical
    if(spotId){const spot=await db.get('SELECT surfline_spot_id FROM spots WHERE id=$1',[spotId]);if(spot)surflineSpotId=spot.surfline_spot_id;}
    else if(req.query.surfline_spot_id)surflineSpotId=req.query.surfline_spot_id;
    const forecast=await getForecast(surflineSpotId);
    res.json(getConditions(forecast,req.query.date||new Date().toISOString().split('T')[0],req.query.time_of_day||'morning'));
  }catch(err){console.error('Conditions error:',err.message||err);res.status(500).json({error:'Failed to fetch conditions'});}
});

// ===== NIP-46 =====
app.get('/api/nip46/init',async(req,res)=>{try{const{generateSecretKey,getPublicKey}=await import('nostr-tools');const sk=generateSecretKey();const secretKey=Buffer.from(sk).toString('hex');const publicKey=getPublicKey(sk);const rh=crypto.randomBytes(16).toString('hex');const secret=`sec-${rh.slice(0,8)}-${rh.slice(8,12)}-${rh.slice(12,16)}-${rh.slice(16,20)}-${rh.slice(20,32)}`;const relay='wss://relay.primal.net';const p=new URLSearchParams();p.append('relay',relay);p.append('secret',secret);p.append('name','Swellnotes');p.append('url',req.query.origin||`http://localhost:${PORT}`);const qrURI=`nostrconnect://${publicKey}?${p.toString()}`;const cp=new URLSearchParams(p);const callbackBase=req.query.platform==='ios'?'swellnotes://login-callback':`${req.query.origin||`http://localhost:${PORT}`}/login-callback`;cp.append('callback',callbackBase);res.json({secretKey,publicKey,secret,relay,qrDataUrl:await QRCode.toDataURL(qrURI,{width:280,margin:2}),qrURI,mobileURI:`nostrconnect://${publicKey}?${cp.toString()}`});}catch(err){console.error('NIP-46 init error:',err);res.status(500).json({error:'NIP-46 init failed: '+(err.message||'unknown')});}});

// ===== AUTH =====
app.post('/api/auth/login',async(req,res)=>{
  try{
    const{pubkey,display_name,avatar_base64,avatar_url}=req.body;
    if(!pubkey||!/^[0-9a-f]{64}$/.test(pubkey))return res.status(400).json({error:'Invalid pubkey'});
    let avatarPath=avatar_url||null;
    if(!avatarPath&&avatar_base64)avatarPath=saveFile(avatar_base64,'avatars','jpg');
    // Use separate INSERT and UPDATE to avoid Postgres parameter conflicts
    const existing=await db.get('SELECT pubkey FROM users WHERE pubkey=$1',[pubkey]);
    if(existing){
      if(avatarPath)await db.run('UPDATE users SET display_name=$1,avatar_path=$2 WHERE pubkey=$3',[display_name||'Anon',avatarPath,pubkey]);
      else await db.run('UPDATE users SET display_name=$1 WHERE pubkey=$2',[display_name||'Anon',pubkey]);
    }else{
      if(avatarPath)await db.run('INSERT INTO users(pubkey,display_name,avatar_path)VALUES($1,$2,$3)',[pubkey,display_name||'Anon',avatarPath]);
      else await db.run('INSERT INTO users(pubkey,display_name)VALUES($1,$2)',[pubkey,display_name||'Anon']);
    }
    const user=await db.get('SELECT*FROM users WHERE pubkey=$1',[pubkey]);
    res.json({ok:true,...user});
  }catch(err){console.error('Login error:',err);res.status(500).json({error:'Login failed'});}
});

app.get('/api/users',async(req,res)=>{
  const spotId=req.query.spot_id;
  let users;
  if(spotId)users=await db.query('SELECT u.pubkey,u.display_name,u.avatar_path,sm.role,(SELECT COUNT(*)FROM sessions WHERE pubkey=u.pubkey AND spot_id=$1) as session_count,(SELECT COALESCE(SUM(barrels),0)FROM sessions WHERE pubkey=u.pubkey) as total_barrels FROM spot_members sm LEFT JOIN users u ON sm.pubkey=u.pubkey WHERE sm.spot_id=$1 ORDER BY session_count DESC',[spotId]);
  else users=await db.query('SELECT u.pubkey,u.display_name,u.avatar_path,(SELECT COUNT(*)FROM sessions WHERE pubkey=u.pubkey) as session_count,(SELECT COALESCE(SUM(barrels),0)FROM sessions WHERE pubkey=u.pubkey) as total_barrels FROM users u ORDER BY session_count DESC');
  res.json(users.map(u=>absUser(u,req)));
});
app.get('/api/users/:pubkey',async(req,res)=>{const u=await db.get('SELECT*FROM users WHERE pubkey=$1',[req.params.pubkey]);if(!u)return res.status(404).json({error:'Not found'});const c=await db.get('SELECT COUNT(*) as c,COALESCE(SUM(barrels),0) as b FROM sessions WHERE pubkey=$1',[req.params.pubkey]);res.json(absUser({...u,session_count:c?.c||0,total_barrels:c?.b||0},req));});

// ===== FOLLOWS =====
app.get('/api/follows',requireAuth,async(req,res)=>{
  res.json({following:await db.query('SELECT f.followed_pubkey as pubkey,u.display_name,u.avatar_path,(SELECT COUNT(*)FROM sessions WHERE pubkey=f.followed_pubkey) as session_count FROM follows f LEFT JOIN users u ON f.followed_pubkey=u.pubkey WHERE f.follower_pubkey=$1',[req.pubkey]),
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
  if(spot_id){w.push(`s.spot_id=$${n++}`);p.push(spot_id);}
  if(feed_for){const pks=await getFeedPubkeys(feed_for);w.push(`s.pubkey IN(${pks.map(()=>`$${n++}`).join(',')})`);p.push(...pks);}
  if(fp){w.push(`s.pubkey=$${n++}`);p.push(fp);}
  if(month){w.push(`substring(session_date,1,7)=$${n++}`);p.push(month);}
  if(swell_dir){w.push(`swells_json LIKE $${n++}`);p.push(`%"direction_compass":"${swell_dir}"%`);}
  const wc=w.length?'WHERE '+w.join(' AND '):'';
  const sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path,(SELECT COALESCE(SUM(barrels),0)FROM sessions WHERE pubkey=s.pubkey) as total_barrels FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ${wc} ORDER BY s.session_date DESC,s.created_at DESC LIMIT $${n++} OFFSET $${n++}`,[...p,+limit,+offset]);
  const total=await db.get(`SELECT COUNT(*) as count FROM sessions s ${wc}`,p);
  res.json({sessions:sessions.map(s=>absSession(s,req)),total:total?.count||0});
});

app.get('/api/sessions/:id',async(req,res)=>{
  const s=await db.get('SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.id=$1',[req.params.id]);
  if(!s)return res.status(404).json({error:'Not found'});
  const comments=await db.query('SELECT c.*,u.display_name,u.avatar_path FROM comments c LEFT JOIN users u ON c.pubkey=u.pubkey WHERE c.session_id=$1 ORDER BY c.created_at ASC',[req.params.id]);
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
  const{pubkey,spot_id,dir_min,dir_max,height_min,height_max,period_min,period_max,rating_min,rating_max}=req.query;
  let sessions;
  const safeSpotId=spot_id?.replace(/[^a-zA-Z0-9_-]/g,'')||null;
  if(pubkey){const pks=await getFeedPubkeys(pubkey);let n=pks.length+1;const ph=pks.map((_,i)=>`$${i+1}`).join(',');const spotClause=safeSpotId?` AND s.spot_id=$${n}`:'';const params=[...pks];if(safeSpotId)params.push(safeSpotId);sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.pubkey IN(${ph})${spotClause} ORDER BY s.session_date DESC`,params);}
  else sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ${baseWhere} ORDER BY s.session_date DESC`);
  const results=sessions.filter(s=>{const swells=JSON.parse(s.swells_json||'[]');if(!swells.length)return false;if(dir_min||dir_max){const dmin=parseFloat(dir_min)||0,dmax=parseFloat(dir_max)||360;if(!swells.some(sw=>sw.direction_deg>=dmin&&sw.direction_deg<=dmax))return false;}if(height_min&&swells[0].height_ft<parseFloat(height_min))return false;if(height_max&&swells[0].height_ft>parseFloat(height_max))return false;if(period_min&&swells[0].period_s<parseFloat(period_min))return false;if(period_max&&swells[0].period_s>parseFloat(period_max))return false;if(rating_min&&(s.rating||0)<parseInt(rating_min))return false;if(rating_max&&(s.rating||0)>parseInt(rating_max))return false;return true;});
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

app.get('/api/analysis/by-direction',async(req,res)=>{const ss=await getAnalysisSessions(req.query.pubkey,req.query.spot_id);const m={};for(const s of ss){const sw=JSON.parse(s.swells_json||'[]');if(!sw.length)continue;const d=sw[0].direction_compass;if(!m[d])m[d]={r:[],sh:[],sp:[]};m[d].r.push(s.rating);m[d].sh.push(sw[0].height_ft);m[d].sp.push(sw[0].period_s);}res.json(Object.entries(m).map(([d,v])=>({direction:d,session_count:v.r.length,avg_rating:Math.round(v.r.reduce((a,b)=>a+b,0)/v.r.length*10)/10,avg_swell_height:Math.round(v.sh.reduce((a,b)=>a+b,0)/v.sh.length*10)/10,avg_swell_period:Math.round(v.sp.reduce((a,b)=>a+b,0)/v.sp.length*10)/10})).sort((a,b)=>b.avg_rating-a.avg_rating));});

app.get('/api/analysis/best-conditions',async(req,res)=>{const ss=await getAnalysisSessions(req.query.pubkey,req.query.spot_id);const c={};for(const s of ss){const sw=JSON.parse(s.swells_json||'[]');if(!sw.length)continue;const w=sw[0];const k=`${w.direction_compass}|${Math.round(w.height_ft)}|${w.period_s<10?'s':w.period_s<15?'m':'l'}|${s.wind_type||'-'}`;if(!c[k])c[k]={r:[],dir:w.direction_compass,swell:Math.round(w.height_ft)+'ft',period:w.period_s<10?'short (<10s)':w.period_s<15?'medium (10-15s)':'long (15s+)',wind:s.wind_type||'-'};c[k].r.push(s.rating);}res.json(Object.values(c).filter(x=>x.r.length>=2).map(x=>({direction:x.dir,swell_bucket:x.swell,period_bucket:x.period,wind_type:x.wind,count:x.r.length,avg_rating:Math.round(x.r.reduce((a,b)=>a+b,0)/x.r.length*10)/10})).sort((a,b)=>b.avg_rating-a.avg_rating).slice(0,20));});

app.get('/api/analysis/timeline',async(req,res)=>{
  const{pubkey:pk,spot_id}=req.query;let ss;const safeSpotTl=spot_id?.replace(/[^a-zA-Z0-9_-]/g,'')||null;const extra=safeSpotTl?` AND spot_id='${safeSpotTl}'`:'';
  if(pk){const pks=await getFeedPubkeys(pk);const ph=pks.map((_,i)=>`$${i+1}`).join(',');ss=await db.query(`SELECT session_date,ROUND(AVG(rating),1) as avg_rating,ROUND(AVG(surf_height_min_ft),1) as avg_min,ROUND(AVG(surf_height_max_ft),1) as avg_max,COUNT(*) as entries FROM sessions WHERE pubkey IN(${ph})${extra} GROUP BY session_date ORDER BY session_date DESC LIMIT 90`,pks);}
  else ss=await db.query(`SELECT session_date,ROUND(AVG(rating),1) as avg_rating,ROUND(AVG(surf_height_min_ft),1) as avg_min,ROUND(AVG(surf_height_max_ft),1) as avg_max,COUNT(*) as entries FROM sessions WHERE 1=1${extra} GROUP BY session_date ORDER BY session_date DESC LIMIT 90`);
  for(const r of ss){const s=await db.get('SELECT swells_json FROM sessions WHERE session_date=$1 AND swells_json IS NOT NULL LIMIT 1',[r.session_date]);if(s?.swells_json)r.directions=JSON.parse(s.swells_json).filter(w=>w.height_ft>0).map(w=>w.direction_compass).join(',');}
  res.json(ss);
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
