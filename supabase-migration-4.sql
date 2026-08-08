-- Run this in the Supabase SQL editor for the live project.
-- Gender-blind matchmaking is now allowed -- matches.division broadens from
-- strict women's/men's segregation to also allow 'mixed' and 'edge' (any
-- other composition). The constraint has to widen BEFORE the data gets
-- relabeled, not after -- relabeling existing rows to 'women'/'men' while
-- the old constraint (which only permits 'female'/'male') is still active
-- would reject the update itself.

-- Step 1: temporarily accept both the old and new vocabulary.
alter table matches drop constraint if exists matches_division_check;
alter table matches add constraint matches_division_check check (division in ('women','men','mixed','edge','female','male'));

-- Step 2: relabel existing rows onto the new vocabulary.
update matches set division = 'women' where division = 'female';
update matches set division = 'men' where division = 'male';

-- Step 3: now that nothing uses the old values, tighten to the final set.
alter table matches drop constraint if exists matches_division_check;
alter table matches add constraint matches_division_check check (division in ('women','men','mixed','edge'));
alter table matches alter column division set default 'men';
