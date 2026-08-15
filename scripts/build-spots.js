// One-off: pull real Surfline spot IDs for a curated list of famous breaks via the
// working browser, and write curated-spots.json. The server's /api/spots/search then
// filters this baked list (no live Surfline call). Run: node scripts/build-spots.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// { q: search query, want: keyword(s) the result name should contain }
const WANT = [
  ['Pipeline', 'pipeline'], ['Sunset Beach Hawaii', 'sunset'], ['Waikiki', 'waikiki'], ['Honolua', 'honolua'], ['Jaws', 'jaws'],
  ['Uluwatu', 'uluwatu'], ['Padang Padang', 'padang'], ['Canggu', 'canggu'], ['Keramas', 'keramas'], ['Desert Point', 'desert point'],
  ['Upper Trestles', 'trestles'], ['Lower Trestles', 'trestles'], ['Malibu', 'malibu'], ['Rincon', 'rincon'], ['Steamer Lane', 'steamer'],
  ['Ocean Beach San Francisco', 'ocean beach'], ['Mavericks', 'mavericks'], ['Blacks', 'blacks'], ['Huntington', 'huntington'], ['Swamis', 'swami'],
  ['Mundaka', 'mundaka'], ['Nazare', 'nazar'], ['Ericeira', 'ericeira'], ['Supertubos', 'supertubos'], ['La Graviere', 'graviere'],
  ['Fistral', 'fistral'], ['Thurso', 'thurso'], ['Lahinch', 'lahinch'], ['Bundoran', 'bundoran'],
  ['Jeffreys Bay', 'jeffreys'], ['Skeleton Bay', 'skeleton'], ['Anchor Point', 'anchor'],
  ['Snapper Rocks', 'snapper'], ['Bells Beach', 'bells'], ['Byron Bay', 'byron'], ['Noosa', 'noosa'], ['Margaret River', 'margaret'], ['Bondi', 'bondi'],
  ['Raglan', 'raglan'], ['Teahupoo', 'teahupo'], ['Cloudbreak', 'cloudbreak'],
  ['Puerto Escondido', 'escondido'], ['Chicama', 'chicama'], ['Punta de Lobos', 'lobos'], ['Pico Alto', 'pico'],
  ['Tamarindo', 'tamarindo'], ['Playa Hermosa', 'hermosa'], ['Santa Teresa', 'teresa'], ['Pavones', 'pavones'], ['Dominical', 'dominical'],
];

async function main() {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' });
  const page = await ctx.newPage();
  await page.goto('https://services.surfline.com/search/site?q=pipeline&querySize=5', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const out = [], seen = new Set();
  for (const [q, want] of WANT) {
    try {
      const hit = await page.evaluate(async ({ q, want }) => {
        const r = await fetch(`https://services.surfline.com/search/site?q=${encodeURIComponent(q)}&querySize=12`, { headers: { accept: 'application/json' } });
        if (!r.ok) return null;
        const data = await r.json();
        const spots = [];
        for (const block of data) for (const h of (block?.hits?.hits || [])) {
          if (h._source && h._source.type === 'spot' && h._source.location && h._source.name) spots.push(h);
        }
        if (!spots.length) return null;
        const best = spots.find(h => h._source.name.toLowerCase().includes(want)) || null; // strict: name must match
        if (!best) return null;
        return { id: best._id, name: best._source.name, crumbs: best._source.breadCrumbs || [], loc: best._source.location };
      }, { q, want });
      if (hit && hit.id && !seen.has(hit.id)) {
        seen.add(hit.id);
        out.push({ surfline_id: hit.id, name: hit.name, location: (hit.crumbs || []).join(', '), lat: hit.loc?.lat ?? null, lng: hit.loc?.lon ?? hit.loc?.lng ?? null });
        console.log(`  OK  ${q} -> ${hit.name} [${(hit.crumbs || []).join(' / ')}]`);
      } else {
        console.log(`  --  ${q} -> (no clean spot match)`);
      }
    } catch (e) { console.log(`  ERR ${q} -> ${e.message}`); }
    await page.waitForTimeout(400);
  }
  await b.close();
  fs.writeFileSync(path.join(__dirname, '..', 'curated-spots.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${out.length} spots`);
}
main().catch((e) => { console.error(e); process.exit(1); });
