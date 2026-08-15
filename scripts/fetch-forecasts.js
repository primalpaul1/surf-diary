// Scheduled Surfline forecast fetcher — runs OFF the prod box (GitHub Actions).
// A real headless Chromium solves Cloudflare's JS challenge on surfline.com, then
// pulls the kbyg wave/wind/tide JSON per spot and POSTs it to the prod ingest
// endpoint. Prod stays light; getForecast just serves the cache these writes fill.
//
// Env: INGEST_URL (default prod), INGEST_SECRET (required unless DRY_RUN).
// DRY_RUN=1 -> fetch + log only (no server calls), for local testing.
const { chromium } = require('playwright');

const INGEST_URL = process.env.INGEST_URL || 'https://swellnotes.com';
const SECRET = process.env.INGEST_SECRET;
const DRY_RUN = !!process.env.DRY_RUN;
const H = { 'x-ingest-secret': SECRET || '', 'content-type': 'application/json' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

async function getSpotIds() {
  if (DRY_RUN) return ['5842041f4e65fad6a7708b9c', '640a2d6099dd44b5c4fe8af0'];
  const r = await fetch(`${INGEST_URL}/api/forecast/spots`, { headers: H });
  if (!r.ok) throw new Error(`spots list failed: ${r.status}`);
  return (await r.json()).spots || [];
}

async function main() {
  if (!SECRET && !DRY_RUN) { console.error('INGEST_SECRET not set'); process.exit(1); }
  const spots = await getSpotIds();
  console.log(`Fetching ${spots.length} spot(s): ${spots.join(', ')}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();

  // Land on a real forecast page so Cloudflare grants clearance for the kbyg API.
  await page.goto('https://www.surfline.com/surf-report/dominical/5842041f4e65fad6a7708b9c', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000); // let the JS challenge settle

  let ok = 0, fail = 0;
  for (const spotId of spots) {
    try {
      const data = await page.evaluate(async (id) => {
        const base = 'https://services.surfline.com/kbyg/spots/forecasts';
        const q = `spotId=${id}&days=3&intervalHours=3`;
        const j = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' } }); return r.ok ? r.json() : null; };
        const [wave, wind, tides] = await Promise.all([
          j(`${base}/wave?${q}&units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT`),
          j(`${base}/wind?${q}&units%5BwindSpeed%5D=MPH`),
          j(`https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${id}&days=3&units%5BtideHeight%5D=FT`),
        ]);
        return {
          wave: wave?.data || { wave: [] },
          wind: wind?.data || { wind: [] },
          tides: tides?.data || { tides: [] },
          utcOffset: (wave?.associated?.utcOffset ?? -6),
        };
      }, spotId);

      const wc = data?.wave?.wave?.length || 0;
      if (!wc) { console.log(`  ${spotId}: no wave data (blocked?), skip`); fail++; }
      else if (DRY_RUN) { console.log(`  ${spotId}: ${wc} wave pts | first surf=${JSON.stringify(data.wave.wave[0].surf)} (dry-run, not ingested)`); ok++; }
      else {
        const ing = await fetch(`${INGEST_URL}/api/forecast/ingest`, { method: 'POST', headers: H, body: JSON.stringify({ surfline_spot_id: spotId, data }) });
        if (ing.ok) { console.log(`  ${spotId}: ${wc} wave pts -> ingested`); ok++; }
        else { console.log(`  ${spotId}: ingest failed ${ing.status}`); fail++; }
      }
    } catch (e) { console.log(`  ${spotId}: error ${e.message}`); fail++; }
    await page.waitForTimeout(700);
  }

  await browser.close();
  console.log(`Done. ok=${ok} fail=${fail}`);
  if (ok === 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
