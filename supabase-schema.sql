-- Run this in the Supabase SQL editor for a fresh project.
create extension if not exists pgcrypto;

create table events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  courts int not null default 3,
  target_participants int,
  event_date date,
  start_time text, -- "HH:MM", for the capacity preview only, not a hard scheduler
  end_time text,
  round_minutes int not null default 20,
  venue text,
  started_at timestamptz,
  ended boolean not null default false,
  created_at timestamptz not null default now()
);

create table players (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  first_name text not null,
  last_name text not null default '',
  nickname text not null default '',
  display_name text not null,
  gender text not null check (gender in ('male','female')),
  registration_status text not null default 'registered', -- registered | walk_in
  attendance_status text not null default 'not_arrived',
    -- not_arrived | late | checked_in | temporarily_unavailable | no_show | withdrawn
  eta_note text not null default '',
  organizer_note text not null default '',
  level numeric, -- organizer-only skill rating, never exposed to /live
  games_played int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  points_for int not null default 0,
  points_against int not null default 0,
  point_diff int not null default 0,
  last_played_round int,
  partner_ids uuid[] not null default '{}',
  opponent_counts jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  number int not null,
  status text not null default 'draft', -- draft | published
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (event_id, number)
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade, -- denormalized, simplifies realtime filtering
  court int not null,
  division text not null default 'male' check (division in ('female','male')), -- women's doubles / men's doubles, never mixed
  team_a uuid[] not null,
  team_b uuid[] not null,
  score_a int,
  score_b int,
  status text not null default 'scheduled', -- scheduled | completed | time_expired | cancelled | incomplete
  completed_at timestamptz
);

create table logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

-- No auth layer yet: the /admin/event link is the only thing gating write access
-- (per the "organizers know the URL, participants don't" model). Anyone with the
-- event UUID can read AND write. Fine for a single internal event, same tradeoff
-- flagged in the earlier Firebase version. Add Supabase Auth + RLS-by-role before
-- you'd trust this with a public/adversarial audience.
alter table events enable row level security;
alter table players enable row level security;
alter table rounds enable row level security;
alter table matches enable row level security;
alter table logs enable row level security;

create policy "public all events" on events for all using (true) with check (true);
create policy "public all players" on players for all using (true) with check (true);
create policy "public all rounds" on rounds for all using (true) with check (true);
create policy "public all matches" on matches for all using (true) with check (true);
create policy "public all logs" on logs for all using (true) with check (true);

-- Enable realtime on all five tables (Supabase Dashboard > Database > Replication,
-- or run):
alter publication supabase_realtime add table events, players, rounds, matches, logs;
