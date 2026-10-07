-- When customers may visit each property. Run once in the Supabase SQL editor.
-- Set from the lead board's Listings tab. A property with no row here is arranged by the team on request.
create table if not exists visit_availability (
  property_id text primary key,
  mode text not null check (mode in ('open', 'closed')),   -- open: the bot asks for a date and time inside the rules; closed: no visits yet
  rules jsonb not null default '[]'::jsonb,                -- [{"days":[6],"from":"10:00","to":"13:00"}, {"date":"2026-10-12","from":"15:00","to":"17:00"}]
  note text,                                               -- shown to the customer, for example "Please bring ID"
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table visit_availability enable row level security;
