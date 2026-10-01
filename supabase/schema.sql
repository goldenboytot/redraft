-- Redraft: one table. Run once in Supabase → SQL Editor.
create table if not exists public.sessions (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default 'Untitled session',
  state       jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists sessions_user_updated on public.sessions (user_id, updated_at desc);

-- Each person can only see and change their own sessions.
alter table public.sessions enable row level security;

drop policy if exists "own sessions: read"   on public.sessions;
drop policy if exists "own sessions: insert" on public.sessions;
drop policy if exists "own sessions: update" on public.sessions;
drop policy if exists "own sessions: delete" on public.sessions;

create policy "own sessions: read"   on public.sessions for select to authenticated using (user_id = (select auth.uid()));
create policy "own sessions: insert" on public.sessions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own sessions: update" on public.sessions for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own sessions: delete" on public.sessions for delete to authenticated using (user_id = (select auth.uid()));
