# Casa Court — Project Handoff

Context for continuing this project in Claude Code. This app runs "Casa King & Queen of the
Court" — a CASA-branded pickleball event (CASA is the organizer's boutique athleisure venture).
Tested against a mock 30-player roster (6 women / 24 men) at a venue called Pickle J's, which
reflects the kind of gender skew to expect at a real event.

---

## 1. User Stories

### Organizer

- Pre-load registered participants before event day via CSV paste, CSV file upload, or manual
  entry — First name, Surname, Nickname, Gender, Level rating. This should not start the event
  clock; that's a separate, explicit action.
- Check participants in at the counter (never self-service) with granular status: Not arrived,
  Late (with an ETA note), Checked in, Temporarily unavailable, No-show, Checked out (withdrawn).
- Add walk-in registrants on the spot, same fields as pre-registered.
- Generate match rounds that respect the full ruleset (below), via **Draft → Review → Publish** —
  nothing commits to partner/opponent history until explicitly published.
- Match generation may produce women's doubles, men's doubles, **or mixed doubles** (one woman +
  one man per team) — no longer strictly segregated. Court-type allocation per round is fully
  automatic (need-aware, then pacing-aware); there's no manual per-division court-count override.
- Be warned, not silently blocked, when a constraint can't be perfectly honored (e.g. rest gap
  relaxed due to low attendance, the partner pool exhausted, or an uneven gender split forcing an
  "edge" composition) — event should keep moving.
- Enter scores per individual match (not per round), each entry identifying court, division, and
  both teams by name.
- Correct a previously entered score with stats properly reversed and reapplied, and logged.
- See a live leaderboard split into King (male) / Queen (female) / Overall, ranked strictly by
  point differential; W-L shown for reference only, never affects rank.
- Be flagged when there's a genuine tie for #1 in a gender category (only after real games have
  been played), to resolve with an off-system singles tiebreaker.
- "Check out" a participant leaving early — removes them from all future match drafts; if they're
  mid-match on a published, unscored round, get warned and offered to cancel that specific match.
- See a real, timestamped Event Log (not decorative) of everything that happened.
- Manage multiple events (Event Manager) — each with its own roster/rounds/matches, not one global
  tournament. See a capacity preview (expected rounds/matches/games-per-player) while setting up
  courts, date, round length, and start/end time.
- Delete an entire test event (roster, rounds, matches, logs — all of it) with confirmation, to
  reset before the real event without touching Supabase manually.

### Participant

- Access a read-only board via a QR code / link — no login, no self check-in.
- See current court/round assignment, partner, and opponents.
- See **Playing now → Up next → Results**, top to bottom, in that order.
- Search their own name to highlight their court in the current/upcoming round.
- See the leaderboard (King / Queen / Overall tabs), point differential visually dominant, W-L
  shown for reference only.
- Never see anyone's skill/level rating — organizer-only data, by design.
- See a simple rules explainer (how ranking works, partner/opponent policy, awards, time limit).

---

## 2. Business Logic & Workflow

**Format:** Doubles. Matchmaking is gender-blind — as of the second matchmaking redesign, gender
plays no role in who gets partnered with or matched against whom (women's doubles, men's doubles,
mixed, and uneven "edge" compositions all fall out of the same unconstrained cost-minimizing
search, whichever happens to have the lowest cost). Gender still matters, just nowhere near
matchmaking: it splits the King/Queen leaderboards and the Dashboard's pacing-between-genders audit
row. Individual ranking by cumulative point differential across all matches — not win/loss.
Wins/losses are reference-only. Awards: King (top male differential), Queen (top female
differential). No 2nd/3rd place awards. A first-place tie within a gender is resolved by an
off-system singles tiebreaker. Hard 4-hour event window — whatever's mid-match when time expires
is finalized at the current score ("time expired" status).

*(History note: an intermediate design required mixed doubles specifically plus a "every player
tries every applicable type at least once" coverage rule, with edge compositions penalized as a
last resort. That was superseded almost immediately — full gender-blindness turned out to be both
what was actually wanted and to measure even better on repeat-opponent diversity. `division` on a
match ('women'/'men'/'mixed'/'edge') is now purely a descriptive label computed after the fact from
who ended up on which team, never a planning input.)*

**Matchmaking priority order** (highest to lowest):
1. **Never repeat partners** — hard constraint (very large penalty in the cost function). Only
   relaxed, with a warning, when the pool of unique partner-pairs available to a player is
   mathematically exhausted (this happens fast with small pools — 6 players only supports 15
   unique pairs).
2. **Rest gap** — a player shouldn't play two rounds back-to-back. Hard-excluded by default;
   automatically relaxed (with a warning) only if enforcing it would leave fewer than 4 eligible
   players overall for the round.
3. **Balance games played / prioritize longest-waiting and latecomers** — priority score weighted
   heavily toward fewest games played, with a wait-time bonus and an extra bonus for players with
   zero games (so late arrivals get folded into rotation quickly rather than queued behind
   everyone).
4. **Minimize repeat opponents** — soft constraint, penalized per prior meeting, never eliminated.
   Gender-blind matchmaking gives every player the widest possible opponent pool (nobody's
   opponents are artificially limited to their own gender) — measured at ~1% repeat-opponent rate
   on the 30-player/6-women/24-men/3-court/16-round reference scenario, down from ~35%+ under the
   original strictly-segregated design.
5. **Avoid back-to-back play as a secondary nudge** — folded into the same cost function alongside
   priority #2's hard exclusion.
6. **Keep court utilization high** — the whole eligible pool (any gender) is ranked by priority and
   the top N×courts players are selected to play, then randomly regrouped into foursomes searching
   for the lowest-cost combination; there's no separate per-gender or per-type allocation step.
7. **Integrate late arrivals fairly** — covered by the zero-games priority bonus in #3.

There is no manual per-round court-count override in the UI (the old "courts for women / courts for
men" inputs were removed along with per-gender pools) — matchmaking is fully automatic.

**Draft → Review → Publish:** Generating a round only produces a client-side draft — nothing is
written to the database. **Publishing is the actual commit point**: this is when partner history,
opponent counts, and last-played-round get written to the `players` table. This deliberately
decouples *assignment history* from *result history*, so drafting/publishing several rounds ahead
of actual play (e.g. only 24/30 checked in, want two rounds ready) is safe — it can't accidentally
create a repeat partner between rounds generated close together. Games played, wins, losses,
points, and point-differential only update when an actual **score** is submitted for a match, not
at publish time.

**Score entry & correction:** Entered per match (court + division + both teams named), never
per-round. Correcting a score reverses the old stat impact and reapplies the new one; assignment
history is untouched; the correction is logged with old→new scores and player names.

**Attendance status model** (six states — this is the actual state machine, don't collapse it):
`not_arrived` (default, ineligible) → `late` (has an ETA note, still ineligible until flipped) →
`checked_in` (eligible, prioritized by games/wait) | `temporarily_unavailable` (excluded from new
drafts, keeps all history) | `no_show` (permanently excluded unless organizer restores it) |
`withdrawn` / "checked out" in the UI (leaving after having played; past results stay valid; if
they have a pending unscored match, organizer is warned and that match gets cancelled).

**Registration vs. walk-in:** Pre-registered via CSV/manual entry before event day. Walk-ins added
same-day through Check-in, immediately `checked_in`. Display name = nickname if set, else first
name — used everywhere (matches, leaderboards). **Level rating is organizer-only** — currently
descriptive/reference only, not yet an input to the matchmaking algorithm itself (worth flagging
as a possible future enhancement) — and must never be exposed on the participant board.

**Leaderboard logic:** Split King (male) / Queen (female) / Overall (participant view only).
Ranked strictly by `point_diff` descending. A "tie at the top" is only flagged once the leader has
actually played at least one game — avoids a false tie at 0-0 before the event starts.

**Multi-event architecture:** Everything is scoped to an `eventId`. Event Manager creates/lists
events (name, target participants, courts, date, round length, start/end time, venue) and shows a
capacity preview. Organizer console and participant board are both keyed by `eventId` in the URL
path. Deleting an event cascades to delete its players/rounds/matches/logs.

**Event Log:** Real and persisted (a `logs` table), not decorative — records event creation,
roster imports, walk-in adds, attendance changes, round publishes, score entries (with names,
court, division, score), score corrections (old→new), start/end, and checkouts (noting mid-match
cancellations).

---

## 3. Context for the Claude Code Session

**Stack:** Next.js 14 (App Router) + Supabase (Postgres + Realtime) + Vercel, deployed from GitHub
repo `kgbriones1/casa-court`. Vercel auto-deploys on every push to `main` — no need to manually
re-import into Vercel for routine updates (a past mix-up connected the Vercel project to the wrong,
unrelated repo once — worth double-checking any new deploy is sourced from `casa-court`).

**Key files:**
- `lib/scheduler.js` — the matchmaking algorithm (pure functions, no framework dependency; the
  priority-order and penalty weights above live here).
- `lib/db.js` — all Supabase reads/writes, including event logging calls.
- `app/admin/page.js` — Event Manager (create/list events).
- `app/admin/[eventId]/page.js` — organizer console: Dashboard / Registrants / Check-in / Match
  Control / Scores / Leaderboard / Event Log tabs.
- `app/live/[eventId]/page.js` — participant board.
- `components/TopBar.js` — shared header with the Casa logo.
- `app/globals.css` — the coral/gold design system (`#cf5449` / `#c8923e` / yellow / aqua / blue),
  deliberately ported from a reference HTML/CSS mockup the user preferred over an earlier
  dark-green version. Treat this palette and the sidebar-nav layout as the visual north star for
  any further UI work unless told otherwise.

**Database:** `supabase-schema.sql` is the full schema. `supabase-migration-2.sql` (adds event
capacity fields + the `logs` table), `supabase-migration-3.sql` (adds `division` to `matches`),
and `supabase-migration-4.sql` (broadens `division`'s allowed values from `('female','male')` to
`('women','men','mixed','edge')` for mixed doubles, relabeling existing rows) are incremental.
**Migration 4 must be run on the live Supabase project before publishing any round with the mixed-
doubles algorithm** — the old CHECK constraint would otherwise reject the insert. 2 and 3 were
already applied as of the last handoff; confirm 4's status before assuming it's done.

**Environment variables:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — required.
`NEXT_PUBLIC_BASE_PATH` — optional, only used if deploying under a subpath (e.g.
`everydaycasa.ph/casa-events`) via the included Cloudflare Worker proxy script.

**Known gaps — explicitly deferred, not forgotten:**
- No TV `/display` board yet (would reuse `/live` data with a no-nav layout).
- Manual swap/remove/add-player on a draft round isn't wired into the UI yet, though
  `swapPlayers()` exists in `lib/scheduler.js`.
- Only 2-player tiebreakers are flagged in the leaderboard UI; 3+-way ties have no in-app bracket
  flow yet — still fully manual/off-system.
- No CSV export at event close.
- Tiebreaker matches themselves aren't recorded in-app — currently a manual override, not tracked.

**A bug worth not reintroducing:** a generic CSS rule (`button:not(.secondary):not(.small)`) once
overrode the sidebar nav's active-state styling due to specificity, making every nav item look
"active" regardless of the current page. Fixed with an explicit
`.nav button:not(.active){background:transparent!important}` override — if the button/nav styles
get touched again, keep that override intact or re-verify the fix still holds.
