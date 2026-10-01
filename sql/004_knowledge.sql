-- Knowledge gaps and owner-approved answers. Run once in the Supabase SQL editor.
--
-- When the assistant has to say "I don't have that", the question is saved here as a gap, with the
-- customer's request as JSON. Business owners answer gaps from the lead board's Knowledge tab.
-- An answer becomes an entry, and the next customer who asks gets that answer.

create table if not exists knowledge_entries (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('property', 'area', 'general')),
  property_id text,                          -- for scope 'property'
  area text,                                 -- for scope 'area', as named in the micro-market table
  topic text,                                -- parking, school, loan, ... or null for a free-form answer
  keywords text[] not null default '{}',     -- words that make this entry relevant to a question
  question text,                             -- a sample question, for the owner's reference
  answer text not null,
  active boolean not null default true,
  served_count integer not null default 0,
  last_served_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_entries_lookup_idx on knowledge_entries (topic, scope, property_id, area) where active;

create table if not exists knowledge_gaps (
  id bigint generated always as identity primary key,
  question text not null,                    -- the customer's words
  kind text not null check (kind in ('listing_detail', 'area_info', 'policy', 'other')),
  topic text,
  property_id text,
  area text,
  customer_id text,
  is_test boolean not null default false,
  group_key text not null,                   -- the same question about the same thing shares a key
  times integer not null default 1,
  request jsonb not null default '{}'::jsonb, -- the request: what was asked, what was shown, what the assistant said
  status text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  entry_id bigint references knowledge_entries (id) on delete set null,
  first_asked_at timestamptz not null default now(),
  last_asked_at timestamptz not null default now()
);

create index if not exists knowledge_gaps_group_idx on knowledge_gaps (group_key, status);
create index if not exists knowledge_gaps_status_idx on knowledge_gaps (status, last_asked_at desc);

alter table knowledge_entries enable row level security;
alter table knowledge_gaps enable row level security;
