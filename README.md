# Casa Court

A real, working prototype -- event-scoped, two roles, Supabase-backed, deployable as static
files to Cloudflare Pages. This directly answers the two things you asked to stress-test:

1. **CSV/manual roster entry -> draft -> review -> publish**, with partner/opponent history
   committed at publish (not at score entry), so drafting rounds ahead of check-in is always safe.
2. **A linked, read-only participant view** (`/live/?e=<eventId>`) that updates in real time off
   the same Supabase tables the organizer console writes to -- no separate copies of the app.

## What's actually built vs. what's in the spec doc

Built and working: event creation, CSV/manual roster import, six-state check-in
(not arrived / late / checked in / temporarily unavailable / no-show / withdrawn), walk-ins,
draft -> review (warnings) -> publish rounds, the full penalty-weighted matchmaking algorithm
from your spec's section 21, score entry, score correction with stat reversal, King/Queen/Overall
leaderboards, tie detection, realtime sync to `/live`.

Deliberately deferred (so this shipped as a working prototype instead of stalling on scope):
- **`/display`** (TV board) -- not built, but trivial once you want it: it's the same query as
  `/live`, just a different layout with no nav/search. Ten-minute add later.
- **Manual swap/remove/add-player on a draft, and "regenerate one court only"** -- the UI only
  supports full regenerate right now. `lib/scheduler.js` already exports `swapPlayers` for this,
  it's just not wired into the Match Control screen yet.
- **3+-way tiebreakers** (bracket/round-robin) -- only the 2-player singles case you actually
  asked for is in the leaderboard UI as a flag; resolving it is still a manual, off-system match.
- **Event Log / audit trail** -- score corrections recompute stats correctly but don't write a
  visible log entry yet.
- **CSV export at close** -- not built.

## One rule change from what we tested earlier -- flagging it, not hiding it

Your spec's penalty function (section 21) lists "back-to-back play" as a **soft** 500-point
penalty, not a hard rule. Earlier in this project we explicitly tested and verified a **hard**
mandatory rest gap (no player in two consecutive rounds, no exceptions). I implemented a hybrid:
the rest gap is enforced as hard by default, and *only* relaxes to a soft penalty if enforcing it
would leave fewer than 4 eligible players for a round (i.e., attendance is too low to honor it).
That reconciles your two stated goals -- 6-7 games/player (which strict rest-gap alone couldn't
hit, we measured ~4.8) and a rest gap that doesn't break the event when attendance dips. Worth
double-checking this matches what you actually want before relying on it.

## 1. Set up Supabase (10 min)

1. https://supabase.com -> new project (free tier is enough for this).
2. **SQL Editor** -> paste and run `supabase-schema.sql` from this repo.
3. **Database > Replication** -> confirm `events`, `players`, `rounds`, `matches` are enabled for
   realtime (the schema script's last line does this, but double check it took).
4. **Project Settings > API** -> copy the Project URL and the `anon` public key.

## 2. Configure and test locally

```bash
cp .env.local.example .env.local   # paste in your Supabase URL + anon key
npm install
npm run dev
```

Visit `http://localhost:3000/admin/` -> create an event -> you land on
`/admin/event/?e=<uuid>`. Open `/live/?e=<uuid>` in a second tab (or your phone, same wifi, using
your machine's local IP) and watch it update live as you check people in and publish rounds.

## 3. Deploy to Vercel

1. Push this folder to a GitHub repo.
2. https://vercel.com -> **New Project** -> import that repo. Vercel auto-detects Next.js, no
   build settings to change.
3. In **Settings > Environment Variables**, add `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (same values as your `.env.local`).
4. Deploy. You get a `*.vercel.app` URL immediately -- enough to stress-test from your phone
   before touching DNS.

Event URLs are now real paths (`/admin/<uuid>`, `/live/<uuid>`), not query strings -- that only
works because Vercel server-renders `[eventId]` routes on demand. If you ever move back to a
purely static host (Cloudflare Pages, GitHub Pages, S3), you'd need the query-string version from
before, since static export can't generate pages for event IDs that don't exist yet at build time.

## 4. Attaching it to everydaycasa.ph

**Option A -- subdomain (simple, ~5 min):** In the Vercel project, **Settings > Domains** -> add
`court.everydaycasa.ph`. Vercel gives you a CNAME to add in your DNS for `everydaycasa.ph`. SSL
auto-issues. This is what I'd do first if you don't specifically need the subpath.

**Option B -- `everydaycasa.ph/casa-events` via a Cloudflare Worker:** this is what you'd use if
`everydaycasa.ph` itself is hosted somewhere that isn't Vercel (e.g. Shopify) and Cloudflare sits
in front of it as your DNS/proxy. A Worker intercepts requests to that one path and forwards them
to this app's Vercel deployment, so visitors never see the Vercel URL. Steps:

1. **Set the app's base path.** In Vercel, **Settings > Environment Variables**, add
   `NEXT_PUBLIC_BASE_PATH` = `/casa-events`, then redeploy. This is required -- without it, the
   app's CSS/JS/image requests will point at the wrong paths once it's living under a subpath.
   (`next.config.mjs` already reads this var; the code is ready for it.)
2. **Note your Vercel hostname** -- the `*.vercel.app` domain (or custom domain) this project
   deploys to. You'll need it in step 4.
3. **Install Wrangler** (Cloudflare's CLI) if you don't have it: `npm install -g wrangler`, then
   `wrangler login`.
4. **Edit `cloudflare-worker/worker.js`** -- replace `VERCEL_ORIGIN` at the top with your actual
   Vercel hostname from step 2.
5. **Deploy the Worker:** `cd cloudflare-worker && wrangler deploy`.
6. **Add the Route.** In the Cloudflare dashboard: your `everydaycasa.ph` zone -> **Workers
   Routes** -> add route `everydaycasa.ph/casa-events*` -> pointing at the `casa-events-proxy`
   Worker you just deployed.
7. Visit `everydaycasa.ph/casa-events/admin` -- it should load the app while the address bar
   still shows your own domain.

This only works if `everydaycasa.ph`'s DNS is actually managed through Cloudflare (orange-clouded,
not just using Cloudflare as a registrar) -- Workers Routes are a Cloudflare-proxy feature. If
you're not sure whether that's the case for your setup, check Cloudflare's dashboard for the zone;
if `everydaycasa.ph` isn't listed there as an active zone, this approach isn't available and
Option A (subdomain) is the realistic path.

## 5. QR code

The Event Manager page (`/admin`) prints the exact `/live/<uuid>` link for each event -- paste
that into any QR generator, or I can generate one as an artifact once you have a real event ID.
