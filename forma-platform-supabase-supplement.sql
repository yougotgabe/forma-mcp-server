-- Run this in platform Supabase SQL editor after the main schema.
-- Called by the platform Worker /service-request endpoint.

create or replace function increment_open_escalations(client_slug text)
returns void as $$
begin
  update clients
  set open_escalations = open_escalations + 1
  where slug = client_slug;
end;
$$ language plpgsql security definer;

-- Verify
-- select routine_name from information_schema.routines where routine_schema = 'public';
-- Should now include: increment_open_escalations
