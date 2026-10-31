-- Run this in the Supabase SQL editor for the live project, BEFORE deploying
-- the matching code change.
--
-- Late arrivals. A player who checks in after games have started is counted as
-- already at par with the field from that moment (games_baseline = the field's
-- median at that time), so the matchmaking doesn't chase parity for games they
-- were never there to play. Their real games_played stays untouched -- the
-- baseline only changes how they're ranked for the next match and audited.
--
-- checked_in_at records the first time someone was checked in. It marks "has
-- arrived before" so only a first arrival (or a return from Checked out) is
-- treated as late, not a toggle between other statuses.
alter table players add column if not exists games_baseline int not null default 0;
alter table players add column if not exists checked_in_at timestamptz;

-- Players already checked in, or who have already played, have arrived: give
-- them a placeholder so a later status change isn't mistaken for a first arrival.
update players
set checked_in_at = created_at
where checked_in_at is null
  and (attendance_status = 'checked_in' or games_played > 0);
