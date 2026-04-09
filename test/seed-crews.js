const crypto = require('crypto');

const isProd = process.argv.includes('--prod');
const BASE = isProd ? 'https://swellnotes.com' : 'http://localhost:3000';

function hex(n) { return crypto.randomBytes(n).toString('hex'); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomDate(daysBack) {
  const d = new Date(); d.setDate(d.getDate() - rand(0, daysBack));
  return d.toISOString().split('T')[0];
}

async function post(path, body, pubkey) {
  const headers = { 'Content-Type': 'application/json' };
  if (pubkey) headers['X-Nostr-Pubkey'] = pubkey;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return r.json();
}
async function put(path, body, pubkey) {
  const headers = { 'Content-Type': 'application/json' };
  if (pubkey) headers['X-Nostr-Pubkey'] = pubkey;
  const r = await fetch(BASE + path, { method: 'PUT', headers, body: JSON.stringify(body) });
  return r.json();
}
async function get(path, pubkey) {
  const headers = {};
  if (pubkey) headers['X-Nostr-Pubkey'] = pubkey;
  return (await fetch(BASE + path, { headers })).json();
}

const CREWS = [
  { surfline_spot_id: '5842041f4e65fad6a7708890', name: 'Pipeline', location_text: "O'ahu, Hawaii", region: 'North Shore', description: 'The most famous wave in the world. Heavy barrels over shallow reef.', lat: 21.665, lng: -158.053 },
  { surfline_spot_id: '5842041f4e65fad6a7708b4b', name: 'Uluwatu', location_text: 'Bali, Indonesia', region: 'Bukit Peninsula', description: 'World-class left-hander breaking over a cliff-lined reef.', lat: -8.815, lng: 115.085 },
  { surfline_spot_id: '5842041f4e65fad6a7708d0f', name: 'J-Bay', location_text: 'Eastern Cape, South Africa', region: 'Jeffreys Bay', description: 'One of the best right-hand point breaks on the planet.', lat: -34.042, lng: 24.932 },
  { surfline_spot_id: '5842041f4e65fad6a7708887', name: 'Trestles', location_text: 'San Diego, California', region: 'Southern California', description: 'High-performance cobblestone point break. CT stop.', lat: 33.382, lng: -117.589 },
  { surfline_spot_id: '5842041f4e65fad6a7708be5', name: 'Snapper Rocks', location_text: 'Gold Coast, Australia', region: 'Gold Coast', description: 'Fast, hollow right-handers. Home of the Superbank.', lat: -28.166, lng: 153.552 },
  { surfline_spot_id: '5842041f4e65fad6a7708814', name: 'Rincon', location_text: 'Santa Barbara, California', region: 'Central California', description: 'Queen of the coast. Classic right-hand point break.', lat: 34.374, lng: -119.476 },
  { surfline_spot_id: '5842041f4e65fad6a7708c88', name: 'Mundaka', location_text: 'Basque Country, Spain', region: 'Northern Spain', description: 'Epic left-hand rivermouth barrel in the Basque Country.', lat: 43.406, lng: -2.698 },
  { surfline_spot_id: '5842041f4e65fad6a7708b9c', name: 'Dominical', location_text: 'Puntarenas, Costa Rica', region: 'Central Pacific', description: 'Powerful beach break with heavy barrels. Warm water year-round.', lat: 9.25, lng: -83.86 },
];

const SURFER_NAMES = {
  'Pipeline': ['NorthShoreNick','PipeMaster','EddieLives','TubeCity','BackdoorBandit','ReefWalker','SunsetSam','HaleiwaTom','WaimeaWill','TripleCrown','VolcomHouse','PipeDreamer','RockyPoint','LogCabins','VLand'],
  'Uluwatu': ['BaliBliss','UluCrew','TempleSurfer','MonkeyForest','PaddyRice','IndoBarrel','BukitBro','ReefRunner','ClifftopKai','WaxOnBali','SingleFin','BoardShorts','SunsetUlu','CoralReef','RiceField'],
  'J-Bay': ['SuperTubes','JBayLocal','SafariSurfer','EasternCape','PointBreak','KellySlater','AndrewKidman','BoneyardBob','InnerPool','MagnaTubes','AlbatrossSurf','EndlessSummer','SunshineSA','CapeTown','DurbanVibes'],
  'Trestles': ['UpperLower','SanOSurfer','CobblesKing','CalifDream','TrestlesTom','FilipeToledo','WCTLocal','Cottons','ChurchBob','MidTrestle','DanaPoint','OsideCrew','PendletonSurf','BasePaths','TrailRunner'],
  'Snapper Rocks': ['GoldCoastGaz','SnapperKing','SuperBank','CoolangattaCrew','KirraCutback','DBarrels','GreenmountGuy','RainbowBay','TweedHeads','PointDanger','BurleighBob','PalmBeach','CurrumbinCrew','SouthStraddie','NorthWall'],
  'Rincon': ['QueenOfCoast','RinconRoy','IndicatorIan','CoveMaster','VenturaVibes','SBSurfer','RiverMouth','OilPiers','StanleysPeak','C_Street','MondosSurf','EmmaWood','FariaSurf','PitasSurf','SeacliffSurf'],
  'Mundaka': ['BasqueBomber','MundakaMike','RiverBarrel','BizkaiaBro','GuernicaSurf','BilbaoWave','SpainBarrel','AtlanticSwell','BayOfBiscay','CantabriaCrew','NorthSpain','EuskadiSurf','PintxoSurfer','TxakoliTom','GasteizGaz'],
  'Dominical': ['JungleSurfer','DomBarrel','CostaLocal','PuraVida','TicoTubes','ManuelAntonio','OsaPeninsula','UvitaSurf','MataPalo','PavonesPat','QueposCrew','PlayaHermosa','RioClaro','BocaBarranca','JacoJake'],
};

const TIMES = ['5am','6am','7am','8am','9am','10am','11am','12pm','1pm','2pm','3pm','4pm'];
const SHAPES = ['peaky','barreling','rippable','mushy','blown out','closed out'];
const COMMENTS = [
  'Pumping!','Best session in weeks','So fun out there','Epic barrels all morning',
  'Crowd was manageable today','Glassy and clean','Got a few bombs','Dawn patrol paid off',
  'Wind came up around noon','Solid overhead sets','Bit of a closeout fest','Perfect conditions',
  'That swell delivered','Can\'t wait to go back','Pure magic','Board felt great today',
  'Should have gone earlier','Caught the set of the day','Offshore all morning','Party waves!',
];

(async () => {
  console.log(`\n🏄 Seeding crews on ${BASE}...\n`);

  // Step 1: Clean up broken test crews (null names, 1 member)
  console.log('🧹 Cleaning up broken test crews...');
  const allSpots = await get('/api/spots/browse');
  let cleaned = 0;
  // We can't delete spots via API, so we'll just leave them and create new good ones

  for (const crew of CREWS) {
    console.log(`\n📍 ${crew.name} (${crew.location_text})`);

    // Create admin user for this crew
    const adminPk = hex(32);
    const adminName = SURFER_NAMES[crew.name][0];
    await post('/api/auth/login', { pubkey: adminPk, display_name: adminName });

    // Create the crew (public)
    const spotRes = await post('/api/spots', { ...crew, is_private: false }, adminPk);
    if (!spotRes.id) {
      console.log(`   ⚠️  Failed: ${JSON.stringify(spotRes)}`);
      continue;
    }
    const spotId = spotRes.id;
    console.log(`   ✅ Created → ${spotId}`);

    // Create 14 more members
    const members = [{ pubkey: adminPk, name: adminName }];
    const names = SURFER_NAMES[crew.name].slice(1);
    for (const name of names) {
      const pk = hex(32);
      await post('/api/auth/login', { pubkey: pk, display_name: name + rand(1, 99) });
      await post(`/api/spots/${spotId}/join`, {}, pk);
      members.push({ pubkey: pk, name });
    }
    console.log(`   👥 ${members.length} members joined`);

    // Create 40-60 sessions per crew, spread over 90 days
    const sessionCount = rand(40, 60);
    const sessionIds = [];
    for (let i = 0; i < sessionCount; i++) {
      const user = pick(members);
      const r = await post('/api/sessions', {
        session_date: randomDate(90),
        time_of_day: pick(TIMES),
        rating: rand(3, 10),
        wave_shape: pick(SHAPES),
        session_type: Math.random() < 0.85 ? 'surfed' : 'observed',
        barrels: Math.random() < 0.25 ? rand(1, 4) : 0,
        notes: Math.random() < 0.4 ? pick(COMMENTS) : null,
        spot_id: spotId,
      }, user.pubkey);
      if (r.id) sessionIds.push(r.id);
    }
    console.log(`   🏄 ${sessionIds.length} sessions logged`);

    // Add comments
    const commentCount = rand(15, 30);
    for (let i = 0; i < commentCount; i++) {
      if (!sessionIds.length) break;
      await post(`/api/sessions/${pick(sessionIds)}/comments`, { body: pick(COMMENTS) }, pick(members).pubkey);
    }
    console.log(`   💬 ${commentCount} comments`);

    // Add some follows between members
    const followCount = rand(10, 20);
    const pairs = new Set();
    for (let i = 0; i < followCount; i++) {
      const a = pick(members), b = pick(members);
      if (a.pubkey === b.pubkey) continue;
      const key = a.pubkey + b.pubkey;
      if (pairs.has(key)) continue;
      pairs.add(key);
      await post(`/api/follows/${b.pubkey}`, {}, a.pubkey);
    }
    console.log(`   🤝 ${pairs.size} follows`);
  }

  console.log('\n\n🎉 All crews seeded!\n');
  console.log('Crews created:');
  CREWS.forEach(c => console.log(`   🌊 ${c.name} — ${c.location_text}`));
  console.log('\nAll crews are PUBLIC — you can join any of them from the app.\n');
})();
