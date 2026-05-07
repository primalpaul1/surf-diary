#!/usr/bin/env node
// Wipe all user-generated data from the database. Leaves schema intact.
// Usage:
//   node test/wipe-data.js --confirm                    # local SQLite
//   DATABASE_URL=postgres://... node test/wipe-data.js --confirm   # remote Postgres

const path = require('path');

if (!process.argv.includes('--confirm')) {
  console.error('Refusing to run without --confirm flag. This deletes ALL user data.');
  process.exit(1);
}

const TABLES = [
  'comments',
  'sessions',
  'spot_join_requests',
  'spot_invites',
  'spot_follows',
  'spot_members',
  'spots',
  'follows',
  'reports',
  'blocks',
  'forecast_cache',
  'users',
];

const USE_PG = !!process.env.DATABASE_URL;

(async () => {
  let exec;
  if (USE_PG) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    exec = async (sql) => pool.query(sql);
    console.log(`📦 Wiping PostgreSQL: ${process.env.DATABASE_URL.slice(0, 40)}...`);
    for (const t of TABLES) {
      try { await exec(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`); console.log(`  ✅ ${t}`); }
      catch (e) { console.log(`  ⚠️  ${t}: ${e.message}`); }
    }
    await pool.end();
  } else {
    const Database = require('better-sqlite3');
    const sq = new Database(path.join(__dirname, '..', 'swellnotes.db'));
    sq.pragma('foreign_keys=OFF');
    console.log('📦 Wiping local SQLite (swellnotes.db)');
    for (const t of TABLES) {
      try { sq.exec(`DELETE FROM ${t}`); console.log(`  ✅ ${t}`); }
      catch (e) { console.log(`  ⚠️  ${t}: ${e.message}`); }
    }
    try { sq.exec(`DELETE FROM sqlite_sequence`); } catch {}
    sq.close();
  }
  console.log('Done.');
})();
