-- 0006 — position_instances had two foreign keys to industries: industry_id alone (0001) and the
-- composite (industry_id, sector_id) added in 0004. The composite one already guarantees the industry
-- exists, so the single-column one is redundant, and having both made PostgREST refuse every query that
-- embeds the industry name ("more than one relationship was found"). Drop the redundant one.
alter table public.position_instances drop constraint if exists position_instances_industry_id_fkey;
notify pgrst, 'reload schema';
