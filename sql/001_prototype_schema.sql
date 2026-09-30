-- Telegram prototype schema. Run once in the Supabase SQL editor.
-- Replaces sql/customer_leads.sql (the table never existed in the live database).

create table if not exists customer_leads (
  customer_id text primary key,                       -- 'telegram:<id>' or 'test:<nnn>'
  display_name text,
  handle text,
  phone text,
  source text,                                        -- /start campaign payload
  lead_stage text not null default 'initiated'
    check (lead_stage in (
      'initiated', 'interested', 'negotiating',
      'site_visit_ready', 'closed', 'not_interested'
    )),
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
  bot_state jsonb not null default '{}'::jsonb,       -- scope guard, last shown properties
  consent_at timestamptz,
  is_test boolean not null default false,
  last_contacted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_leads_stage_idx on customer_leads (lead_stage);
create index if not exists customer_leads_updated_at_idx on customer_leads (updated_at desc);

-- Append-only history: stage changes, site visit requests, zero-result searches.
create table if not exists lead_events (
  id bigint generated always as identity primary key,
  customer_id text not null references customer_leads (customer_id) on delete cascade,
  event_type text not null,                           -- stage_changed, site_visit_requested, zero_result, ...
  from_stage text,
  to_stage text,
  property_id text,
  note text,
  payload jsonb not null default '{}'::jsonb,
  alerted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists lead_events_lead_idx on lead_events (customer_id, created_at desc);
create index if not exists lead_events_type_idx on lead_events (event_type);

-- Conversation memory: the last messages per lead.
create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  customer_id text not null references customer_leads (customer_id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  meta jsonb not null default '{}'::jsonb,            -- e.g. property ids shown in this reply
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_lead_idx on chat_messages (customer_id, created_at desc);

-- Lock the tables: only the service-role key (used by the server) can read or write.
alter table customer_leads enable row level security;
alter table lead_events enable row level security;
alter table chat_messages enable row level security;
