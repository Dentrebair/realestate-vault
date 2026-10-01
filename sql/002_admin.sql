-- Who may use the lead board. Run once in the Supabase SQL editor, after 001_prototype_schema.sql.
--
-- Signing in is handled by Supabase Auth (email and password). To let someone in:
--   1. Supabase dashboard, Authentication, Users, Add user, Create new user.
--      Type their email and a password, and tick "Auto Confirm User".
--   2. Run:  node scripts/add-staff.js their@email.com admin     (or "viewer" for read-only)
--   3. Authentication, Sign In / Providers, turn OFF "Allow new users to sign up".

create table if not exists staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

-- Only the server (service-role key) reads this table.
alter table staff enable row level security;
