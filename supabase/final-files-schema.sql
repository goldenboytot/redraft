-- Redraft final-file schema. Run after supabase/schema.sql.
-- Stores generated .docx objects privately and scopes access to their owner.
create table if not exists public.final_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id   text not null references public.sessions (id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('resume', 'cover', 'report')),
  storage_path text not null unique,
  size_bytes   bigint not null check (size_bytes >= 0),
  created_at   timestamptz not null default now()
);

create index if not exists final_files_user_session_created
  on public.final_files (user_id, session_id, created_at desc);

alter table public.final_files enable row level security;
revoke all on public.final_files from public, anon, authenticated;
grant select, insert, delete on public.final_files to authenticated;

drop policy if exists "own final files: read" on public.final_files;
drop policy if exists "own final files: insert" on public.final_files;
drop policy if exists "own final files: delete" on public.final_files;

create policy "own final files: read" on public.final_files
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own final files: insert" on public.final_files
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sessions
      where sessions.id = final_files.session_id
        and sessions.user_id = (select auth.uid())
    )
  );
create policy "own final files: delete" on public.final_files
  for delete to authenticated using (user_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'redraft-finals',
  'redraft-finals',
  false,
  10485760,
  array['application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "own final files: storage read" on storage.objects;
drop policy if exists "own final files: storage insert" on storage.objects;
drop policy if exists "own final files: storage delete" on storage.objects;

create policy "own final files: storage read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'redraft-finals'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
create policy "own final files: storage insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'redraft-finals'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and exists (
      select 1 from public.sessions
      where sessions.id = (storage.foldername(name))[2]
        and sessions.user_id = (select auth.uid())
    )
  );
create policy "own final files: storage delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'redraft-finals'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
