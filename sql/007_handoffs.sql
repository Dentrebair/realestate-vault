-- Human handoff: requests the bot passes to the team, and the conversation about each one. Run once in the Supabase SQL editor.
--
-- A request is raised when a customer asks to visit, asks for a call back, makes a price offer, or asks something the bot
-- cannot answer. The team replies on Telegram (by replying to the alert) or from the lead board; both land in this thread.
-- Everything here belongs to the customer and is deleted with them (/forget, retention).

create table if not exists handoffs (
  id bigint generated always as identity primary key,
  customer_id text not null references customer_leads(customer_id) on delete cascade,
  kind text not null check (kind in ('visit', 'callback', 'offer', 'question')),
  status text not null default 'open' check (status in ('open', 'waiting_customer', 'resolved')),
  summary text not null,
  property_id text,
  is_test boolean not null default false,
  alert_chat_id bigint,       -- where the team was told, so a reply to that message finds this request
  alert_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index if not exists handoffs_status_idx on handoffs (status, created_at desc);
create index if not exists handoffs_customer_idx on handoffs (customer_id);
create index if not exists handoffs_alert_idx on handoffs (alert_chat_id, alert_message_id);

create table if not exists handoff_messages (
  id bigint generated always as identity primary key,
  handoff_id bigint not null references handoffs(id) on delete cascade,
  direction text not null check (direction in ('customer', 'staff')),
  via text not null check (via in ('bot', 'telegram', 'board')),
  author text,                -- the staff member's email or Telegram id; empty for the customer
  text text not null,
  staff_chat_id bigint,       -- the team-side message this entry was shown in, so replying to it finds this request
  staff_message_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists handoff_messages_thread_idx on handoff_messages (handoff_id, created_at);
create index if not exists handoff_messages_staff_idx on handoff_messages (staff_chat_id, staff_message_id);

alter table handoffs enable row level security;
alter table handoff_messages enable row level security;
