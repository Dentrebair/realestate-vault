-- Privacy: consent version, an access log for staff, and a record of deletions. Run once in the Supabase SQL editor.

alter table customer_leads add column if not exists consent_version text;

-- Who on the staff opened which customer's private details, and when.
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  staff_email text not null,
  action text not null,                       -- view_lead
  customer_id text,
  detail jsonb not null default '{}'::jsonb,  -- e.g. whether the phone number or the conversation was shown
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);
create index if not exists audit_log_customer_idx on audit_log (customer_id);

-- Proof that a deletion happened, without keeping who it was: only a one-way hash of the customer id.
create table if not exists deletion_log (
  id bigint generated always as identity primary key,
  customer_ref text not null,                 -- sha256 of the customer id
  reason text not null check (reason in ('customer_request', 'retention')),
  removed jsonb not null default '{}'::jsonb, -- counts of what was removed
  created_at timestamptz not null default now()
);

alter table audit_log enable row level security;
alter table deletion_log enable row level security;
