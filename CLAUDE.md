# Swellnotes

Surf session logging app. Users log when they surfed, rate the session 1-10, and optionally leave voice memos and video clips. Surf conditions (swell, wind, tide) are auto-fetched from Surfline's API. The goal is to build a permanent record that cross-references swell data with human ratings to predict when the surf will be good.

## Production

**https://swellnotes.com**

Hosted on Hetzner (5.78.133.92), auto-deploys from `primalpaul1/surf-diary` on GitHub push via webhook.

## Run Locally

```bash
cd ~/surf-diary && npm start
# Server at http://localhost:3000
```

## Tech Stack

- **Backend**: Node.js + Express + better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS (no framework), ES modules loaded from esm.sh for nostr-tools
- **Database**: SQLite at `./swellnotes.db`
- **Auth**: Nostr keypairs — local generation or NIP-46 remote signing via Primal
- **Fonts**: DM Serif Display (headlines) + Outfit (body) from Google Fonts

## Surfline API

Live forecast data for Dominical, Costa Rica.

- **Spot ID**: `5842041f4e65fad6a7708b9c`
- **Endpoints** (all GET, server-side fetch with User-Agent header):
  - Wave: `https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=...&days=3&intervalHours=3&units[swellHeight]=FT&units[waveHeight]=FT`
  - Wind: `https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=...&days=3&intervalHours=3&units[windSpeed]=MPH`
  - Tides: `https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=...&days=3`
- **Cache**: Stored in `forecast_cache` table, reused if < 2 hours old
- **Units**: ALL in feet and mph. Tide heights converted from meters via `metersToFeet()`. Never use meters.
- **Swells**: Surfline returns up to 6 swell components per forecast entry. All with height > 0 are stored as JSON array in `swells_json`. Each has: `height_ft`, `period_s`, `direction_deg`, `direction_compass`, `impact` (percentage).

## Database Schema

### users
| Column | Type | Notes |
|--------|------|-------|
| pubkey | TEXT PK | Nostr hex pubkey |
| display_name | TEXT | User-chosen name |
| avatar_path | TEXT | `/avatars/filename.jpg` or null |
| created_at | INTEGER | Unix timestamp |

### sessions
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| pubkey | TEXT FK | Who logged it |
| session_date | TEXT | `YYYY-MM-DD` |
| time_of_day | TEXT | `5am` through `6pm` (hourly). Legacy values: `dawn`, `morning`, `midday`, `afternoon`, `evening` |
| swells_json | TEXT | JSON array of all swell components |
| surf_height_min_ft, surf_height_max_ft | REAL | Auto from Surfline |
| wind_speed_mph, wind_direction_deg, wind_type, wind_gust_mph | REAL/TEXT | Auto from Surfline |
| tide_height_ft | REAL | Auto from Surfline (converted from meters) |
| rating | INTEGER | User rating 1-10 |
| notes | TEXT | Optional text |
| voice_memo_path | TEXT | `/audio/filename.webm` or null |
| voice_transcript | TEXT | Browser Speech API transcription |
| video_path | TEXT | `/videos/filename.mp4` or null |
| created_at | INTEGER | Unix timestamp |

### comments
| Column | Type |
|--------|------|
| id | INTEGER PK |
| session_id | INTEGER FK → sessions |
| pubkey | TEXT FK → users |
| body | TEXT |
| created_at | INTEGER |

### follows
| Column | Type |
|--------|------|
| follower_pubkey | TEXT |
| followed_pubkey | TEXT |
| PRIMARY KEY | (follower_pubkey, followed_pubkey) |

### forecast_cache
Stores raw Surfline API responses. `data_json` contains `{wave, wind, tides, utcOffset}`.

## Authentication

Two login methods:

### 1. Local Account Creation
- User picks a surfer name + optional avatar photo
- Client generates Nostr keypair via `nostr-tools` (loaded from `esm.sh`)
- Keypair stored in `localStorage` as `swellnotes_user`
- Secret key stays client-side only

### 2. NIP-46 Primal Login
- Server generates ephemeral keypair + secret via `/api/nip46/init`
- Desktop: QR code shown, user scans with Primal app
- Mobile: Deep link button (`nostrconnect://` URI) redirects to Primal, callback to `/login-callback.html`
- Client listens on `wss://relay.primal.net` for kind 24133 ACK event
- Callback page (`/login-callback.html`) handles iOS Safari redirect recovery
- Connection data saved to `localStorage` as `nip46_connected`
- Reference implementation: `/tmp/instagram-to-nostr-v2/frontend/src/lib/nip46.ts`

### Auth Header
All authenticated requests send `X-Nostr-Pubkey: <hex>` header. Server validates 64-char hex.

## Follow System & Feed

- **Follows table**: `follower_pubkey` → `followed_pubkey`
- **Feed** (`/api/sessions?feed_for=<pubkey>`): Returns sessions from self + all followed users
- **Analysis** (`/api/analysis/*?pubkey=<pubkey>`): Scoped to self + followed users' sessions
- **Surfers tab**: Lists all users with Follow/Following/You buttons

## File Structure

```
swellnotes/
├── server.js              # Express server, Surfline API, all routes
├── swellnotes.db          # SQLite database (gitignored)
├── package.json           # express, better-sqlite3, nostr-tools, qrcode
├── audio/                 # Voice memo .webm files
├── videos/                # Video clip .mp4 files
├── avatars/               # Profile photo .jpg files
└── public/
    ├── index.html         # Single page app shell
    ├── styles.css         # Full stylesheet (cinematic coastal editorial theme)
    ├── app.js             # All client logic (ES module)
    ├── login-callback.html # NIP-46 mobile redirect handler
    ├── primal-logo.png    # Primal wave logo
    └── dominical-hero.jpg # Hero photo of Dominical barrel
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/conditions | No | Surfline forecast for date + time |
| GET | /api/nip46/init | No | Generate NIP-46 QR code + URIs |
| POST | /api/auth/login | No | Register/update user (pubkey + name + optional avatar) |
| GET | /api/users | No | List all users with session counts |
| GET | /api/users/:pubkey | No | Single user profile |
| GET | /api/follows | Yes | Your following/followers lists |
| POST | /api/follows/:pubkey | Yes | Follow a user |
| DELETE | /api/follows/:pubkey | Yes | Unfollow a user |
| GET | /api/sessions | No | List sessions (supports `feed_for`, `pubkey`, `month`, `swell_dir` filters) |
| GET | /api/sessions/:id | No | Session detail with comments |
| POST | /api/sessions | Yes | Log a session (conditions auto-fetched) |
| DELETE | /api/sessions/:id | Yes | Delete your session |
| POST | /api/sessions/:id/comments | Yes | Add comment |
| GET | /api/analysis/by-direction | No | Avg ratings grouped by primary swell direction |
| GET | /api/analysis/best-conditions | No | Top condition combos (2+ sessions) |
| GET | /api/analysis/timeline | No | Daily avg ratings over time |

## Key Conventions

- All measurements in **feet** and **mph**, never meters
- Time options are hourly: `5am` through `6pm` (legacy values `dawn`, `morning`, etc. still supported)
- Swells stored as JSON array, not individual columns — supports all 6 Surfline components
- Media files (audio, video, avatars) saved as base64 in request body, written to disk, path stored in DB
- Frontend loads nostr-tools from `https://esm.sh/nostr-tools@2.10.0` (no bundler)
- CSS uses custom properties extensively (see `:root` in styles.css)
