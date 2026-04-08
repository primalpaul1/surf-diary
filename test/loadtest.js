const crypto = require('crypto');

const PROD_URL = 'https://swellnotes.com';
const LOCAL_URL = 'http://localhost:3000';
const isProd = process.argv.includes('--prod');
const BASE = isProd ? PROD_URL : LOCAL_URL;
const mode = process.argv[2] || 'all';

const SURFLINE_SPOTS = [
  { surfline_spot_id: '5842041f4e65fad6a7708b9c', name: 'Dominical', location_text: 'Central Pacific, Costa Rica', lat: 9.25, lng: -83.86 },
  { surfline_spot_id: '5842041f4e65fad6a7708ba9', name: 'Pavones', location_text: 'Southern Zone, Costa Rica', lat: 8.39, lng: -83.14 },
];

const NAMES = [
  'KaiBarrel','ReefRat','TubeHunter','DawnPatrol','SaltLife','WaveRider','Shredder',
  'OffshoreOscar','BarrelBob','KelpKing','TideTurner','SwellSeeker','RipCurrent',
  'GlassyGary','PumpingSam','SandBar','CoralCrew','DropIn','PaddleOut','DuckDive',
  'Frother','GromLife','WaxHead','FinFirst','NoseDive','CutBack','SnapBack',
  'FloaterFred','AerialAce','CleanupSet','OutsideOli','InsideDan','PeakPete',
  'ChannelChris','SetWave','BombSquad','BarrelDog','TubeTime','DeepEnd',
  'ShoreBreak','WhiteWash','GreenRoom','PitBoss','SlabHunter','HollowHank',
  'RailWork','SprayKing','StallMaster','PigDog','BackDoor',
];

const TIMES = ['5am','6am','7am','8am','9am','10am','11am','12pm','1pm','2pm','3pm','4pm','5pm','6pm'];
const SHAPES = ['peaky','barreling','rippable','mushy','blown out','closed out'];
const TYPES = ['surfed','surfed','surfed','surfed','observed'];
const COMMENTS = [
  'Sick session!','Looked fun out there','Pumping!','Wish I was there',
  'Epic barrels today','How was the crowd?','Dawn patrol is the way',
  'Conditions looked perfect','That drop was gnarly','Clean lines all morning',
  'Offshore all day','Glassy and perfect','A bit choppy but fun',
  'Best session this month','The tide was perfect for it','Overhead sets coming through',
  'Got worked on that last one','So many barrels today','Textbook conditions',
  'Need to get out there more','That swell was magic','Party waves!',
];

function hex(n) { return crypto.randomBytes(n).toString('hex'); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - rand(0, daysBack));
  return d.toISOString().split('T')[0];
}

async function post(path, body, pubkey) {
  const headers = { 'Content-Type': 'application/json' };
  if (pubkey) headers['X-Nostr-Pubkey'] = pubkey;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return r.json();
}

async function get(path, pubkey) {
  const headers = {};
  if (pubkey) headers['X-Nostr-Pubkey'] = pubkey;
  const r = await fetch(BASE + path, { headers });
  return r.json();
}

// ===== SEED =====
async function seed() {
  console.log(`\n🌊 Seeding data on ${BASE}...\n`);

  // 1. Create users
  console.log('👤 Creating 50 users...');
  const users = [];
  for (let i = 0; i < 50; i++) {
    const pubkey = hex(32);
    const name = NAMES[i] + rand(1, 99);
    await post('/api/auth/login', { pubkey, display_name: name });
    users.push({ pubkey, name });
    if ((i + 1) % 10 === 0) process.stdout.write(`   ${i + 1}/50\n`);
  }
  console.log(`   ✅ ${users.length} users created\n`);

  // 2. Create spots
  console.log('📍 Creating 2 spots...');
  const spots = [];
  for (const sl of SURFLINE_SPOTS) {
    const r = await post('/api/spots', sl, users[0].pubkey);
    if (r.id) {
      spots.push(r.id);
      console.log(`   ✅ ${sl.name} → ${r.id}`);
    } else {
      console.log(`   ⚠️  ${sl.name}: ${JSON.stringify(r)}`);
    }
  }

  // 3. Join spots
  console.log('\n👥 Users joining spots...');
  let joined = 0;
  for (let i = 1; i < users.length; i++) {
    const spotId = spots[i % spots.length];
    if (!spotId) continue;
    await post(`/api/spots/${spotId}/join`, {}, users[i].pubkey);
    joined++;
  }
  console.log(`   ✅ ${joined} users joined spots\n`);

  // 4. Create sessions
  console.log('🏄 Creating 500 sessions...');
  const sessionIds = [];
  for (let i = 0; i < 500; i++) {
    const user = pick(users);
    const spotId = spots.length ? pick(spots) : null;
    const body = {
      session_date: randomDate(90),
      time_of_day: pick(TIMES),
      rating: rand(1, 10),
      wave_shape: pick(SHAPES),
      session_type: pick(TYPES),
      barrels: Math.random() < 0.2 ? rand(1, 5) : 0,
      notes: Math.random() < 0.3 ? pick(COMMENTS) : null,
      spot_id: spotId,
    };
    const r = await post('/api/sessions', body, user.pubkey);
    if (r.id) sessionIds.push(r.id);
    if ((i + 1) % 50 === 0) process.stdout.write(`   ${i + 1}/500\n`);
  }
  console.log(`   ✅ ${sessionIds.length} sessions created\n`);

  // 5. Comments
  console.log('💬 Creating 200 comments...');
  let comments = 0;
  for (let i = 0; i < 200; i++) {
    if (!sessionIds.length) break;
    const user = pick(users);
    const sid = pick(sessionIds);
    await post(`/api/sessions/${sid}/comments`, { body: pick(COMMENTS) }, user.pubkey);
    comments++;
    if ((i + 1) % 50 === 0) process.stdout.write(`   ${i + 1}/200\n`);
  }
  console.log(`   ✅ ${comments} comments created\n`);

  // 6. Follows
  console.log('🤝 Creating 100 follows...');
  let follows = 0;
  const followPairs = new Set();
  for (let i = 0; i < 100; i++) {
    const a = pick(users), b = pick(users);
    if (a.pubkey === b.pubkey) continue;
    const key = a.pubkey + b.pubkey;
    if (followPairs.has(key)) continue;
    followPairs.add(key);
    await post(`/api/follows/${b.pubkey}`, {}, a.pubkey);
    follows++;
  }
  console.log(`   ✅ ${follows} follows created\n`);

  console.log('🎉 Seed complete!');
  console.log(`   Users: ${users.length}`);
  console.log(`   Spots: ${spots.length}`);
  console.log(`   Sessions: ${sessionIds.length}`);
  console.log(`   Comments: ${comments}`);
  console.log(`   Follows: ${follows}`);
  return { users, spots, sessionIds };
}

// ===== STRESS =====
async function stress(seededData) {
  console.log(`\n⚡ Stress testing ${BASE}...\n`);

  // Get or create test users
  let users, spots;
  if (seededData) {
    users = seededData.users;
    spots = seededData.spots;
  } else {
    console.log('   Loading existing users/spots...');
    const allUsers = await get('/api/users');
    users = (allUsers || []).slice(0, 50).map(u => ({ pubkey: u.pubkey, name: u.display_name }));
    if (!users.length) {
      console.log('   ❌ No users found. Run `seed` first.');
      return;
    }
    // Get spot IDs from a user's spots
    const userSpots = await get('/api/spots', users[0].pubkey);
    spots = (userSpots || []).map(s => s.id);
    console.log(`   Found ${users.length} users, ${spots.length} spots\n`);
  }

  const spotId = spots[0] || null;
  const results = [];

  function makeRequest() {
    const user = pick(users);
    const r = Math.random();
    let path, method = 'GET', body = null, headers = {};
    if (user.pubkey) headers['X-Nostr-Pubkey'] = user.pubkey;

    if (r < 0.40) {
      path = '/api/feed?limit=10';
    } else if (r < 0.60) {
      path = `/api/sessions?spot_id=${spotId}&limit=20`;
    } else if (r < 0.75) {
      path = `/api/users${spotId ? '?spot_id=' + spotId : ''}`;
    } else if (r < 0.85) {
      method = 'POST';
      headers['Content-Type'] = 'application/json';
      path = '/api/sessions';
      body = JSON.stringify({
        session_date: randomDate(30),
        time_of_day: pick(TIMES),
        rating: rand(1, 10),
        wave_shape: pick(SHAPES),
        barrels: rand(0, 2),
        spot_id: spotId,
      });
    } else if (r < 0.95) {
      path = `/api/analysis/by-direction${spotId ? '?spot_id=' + spotId : ''}`;
    } else {
      path = `/api/conditions?spot_id=${spotId}&date=${randomDate(3)}&time_of_day=${pick(TIMES)}`;
    }

    const start = Date.now();
    return fetch(BASE + path, { method, headers, body })
      .then(res => {
        const ms = Date.now() - start;
        results.push({ path: path.split('?')[0], ms, status: res.status, ok: res.ok });
      })
      .catch(err => {
        results.push({ path: path.split('?')[0], ms: Date.now() - start, status: 0, ok: false, error: err.message });
      });
  }

  const waves = [
    { concurrency: 10, requests: 200, label: 'Wave 1 (10 concurrent)' },
    { concurrency: 25, requests: 500, label: 'Wave 2 (25 concurrent)' },
    { concurrency: 50, requests: 1000, label: 'Wave 3 (50 concurrent)' },
  ];

  for (const wave of waves) {
    console.log(`🌊 ${wave.label}: ${wave.requests} requests...`);
    const waveStart = Date.now();
    const waveResults = results.length;

    for (let sent = 0; sent < wave.requests; ) {
      const batch = Math.min(wave.concurrency, wave.requests - sent);
      await Promise.all(Array.from({ length: batch }, () => makeRequest()));
      sent += batch;
    }

    const waveMs = Date.now() - waveStart;
    const waveData = results.slice(waveResults);
    const times = waveData.map(r => r.ms).sort((a, b) => a - b);
    const errors = waveData.filter(r => !r.ok).length;
    console.log(`   Done in ${(waveMs / 1000).toFixed(1)}s | ${(wave.requests / (waveMs / 1000)).toFixed(0)} req/s | Errors: ${errors}/${wave.requests}`);
    console.log(`   p50: ${times[Math.floor(times.length * 0.5)]}ms | p95: ${times[Math.floor(times.length * 0.95)]}ms | p99: ${times[Math.floor(times.length * 0.99)]}ms\n`);
  }

  // Summary by endpoint
  console.log('📊 Results by endpoint:');
  console.log('─'.repeat(80));
  console.log(`${'Endpoint'.padEnd(35)} ${'Count'.padStart(6)} ${'Errors'.padStart(7)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)}`);
  console.log('─'.repeat(80));

  const byPath = {};
  for (const r of results) {
    if (!byPath[r.path]) byPath[r.path] = [];
    byPath[r.path].push(r);
  }
  for (const [path, data] of Object.entries(byPath).sort()) {
    const times = data.map(r => r.ms).sort((a, b) => a - b);
    const errors = data.filter(r => !r.ok).length;
    console.log(
      `${path.padEnd(35)} ${String(data.length).padStart(6)} ${String(errors).padStart(7)} ${String(times[Math.floor(times.length * 0.5)] + 'ms').padStart(7)} ${String(times[Math.floor(times.length * 0.95)] + 'ms').padStart(7)} ${String(times[Math.floor(times.length * 0.99)] + 'ms').padStart(7)}`
    );
  }
  console.log('─'.repeat(80));
  console.log(`Total: ${results.length} requests, ${results.filter(r => !r.ok).length} errors\n`);
}

// ===== MAIN =====
(async () => {
  console.log(`\n🏄‍♂️ Swellnotes Load Test — ${isProd ? 'PRODUCTION' : 'LOCAL'}`);
  console.log(`   Target: ${BASE}\n`);

  let seeded = null;
  if (mode === 'seed' || mode === 'all') seeded = await seed();
  if (mode === 'stress' || mode === 'all') await stress(seeded);
  if (!['seed', 'stress', 'all'].includes(mode)) {
    console.log('Usage: node test/loadtest.js [seed|stress|all] [--prod]');
  }
})();
