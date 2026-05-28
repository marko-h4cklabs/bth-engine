# BTH Engine

Balkan Trojan Horse — Automated B2B acquisition dossier generator.
Targets premium Zagreb businesses with physical intelligence dossiers + AI-powered audits.

---

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Playwright Chromium (installed automatically via `pnpm install`)

---

## Setup

1. Clone the repo
2. `pnpm install`
3. `pnpm download-fonts` (one-time — downloads variable WOFF2 fonts for PDF rendering)
4. Copy `.env.example` to `.env` and fill in all values (see table below)
5. `pnpm exec bth seed-niches`
6. `pnpm exec bth seed-casestudies` (replace placeholder metrics with real data afterward)

---

## Required .env values

| Key | Required | Description | Where to get it |
|-----|----------|-------------|-----------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key | console.anthropic.com |
| `GOOGLE_PLACES_API_KEY` | Yes | Google Places API key | console.cloud.google.com → Places API |
| `AGENCY_NAME` | Yes | Your agency name | — |
| `AGENCY_DOMAIN` | Yes | Your domain (`https://...`) | — |
| `CALENDLY_URL` | Yes | Booking link for closer | calendly.com |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token | @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID | `api.telegram.org/bot{token}/getUpdates` |
| `TRACKER_URL` | Yes | Public URL of tracker server | Your VPS or ngrok URL (e.g. `https://xyz.ngrok.io`) |
| `TRACKER_PORT` | No | Tracker listen port | Default: `3456` |
| `DEPLOY_MODE` | No | `local` or `vercel` | Default: `local` |
| `OUTPUT_DIR` | No | Output directory | Default: `./output` |

---

## Weekly workflow

```
MONDAY — Research
  1. Find target on companywall.hr
  2. Copy their CompanyWall URL
  3. Run: pnpm exec bth generate "{URL}" --niche {niche}
  4. Run: pnpm exec bth export {slug}
  5. Review PDF: pnpm exec bth open {slug}

TUESDAY — Prepare
  6. Send output/export/{slug}/DOSJE_*.pdf to print shop
     (see DELIVERY_NOTE.txt for exact print instructions)
  7. Upload output/export/{slug}/landing/ to web server
  8. Test QR code scans correctly
  9. Run: pnpm exec bth update-status {slug} printed

WEDNESDAY/THURSDAY — Deliver
  10. Courier delivers envelope to business address
  11. Run: pnpm exec bth update-status {slug} delivered
  12. Start tracker: pnpm tracker (leave running)

FRIDAY — Close
  13. Wait for Telegram notification (director opened landing page)
  14. Call within 20 minutes of notification
  15. Book 15-minute meeting
  16. Run: pnpm exec bth update-status {slug} called
```

---

## Available commands

| Command | Description | Example |
|---------|-------------|---------|
| `bth generate <url>` | Run the full pipeline — scrape, audit, PDF, landing page | `bth generate "https://www.companywall.hr/tvrtka/..." --niche estetska-medicina` |
| `bth list` | Show all clients with status, AI score, and verdict | `bth list` |
| `bth status <slug>` | Show full detail for one client record | `bth status poliklinika-bagatin-d-o-o-zagreb` |
| `bth update-status <slug> <status>` | Move client through the pipeline | `bth update-status poliklinika-bagatin-d-o-o-zagreb delivered` |
| `bth open <slug>` | Open the PDF and landing page in your default viewer | `bth open poliklinika-bagatin-d-o-o-zagreb` |
| `bth export <slug>` | Build a delivery folder with PDF, landing page, and print instructions | `bth export poliklinika-bagatin-d-o-o-zagreb` |
| `bth notify-test <slug>` | Fire a test Telegram notification to verify bot setup | `bth notify-test poliklinika-bagatin-d-o-o-zagreb` |
| `bth seed-niches` | Populate the niches table with default Zagreb niches | `bth seed-niches` |
| `bth seed-casestudies` | Seed placeholder case study metrics | `bth seed-casestudies` |

Valid statuses (in order): `generated` → `printed` → `delivered` → `called` → `meeting` → `signed` / `dead`

---

## Tracker server

The tracker server bridges landing page visits to Telegram notifications. The Telegram bot token never appears in client-side HTML.

**Run on a machine with a public IP (VPS, DigitalOcean, etc.):**

```bash
pnpm tracker
```

Set `TRACKER_URL` in `.env` to the public URL of that machine, e.g. `https://your-vps.com`.

**Local testing with ngrok:**

```bash
npx ngrok http 3456
# Copy the https URL → set TRACKER_URL=https://xyz.ngrok.io in .env
pnpm tracker
```

**Preview landing pages locally (HTTP, not file://):**

```bash
pnpm preview
# Opens output/pages/ at http://localhost:5000
```

---

## Print guide

Take `DOSJE_*.pdf` to any digital print shop and say:

> "Molim ispis na 170-200g mat Kunstdruck papiru, A4 format, puni kolor,
> 5 stranica, jedna kopija. Nemojte rezati bleed oznake ako su vidljive."

Full instructions are in `output/export/{slug}/DELIVERY_NOTE.txt` after running `bth export`.

---

## Supported niches

| Slug | Croatian label |
|------|----------------|
| `estetska-medicina` | Estetska medicina |
| `stomatologija` | Stomatologija |
| `fitnes` | Fitnes |
| `nekretnine` | Nekretnine |
| `wellness` | Wellness |

Add new niches directly to the SQLite database at `data/bth.db` using any SQLite client.
