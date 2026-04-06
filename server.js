const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Media dirs (fallback for local storage)
['audio','videos','avatars'].forEach(d=>{const p=path.join(__dirname,d);if(!fs.existsSync(p))fs.mkdirSync(p);app.use(`/${d}`,express.static(p));});

// ===== DATABASE ABSTRACTION =====
const USE_PG = !!process.env.DATABASE_URL;
let db;

if (USE_PG) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });
  db = {
    query: async (sql, params=[]) => { const r = await pool.query(sql, params); return r.rows; },
    get: async (sql, params=[]) => { const r = await pool.query(sql, params); return r.rows[0] || null; },
    run: async (sql, params=[]) => { const r = await pool.query(sql + ' RETURNING *', params); return { lastID: r.rows[0]?.id, rows: r.rows }; },
    exec: async (sql) => { await pool.query(sql); },
  };
} else {
  const Database = require('better-sqlite3');
  const sqlite = new Database(path.join(__dirname, 'surf-diary.db'));
  sqlite.pragma('journal_mode = WAL'); sqlite.pragma('foreign_keys = ON');
  db = {
    query: async (sql, params=[]) => sqlite.prepare(sql.replace(/\$(\d+)/g, '?')).all(...params),
    get: async (sql, params=[]) => sqlite.prepare(sql.replace(/\$(\d+)/g, '?')).get(...params) || null,
    run: async (sql, params=[]) => { const r = sqlite.prepare(sql.replace(/\$(\d+)/g, '?').replace(/ RETURNING \*/, '')).run(...params); return { lastID: r.lastInsertRowid }; },
    exec: async (sql) => sqlite.exec(sql),
  };
}

// ===== INIT TABLES =====
async function initDB() {
  if (USE_PG) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        pubkey TEXT PRIMARY KEY, display_name TEXT, avatar_path TEXT,
        created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::int)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY, pubkey TEXT NOT NULL, session_date TEXT NOT NULL, time_of_day TEXT NOT NULL,
        swells_json TEXT, surf_height_min_ft REAL, surf_height_max_ft REAL,
        wind_speed_mph REAL, wind_direction_deg REAL, wind_type TEXT, wind_gust_mph REAL,
        tide_height_ft REAL, rating INTEGER, wave_shape TEXT, session_type TEXT DEFAULT 'surfed',
        notes TEXT, voice_memo_path TEXT, voice_transcript TEXT, video_path TEXT,
        created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::int)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY, session_id INTEGER NOT NULL, pubkey TEXT NOT NULL, body TEXT NOT NULL,
        created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::int)
      );
      CREATE TABLE IF NOT EXISTS follows (
        follower_pubkey TEXT NOT NULL, followed_pubkey TEXT NOT NULL,
        created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::int),
        PRIMARY KEY (follower_pubkey, followed_pubkey)
      );
      CREATE TABLE IF NOT EXISTS forecast_cache (
        id SERIAL PRIMARY KEY, fetched_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::int), data_json TEXT NOT NULL
      );
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (pubkey TEXT PRIMARY KEY, display_name TEXT, avatar_path TEXT, created_at INTEGER DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, pubkey TEXT NOT NULL, session_date TEXT NOT NULL, time_of_day TEXT NOT NULL, swells_json TEXT, surf_height_min_ft REAL, surf_height_max_ft REAL, wind_speed_mph REAL, wind_direction_deg REAL, wind_type TEXT, wind_gust_mph REAL, tide_height_ft REAL, rating INTEGER, wave_shape TEXT, session_type TEXT DEFAULT 'surfed', notes TEXT, voice_memo_path TEXT, voice_transcript TEXT, video_path TEXT, created_at INTEGER DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, pubkey TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS follows (follower_pubkey TEXT NOT NULL, followed_pubkey TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (follower_pubkey, followed_pubkey));
      CREATE TABLE IF NOT EXISTS forecast_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, fetched_at INTEGER DEFAULT (unixepoch()), data_json TEXT NOT NULL);
    `);
  }
  console.log(`📦 Database: ${USE_PG ? 'PostgreSQL' : 'SQLite'}`);
}

// ===== SURFLINE =====
const SPOT_ID='5842041f4e65fad6a7708b9c';
const HEADERS={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'};
function degreesToCompass(deg){const d=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];return d[Math.round(deg/22.5)%16];}
function metersToFeet(m){return Math.round(m*3.28084*10)/10;}
function timeOfDayToHours(t){const h={'5am':[5,6],'6am':[6,7],'7am':[7,8],'8am':[8,9],'9am':[9,10],'10am':[10,11],'11am':[11,12],'12pm':[12,13],'1pm':[13,14],'2pm':[14,15],'3pm':[15,16],'4pm':[16,17],'5pm':[17,18],'6pm':[18,19]};const l={dawn:[5,7],morning:[7,10],midday:[10,13],afternoon:[13,16],evening:[16,18]};return h[t]||l[t]||[7,10];}

async function fetchSurflineData(){
  const[w,wi,t]=await Promise.all([
    fetch(`https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${SPOT_ID}&days=3&intervalHours=3&units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT`,{headers:HEADERS}),
    fetch(`https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=${SPOT_ID}&days=3&intervalHours=3&units%5BwindSpeed%5D=MPH`,{headers:HEADERS}),
    fetch(`https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${SPOT_ID}&days=3`,{headers:HEADERS}),
  ]);
  const[wave,wind,tides]=await Promise.all([w.json(),wi.json(),t.json()]);
  const data=JSON.stringify({wave:wave.data,wind:wind.data,tides:tides.data,utcOffset:wave.associated?.utcOffset||-6});
  await db.run('INSERT INTO forecast_cache(data_json) VALUES($1)',[data]);
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
  if(te)c.tide_height_ft=metersToFeet(te.height);
  return c;
}

async function getForecast(){
  const c=await db.get('SELECT data_json,fetched_at FROM forecast_cache ORDER BY fetched_at DESC LIMIT 1');
  if(c&&c.fetched_at>Math.floor(Date.now()/1000)-7200)return JSON.parse(c.data_json);
  return await fetchSurflineData();
}

function saveFile(base64,dir,ext){const fn=`${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;fs.writeFileSync(path.join(__dirname,dir,fn),Buffer.from(base64,'base64'));return`/${dir}/${fn}`;}

// ===== AUTH =====
function requireAuth(req,res,next){const p=req.headers['x-nostr-pubkey'];if(!p||!/^[0-9a-f]{64}$/.test(p))return res.status(401).json({error:'Missing pubkey'});req.pubkey=p;next();}

// ===== ROUTES =====
app.get('/api/conditions',async(req,res)=>{try{res.json(getConditions(await getForecast(),req.query.date||new Date().toISOString().split('T')[0],req.query.time_of_day||'morning'));}catch{res.status(500).json({error:'Failed'});}});

app.get('/api/nip46/init',async(req,res)=>{try{const{generateSecretKey,getPublicKey}=await import('nostr-tools');const sk=generateSecretKey();const secretKey=Buffer.from(sk).toString('hex');const publicKey=getPublicKey(sk);const rh=crypto.randomBytes(16).toString('hex');const secret=`sec-${rh.slice(0,8)}-${rh.slice(8,12)}-${rh.slice(12,16)}-${rh.slice(16,20)}-${rh.slice(20,32)}`;const relay='wss://relay.primal.net';const p=new URLSearchParams();p.append('relay',relay);p.append('secret',secret);p.append('name','Dominical Surf Diary');p.append('url',req.query.origin||`http://localhost:${PORT}`);const qrURI=`nostrconnect://${publicKey}?${p.toString()}`;const cp=new URLSearchParams(p);cp.append('callback',`${req.query.origin||`http://localhost:${PORT}`}/login-callback`);res.json({secretKey,publicKey,secret,relay,qrDataUrl:await QRCode.toDataURL(qrURI,{width:280,margin:2}),qrURI,mobileURI:`nostrconnect://${publicKey}?${cp.toString()}`});}catch{res.status(500).json({error:'Failed'});}});

app.post('/api/auth/login',async(req,res)=>{
  const{pubkey,display_name,avatar_base64,avatar_url}=req.body;
  if(!pubkey||!/^[0-9a-f]{64}$/.test(pubkey))return res.status(400).json({error:'Invalid pubkey'});
  let avatarPath=avatar_url||null;
  if(!avatarPath&&avatar_base64)avatarPath=saveFile(avatar_base64,'avatars','jpg');
  if(avatarPath)await db.run('INSERT INTO users(pubkey,display_name,avatar_path)VALUES($1,$2,$3)ON CONFLICT(pubkey)DO UPDATE SET display_name=$2,avatar_path=$3',[pubkey,display_name||'Anon',avatarPath]);
  else await db.run('INSERT INTO users(pubkey,display_name)VALUES($1,$2)ON CONFLICT(pubkey)DO UPDATE SET display_name=$2',[pubkey,display_name||'Anon']);
  const user=await db.get('SELECT * FROM users WHERE pubkey=$1',[pubkey]);
  res.json({ok:true,...user});
});

app.get('/api/users',async(req,res)=>{res.json(await db.query('SELECT u.pubkey,u.display_name,u.avatar_path,(SELECT COUNT(*)FROM sessions WHERE pubkey=u.pubkey) as session_count FROM users u ORDER BY session_count DESC'));});
app.get('/api/users/:pubkey',async(req,res)=>{const u=await db.get('SELECT*FROM users WHERE pubkey=$1',[req.params.pubkey]);if(!u)return res.status(404).json({error:'Not found'});const c=await db.get('SELECT COUNT(*) as c FROM sessions WHERE pubkey=$1',[req.params.pubkey]);res.json({...u,session_count:c?.c||0});});

// Follows
app.get('/api/follows',requireAuth,async(req,res)=>{
  const following=await db.query('SELECT f.followed_pubkey as pubkey,u.display_name,u.avatar_path,(SELECT COUNT(*)FROM sessions WHERE pubkey=f.followed_pubkey) as session_count FROM follows f LEFT JOIN users u ON f.followed_pubkey=u.pubkey WHERE f.follower_pubkey=$1',[req.pubkey]);
  const followers=await db.query('SELECT f.follower_pubkey as pubkey,u.display_name FROM follows f LEFT JOIN users u ON f.follower_pubkey=u.pubkey WHERE f.followed_pubkey=$1',[req.pubkey]);
  res.json({following,followers});
});
app.post('/api/follows/:pubkey',requireAuth,async(req,res)=>{if(req.params.pubkey===req.pubkey)return res.status(400).json({error:'Cannot follow yourself'});await db.run('INSERT INTO follows(follower_pubkey,followed_pubkey)VALUES($1,$2)ON CONFLICT DO NOTHING',[req.pubkey,req.params.pubkey]);res.json({ok:true});});
app.delete('/api/follows/:pubkey',requireAuth,async(req,res)=>{await db.run('DELETE FROM follows WHERE follower_pubkey=$1 AND followed_pubkey=$2',[req.pubkey,req.params.pubkey]);res.json({ok:true});});

async function getFeedPubkeys(pk){const rows=await db.query('SELECT followed_pubkey FROM follows WHERE follower_pubkey=$1',[pk]);return[pk,...rows.map(r=>r.followed_pubkey)];}

// Sessions
app.get('/api/sessions',async(req,res)=>{
  const{limit=50,offset=0,month,swell_dir,feed_for,pubkey:fp}=req.query;let w=[],p=[],n=1;
  if(feed_for){const pks=await getFeedPubkeys(feed_for);w.push(`s.pubkey IN(${pks.map(()=>`$${n++}`).join(',')})`);p.push(...pks);}
  if(fp){w.push(`s.pubkey=$${n++}`);p.push(fp);}
  if(month){w.push(`substring(session_date,1,7)=$${n++}`);p.push(month);}
  if(swell_dir){w.push(`swells_json LIKE $${n++}`);p.push(`%"direction_compass":"${swell_dir}"%`);}
  const wc=w.length?'WHERE '+w.join(' AND '):'';
  const sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ${wc} ORDER BY s.session_date DESC,s.created_at DESC LIMIT $${n++} OFFSET $${n++}`,[...p,+limit,+offset]);
  const total=await db.get(`SELECT COUNT(*) as count FROM sessions s ${wc}`,p);
  res.json({sessions,total:total?.count||0});
});

app.get('/api/sessions/:id',async(req,res)=>{
  const s=await db.get('SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.id=$1',[req.params.id]);
  if(!s)return res.status(404).json({error:'Not found'});
  const comments=await db.query('SELECT c.*,u.display_name,u.avatar_path FROM comments c LEFT JOIN users u ON c.pubkey=u.pubkey WHERE c.session_id=$1 ORDER BY c.created_at ASC',[req.params.id]);
  res.json({session:s,comments});
});

app.post('/api/sessions',requireAuth,async(req,res)=>{
  const b=req.body;let c={};try{c=getConditions(await getForecast(),b.session_date,b.time_of_day);}catch{}
  let voicePath=b.voice_url||null,videoPath=b.video_url||null;
  if(!voicePath&&b.voice_memo_base64)voicePath=saveFile(b.voice_memo_base64,'audio','webm');
  if(!videoPath&&b.video_base64)videoPath=saveFile(b.video_base64,'videos','mp4');
  const r=await db.run('INSERT INTO sessions(pubkey,session_date,time_of_day,swells_json,surf_height_min_ft,surf_height_max_ft,wind_speed_mph,wind_direction_deg,wind_type,wind_gust_mph,tide_height_ft,rating,wave_shape,session_type,notes,voice_memo_path,voice_transcript,video_path)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
    [req.pubkey,b.session_date,b.time_of_day,JSON.stringify(c.swells||[]),c.surf_height_min_ft??null,c.surf_height_max_ft??null,c.wind_speed_mph??null,c.wind_direction_deg??null,c.wind_type??null,c.wind_gust_mph??null,c.tide_height_ft??null,b.rating,b.wave_shape||null,b.session_type||'surfed',b.notes||null,voicePath,b.voice_transcript||null,videoPath]);
  res.json({ok:true,id:r.lastID,conditions:c});
});

app.delete('/api/sessions/:id',requireAuth,async(req,res)=>{
  const s=await db.get('SELECT pubkey,voice_memo_path,video_path FROM sessions WHERE id=$1',[req.params.id]);
  if(!s)return res.status(404).json({error:'Not found'});if(s.pubkey!==req.pubkey)return res.status(403).json({error:'Forbidden'});
  [s.voice_memo_path,s.video_path].forEach(p=>{if(p&&p.startsWith('/'))try{fs.unlinkSync(path.join(__dirname,p));}catch{}});
  await db.run('DELETE FROM sessions WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

app.post('/api/sessions/:id/comments',requireAuth,async(req,res)=>{
  if(!req.body.body?.trim())return res.status(400).json({error:'Empty'});
  if(!await db.get('SELECT id FROM sessions WHERE id=$1',[req.params.id]))return res.status(404).json({error:'Not found'});
  await db.run('INSERT INTO comments(session_id,pubkey,body)VALUES($1,$2,$3)',[req.params.id,req.pubkey,req.body.body.trim()]);
  res.json({ok:true});
});

// Search
app.get('/api/search',async(req,res)=>{
  const{pubkey,dir_min,dir_max,height_min,height_max,period_min,period_max,rating_min,rating_max}=req.query;
  let sessions;
  if(pubkey){const pks=await getFeedPubkeys(pubkey);const ph=pks.map((_,i)=>`$${i+1}`).join(',');sessions=await db.query(`SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey WHERE s.pubkey IN(${ph}) ORDER BY s.session_date DESC`,pks);}
  else sessions=await db.query('SELECT s.*,u.display_name,u.avatar_path FROM sessions s LEFT JOIN users u ON s.pubkey=u.pubkey ORDER BY s.session_date DESC');
  const results=sessions.filter(s=>{const swells=JSON.parse(s.swells_json||'[]');if(!swells.length)return false;if(dir_min||dir_max){const dmin=parseFloat(dir_min)||0,dmax=parseFloat(dir_max)||360;if(!swells.some(sw=>sw.direction_deg>=dmin&&sw.direction_deg<=dmax))return false;}if(height_min&&swells[0].height_ft<parseFloat(height_min))return false;if(height_max&&swells[0].height_ft>parseFloat(height_max))return false;if(period_min&&swells[0].period_s<parseFloat(period_min))return false;if(period_max&&swells[0].period_s>parseFloat(period_max))return false;if(rating_min&&(s.rating||0)<parseInt(rating_min))return false;if(rating_max&&(s.rating||0)>parseInt(rating_max))return false;return true;});
  const ratings=results.filter(s=>s.rating).map(s=>s.rating);
  res.json({sessions:results.slice(0,100),summary:{count:results.length,avg_rating:ratings.length?Math.round(ratings.reduce((a,b)=>a+b,0)/ratings.length*10)/10:null,best_rating:ratings.length?Math.max(...ratings):null,worst_rating:ratings.length?Math.min(...ratings):null}});
});

// Analysis
async function getAnalysisSessions(pk){
  if(!pk)return await db.query('SELECT*FROM sessions WHERE swells_json IS NOT NULL AND rating IS NOT NULL');
  const pks=await getFeedPubkeys(pk);const ph=pks.map((_,i)=>`$${i+1}`).join(',');
  return await db.query(`SELECT*FROM sessions WHERE pubkey IN(${ph})AND swells_json IS NOT NULL AND rating IS NOT NULL`,pks);
}

app.get('/api/analysis/by-direction',async(req,res)=>{const ss=await getAnalysisSessions(req.query.pubkey);const m={};for(const s of ss){const sw=JSON.parse(s.swells_json||'[]');if(!sw.length)continue;const d=sw[0].direction_compass;if(!m[d])m[d]={r:[],sh:[],sp:[]};m[d].r.push(s.rating);m[d].sh.push(sw[0].height_ft);m[d].sp.push(sw[0].period_s);}res.json(Object.entries(m).map(([d,v])=>({direction:d,session_count:v.r.length,avg_rating:Math.round(v.r.reduce((a,b)=>a+b,0)/v.r.length*10)/10,avg_swell_height:Math.round(v.sh.reduce((a,b)=>a+b,0)/v.sh.length*10)/10,avg_swell_period:Math.round(v.sp.reduce((a,b)=>a+b,0)/v.sp.length*10)/10})).sort((a,b)=>b.avg_rating-a.avg_rating));});

app.get('/api/analysis/best-conditions',async(req,res)=>{const ss=await getAnalysisSessions(req.query.pubkey);const c={};for(const s of ss){const sw=JSON.parse(s.swells_json||'[]');if(!sw.length)continue;const w=sw[0];const k=`${w.direction_compass}|${Math.round(w.height_ft)}|${w.period_s<10?'s':w.period_s<15?'m':'l'}|${s.wind_type||'-'}`;if(!c[k])c[k]={r:[],dir:w.direction_compass,swell:Math.round(w.height_ft)+'ft',period:w.period_s<10?'short (<10s)':w.period_s<15?'medium (10-15s)':'long (15s+)',wind:s.wind_type||'-'};c[k].r.push(s.rating);}res.json(Object.values(c).filter(x=>x.r.length>=2).map(x=>({direction:x.dir,swell_bucket:x.swell,period_bucket:x.period,wind_type:x.wind,count:x.r.length,avg_rating:Math.round(x.r.reduce((a,b)=>a+b,0)/x.r.length*10)/10})).sort((a,b)=>b.avg_rating-a.avg_rating).slice(0,20));});

app.get('/api/analysis/timeline',async(req,res)=>{
  const pk=req.query.pubkey;let ss;
  if(pk){const pks=await getFeedPubkeys(pk);const ph=pks.map((_,i)=>`$${i+1}`).join(',');ss=await db.query(`SELECT session_date,ROUND(AVG(rating),1) as avg_rating,ROUND(AVG(surf_height_min_ft),1) as avg_min,ROUND(AVG(surf_height_max_ft),1) as avg_max,COUNT(*) as entries FROM sessions WHERE pubkey IN(${ph})GROUP BY session_date ORDER BY session_date DESC LIMIT 90`,pks);}
  else ss=await db.query('SELECT session_date,ROUND(AVG(rating),1) as avg_rating,ROUND(AVG(surf_height_min_ft),1) as avg_min,ROUND(AVG(surf_height_max_ft),1) as avg_max,COUNT(*) as entries FROM sessions GROUP BY session_date ORDER BY session_date DESC LIMIT 90');
  for(const r of ss){const s=await db.get('SELECT swells_json FROM sessions WHERE session_date=$1 AND swells_json IS NOT NULL LIMIT 1',[r.session_date]);if(s?.swells_json)r.directions=JSON.parse(s.swells_json).filter(w=>w.height_ft>0).map(w=>w.direction_compass).join(',');}
  res.json(ss);
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// Start
initDB().then(()=>{
  app.listen(PORT,()=>console.log(`🏄 Surf Diary running at http://localhost:${PORT}`));
}).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
