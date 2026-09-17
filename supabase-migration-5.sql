-- Run this in the Supabase SQL editor for the live project.
-- Prepares the schema for the real-time, per-match matchmaking redesign (see
-- lib/scheduler.js). Schema-only -- lib/db.js and the UI keep working exactly
-- as before after this runs; nothing here changes what today's app reads or
-- writes, it just adds the columns a later phase will start populating, so
-- that phase doesn't also need its own migration.

-- 1. New columns, nullable for now -- no current insert/update populates them,
--    and existing rows predate the concept.
alter table matches add column if not exists sequence int;
alter table players add column if not exists last_played_sequence int;

-- 2. Backfill sequence for existing matches. A "round" now maps onto exactly
--    `events.courts`-many sequence slots, in round order; within a round,
--    matches.court (always assigned contiguously from 1, however many matches
--    that round actually had) gives the position inside it. Gaps -- e.g. a
--    round that only filled 2 of 3 courts -- are fine, sequence only needs to
--    be unique and increasing per event, not contiguous.
update matches m
set sequence = (r.number - 1) * e.courts + m.court
from rounds r, events e
where m.round_id = r.id and m.event_id = e.id;

-- 3. Backfill last_played_sequence for existing players: the highest sequence
--    among their own non-cancelled matches, or left null if they never played.
update players p
set last_played_sequence = sub.max_seq
from (
  select player_id, max(seq) as max_seq
  from (
    select unnest(team_a || team_b) as player_id, sequence as seq
    from matches
    where status <> 'cancelled' and sequence is not null
  ) touched
  group by player_id
) sub
where p.id = sub.player_id;

-- 4. Now that backfill is done, guarantee future inserts can't collide on
--    (event_id, sequence). Postgres allows multiple nulls under a unique
--    constraint, so this doesn't require every historical row to have one.
alter table matches add constraint matches_event_sequence_unique unique (event_id, sequence);

-- 5. A "round" is now a derived, display-only label (every courts-many
--    matches by generation order) rather than a real container every match
--    belongs to -- new per-match-generated matches won't have a rounds row to
--    reference. Existing rows keep theirs; only future inserts may omit it.
alter table matches alter column round_id drop not null;
