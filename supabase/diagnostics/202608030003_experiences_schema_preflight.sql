-- Read-only schema inventory for public.experiences before Remada Sunset.
-- This statement does not change tables, functions, data, grants or policies.

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'experiences'
order by ordinal_position;
