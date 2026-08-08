-- Run this if you already ran supabase-schema.sql and supabase-migration-2.sql before.
-- Adds strict women's/men's doubles support -- matches are never mixed-gender.

alter table matches add column if not exists division text not null default 'male' check (division in ('female','male'));
