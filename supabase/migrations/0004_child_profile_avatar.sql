begin;

alter table public.child_profiles
  add column if not exists avatar_storage_key text,
  add column if not exists avatar_url text,
  add column if not exists avatar_updated_at timestamptz;

alter table public.child_profiles
  drop constraint if exists child_profiles_avatar_pair_check;

alter table public.child_profiles
  add constraint child_profiles_avatar_pair_check check (
    (avatar_storage_key is null and avatar_url is null and avatar_updated_at is null)
    or (
      avatar_storage_key is not null
      and avatar_url is not null
      and avatar_updated_at is not null
      and avatar_url like '/manus-storage/%'
    )
  );

comment on column public.child_profiles.avatar_storage_key is
  'S3 object key for the child avatar. File bytes are never stored in PostgreSQL.';

comment on column public.child_profiles.avatar_url is
  'Frontend-safe /manus-storage/ URL for the current child avatar.';

commit;
