-- Run this in the Supabase SQL editor for the live project.
-- Mixed doubles are now allowed -- matches.division broadens from strict
-- women's/men's segregation to also allow 'mixed' and 'edge' (a fallback
-- composition used only when supply doesn't divide cleanly). Existing rows
-- get relabeled onto the new vocabulary before the constraint changes, so
-- nothing already stored violates it.

update matches set division = 'women' where division = 'female';
update matches set division = 'men' where division = 'male';

alter table matches drop constraint if exists matches_division_check;
alter table matches add constraint matches_division_check check (division in ('women','men','mixed','edge'));
alter table matches alter column division set default 'men';
