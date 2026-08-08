-- Run this ONLY if you already ran the original supabase-schema.sql once before.
-- (If you're setting up a brand new Supabase project, just run the full
-- supabase-schema.sql instead -- it already includes everything below.)

alter table events add column if not exists target_participants int;
alter table events add column if not exists event_date date;
alter table events add column if not exists start_time text;
alter table events add column if not exists end_time text;
alter table events add column if not exists round_minutes int not null default 20;
alter table events add column if not exists venue text;

create table if not exists logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

alter table logs enable row level security;
create policy "public all logs" on logs for all using (true) with check (true);

alter publication supabase_realtime add table logs;
