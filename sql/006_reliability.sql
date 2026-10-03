-- Reliability: every Telegram update is written down before the bot says "received", so a crash or a deploy
-- in the middle of a reply does not lose the customer's message. Run once in the Supabase SQL editor.
--
-- The message text is kept only while the update is waiting to be processed. Once it is done the payload is
-- cleared and only the update number stays (to recognise a repeat), and that is removed after a week.

create table if not exists telegram_updates (
  update_id bigint primary key,
  status text not null default 'received' check (status in ('received', 'done')),
  payload jsonb,
  received_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists telegram_updates_status_idx on telegram_updates (status, received_at);

alter table telegram_updates enable row level security;
