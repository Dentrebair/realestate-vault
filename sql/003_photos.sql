-- Property photos. Run once in the Supabase SQL editor.
-- Photos are uploaded from the lead board's Listings tab; nothing else needs to be done by hand.

-- A public bucket: customers see these photos in Telegram, so anyone with a link may view them.
-- Only the server (service-role key) can add or remove files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('property-photos', 'property-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists property_photos (
  id bigint generated always as identity primary key,
  property_id text not null,
  path text not null unique,              -- file path inside the bucket
  position integer not null default 0,    -- 0 is the cover photo
  uploaded_by text,
  created_at timestamptz not null default now()
);

create index if not exists property_photos_property_idx on property_photos (property_id, position);

alter table property_photos enable row level security;
