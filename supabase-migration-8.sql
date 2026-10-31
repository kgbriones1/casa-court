-- Run this in the Supabase SQL editor for the live project, BEFORE deploying
-- the matching code change.
--
-- arrival_sequence: the match sequence the event had reached when a player was
-- (re)checked in -- 0 for anyone there from the start. Waiting between games is
-- now counted from the later of a player's last match and their arrival. Before
-- this, a player who hadn't played yet had no wait to count, so in a big field
-- (where everyone who had played was already past the must-play threshold) the
-- must-play tier filled every slot and they were never picked.
alter table players add column if not exists arrival_sequence int not null default 0;
