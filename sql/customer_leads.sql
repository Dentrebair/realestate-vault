create table if not exists customer_leads (
  customer_id text primary key,
  display_name text,
  lead_status text not null default 'new',
  intent text,
  budget_min bigint,
  budget_max bigint,
  preferred_locations text[] not null default '{}',
  property_categories text[] not null default '{}',
  bedrooms integer,
  bathrooms integer,
  must_haves text[] not null default '{}',
  deal_breakers text[] not null default '{}',
  urgency text,
  financing_status text,
  key_points jsonb not null default '[]'::jsonb,
  shortlisted_property_ids text[] not null default '{}',
  last_query_summary text,
  next_action text,
  last_contacted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_leads_status_idx on customer_leads (lead_status);
create index if not exists customer_leads_updated_at_idx on customer_leads (updated_at desc);
create index if not exists customer_leads_key_points_idx on customer_leads using gin (key_points);
