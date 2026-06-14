-- ============================================================================
-- Orbit — database schema (RECONSTRUCTED from the client code).
--
-- ⚠️  IMPORTANT: This file was reconstructed from app.js (the RPC calls and
--     payload shapes the client sends). It is a faithful, runnable starting
--     point for self-hosters, but it may differ in small ways from the
--     original author's live project. If you have access to the original
--     Supabase project, the authoritative version is:
--         supabase db dump --schema public -f supabase/schema.sql
--     (or Dashboard → Database → Schema). Prefer that over this file.
--
-- Security model (matches the client):
--   * The client talks to PostgREST RPCs only, using the publishable/anon key.
--   * Each function is SECURITY DEFINER and filters by p_vault (a SHA-256
--     hash of the user's sync phrase, computed client-side).
--   * Tables have RLS enabled with NO anon policies, so direct table access
--     is blocked — everything must go through the vetted functions below.
--
-- Run this in the Supabase SQL Editor on a fresh project.
-- ============================================================================

create extension if not exists pgcrypto;  -- for gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table if not exists public.focus_blocks (
  id                uuid primary key default gen_random_uuid(),
  vault             text not null,
  started_at        timestamptz,
  ended_at          timestamptz,
  planned_seconds   integer,
  actual_seconds    integer,
  kind              text default 'focus',
  label             text,
  completed         boolean default true,
  tz_offset_minutes integer,
  local_date        date,
  local_hour        integer,
  weekday           integer,
  created_at        timestamptz default now()
);

create table if not exists public.books (
  id           uuid primary key default gen_random_uuid(),
  vault        text not null,
  title        text,
  author       text,
  total_pages  integer,
  current_page integer,
  status       text default 'reading',  -- reading | want | finished
  rating       integer,
  finished_on  date,
  created_at   timestamptz default now()
);

create table if not exists public.reading_sessions (
  id          uuid primary key default gen_random_uuid(),
  vault       text not null,
  book_id     uuid,
  book_title  text,
  started_at  timestamptz,
  ended_at    timestamptz,
  seconds     integer,
  pages_read  integer default 0,
  local_date  date,
  local_hour  integer,
  weekday     integer,
  created_at  timestamptz default now()
);

create table if not exists public.wellness_sessions (
  id              uuid primary key default gen_random_uuid(),
  vault           text not null,
  kind            text,  -- breathing | meditation
  pattern_name    text,
  inhale          integer,
  hold1           integer,
  exhale          integer,
  hold2           integer,
  planned_seconds integer,
  actual_seconds  integer,
  started_at      timestamptz,
  ended_at        timestamptz,
  local_date      date,
  local_hour      integer,
  weekday         integer,
  created_at      timestamptz default now()
);

create table if not exists public.caffeine_logs (
  id          uuid primary key default gen_random_uuid(),
  vault       text not null,
  drink       text,
  caffeine_mg integer,
  note        text,
  consumed_at timestamptz,
  local_date  date,
  local_hour  integer,
  weekday     integer,
  created_at  timestamptz default now()
);

create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  vault      text not null,
  name       text,
  created_at timestamptz default now()
);

create table if not exists public.project_sessions (
  id            uuid primary key default gen_random_uuid(),
  vault         text not null,
  project_id    uuid,
  project_name  text,
  note          text,
  started_at    timestamptz,
  ended_at      timestamptz,
  seconds       integer,
  local_date    date,
  local_hour    integer,
  weekday       integer,
  created_at    timestamptz default now()
);

-- Helpful indexes (the list functions all filter by vault).
create index if not exists idx_focus_vault   on public.focus_blocks(vault);
create index if not exists idx_books_vault    on public.books(vault);
create index if not exists idx_read_vault     on public.reading_sessions(vault);
create index if not exists idx_well_vault     on public.wellness_sessions(vault);
create index if not exists idx_caf_vault      on public.caffeine_logs(vault);
create index if not exists idx_proj_vault     on public.projects(vault);
create index if not exists idx_projsess_vault on public.project_sessions(vault);

-- ----------------------------------------------------------------------------
-- Row-Level Security: lock down direct table access. All reads/writes go
-- through the SECURITY DEFINER functions below, which filter by p_vault.
-- ----------------------------------------------------------------------------
alter table public.focus_blocks      enable row level security;
alter table public.books             enable row level security;
alter table public.reading_sessions  enable row level security;
alter table public.wellness_sessions enable row level security;
alter table public.caffeine_logs     enable row level security;
alter table public.projects          enable row level security;
alter table public.project_sessions  enable row level security;
-- (No policies created on purpose → anon/authenticated cannot touch tables directly.)

-- ----------------------------------------------------------------------------
-- FOCUS
-- ----------------------------------------------------------------------------
create or replace function public.focus_log_block(p_vault text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  insert into focus_blocks (vault, started_at, ended_at, planned_seconds, actual_seconds,
    kind, label, completed, tz_offset_minutes, local_date, local_hour, weekday)
  values (p_vault,
    (p_payload->>'started_at')::timestamptz, (p_payload->>'ended_at')::timestamptz,
    (p_payload->>'planned_seconds')::int, (p_payload->>'actual_seconds')::int,
    coalesce(p_payload->>'kind','focus'), p_payload->>'label',
    coalesce((p_payload->>'completed')::boolean, true),
    (p_payload->>'tz_offset_minutes')::int, (p_payload->>'local_date')::date,
    (p_payload->>'local_hour')::int, (p_payload->>'weekday')::int)
  returning id into new_id;
  return new_id::text;
end $$;

create or replace function public.focus_list_blocks(p_vault text)
returns setof focus_blocks language sql security definer set search_path = public as $$
  select * from focus_blocks where vault = p_vault order by started_at;
$$;

create or replace function public.focus_delete_block(p_vault text, p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from focus_blocks where vault = p_vault and id = p_id;
$$;

create or replace function public.focus_erase(p_vault text)
returns void language sql security definer set search_path = public as $$
  delete from focus_blocks where vault = p_vault;
$$;

-- ----------------------------------------------------------------------------
-- READING
-- ----------------------------------------------------------------------------
create or replace function public.reading_upsert_book(p_vault text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare bid uuid;
begin
  if (p_payload ? 'id') and (p_payload->>'id') is not null then
    bid := (p_payload->>'id')::uuid;
    update books set
      title        = coalesce(p_payload->>'title', title),
      author       = coalesce(p_payload->>'author', author),
      total_pages  = coalesce((p_payload->>'total_pages')::int, total_pages),
      current_page = coalesce((p_payload->>'current_page')::int, current_page),
      status       = coalesce(p_payload->>'status', status),
      rating       = coalesce((p_payload->>'rating')::int, rating),
      finished_on  = coalesce((p_payload->>'finished_on')::date, finished_on)
    where id = bid and vault = p_vault;
  else
    insert into books (vault, title, author, total_pages, current_page, status, rating, finished_on)
    values (p_vault, p_payload->>'title', p_payload->>'author',
      (p_payload->>'total_pages')::int, (p_payload->>'current_page')::int,
      coalesce(p_payload->>'status','reading'), (p_payload->>'rating')::int,
      (p_payload->>'finished_on')::date)
    returning id into bid;
  end if;
  return bid::text;
end $$;

create or replace function public.reading_list_books(p_vault text)
returns setof books language sql security definer set search_path = public as $$
  select * from books where vault = p_vault order by created_at;
$$;

create or replace function public.reading_delete_book(p_vault text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from reading_sessions where vault = p_vault and book_id = p_id;
  delete from books where vault = p_vault and id = p_id;
end $$;

create or replace function public.reading_log_session(p_vault text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  insert into reading_sessions (vault, book_id, book_title, started_at, ended_at,
    seconds, pages_read, local_date, local_hour, weekday)
  values (p_vault, nullif(p_payload->>'book_id','')::uuid, p_payload->>'book_title',
    (p_payload->>'started_at')::timestamptz, (p_payload->>'ended_at')::timestamptz,
    (p_payload->>'seconds')::int, coalesce((p_payload->>'pages_read')::int, 0),
    (p_payload->>'local_date')::date, (p_payload->>'local_hour')::int, (p_payload->>'weekday')::int)
  returning id into new_id;
  return new_id::text;
end $$;

create or replace function public.reading_list_sessions(p_vault text)
returns setof reading_sessions language sql security definer set search_path = public as $$
  select * from reading_sessions where vault = p_vault order by started_at;
$$;

create or replace function public.reading_delete_session(p_vault text, p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from reading_sessions where vault = p_vault and id = p_id;
$$;

create or replace function public.reading_erase(p_vault text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from reading_sessions where vault = p_vault;
  delete from books where vault = p_vault;
end $$;

-- ----------------------------------------------------------------------------
-- WELLNESS (breath + meditation)
-- ----------------------------------------------------------------------------
create or replace function public.wellness_log_session(p_vault text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  insert into wellness_sessions (vault, kind, pattern_name, inhale, hold1, exhale, hold2,
    planned_seconds, actual_seconds, started_at, ended_at, local_date, local_hour, weekday)
  values (p_vault, p_payload->>'kind', p_payload->>'pattern_name',
    (p_payload->>'inhale')::int, (p_payload->>'hold1')::int, (p_payload->>'exhale')::int,
    (p_payload->>'hold2')::int, (p_payload->>'planned_seconds')::int, (p_payload->>'actual_seconds')::int,
    (p_payload->>'started_at')::timestamptz, (p_payload->>'ended_at')::timestamptz,
    (p_payload->>'local_date')::date, (p_payload->>'local_hour')::int, (p_payload->>'weekday')::int)
  returning id into new_id;
  return new_id::text;
end $$;

create or replace function public.wellness_list_sessions(p_vault text)
returns setof wellness_sessions language sql security definer set search_path = public as $$
  select * from wellness_sessions where vault = p_vault order by started_at;
$$;

create or replace function public.wellness_delete(p_vault text, p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from wellness_sessions where vault = p_vault and id = p_id;
$$;

create or replace function public.wellness_erase(p_vault text)
returns void language sql security definer set search_path = public as $$
  delete from wellness_sessions where vault = p_vault;
$$;

-- ----------------------------------------------------------------------------
-- CAFFEINE
-- ----------------------------------------------------------------------------
create or replace function public.caffeine_log(p_vault text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  insert into caffeine_logs (vault, drink, caffeine_mg, note, consumed_at, local_date, local_hour, weekday)
  values (p_vault, p_payload->>'drink', (p_payload->>'caffeine_mg')::int, p_payload->>'note',
    (p_payload->>'consumed_at')::timestamptz, (p_payload->>'local_date')::date,
    (p_payload->>'local_hour')::int, (p_payload->>'weekday')::int)
  returning id into new_id;
  return new_id::text;
end $$;

create or replace function public.caffeine_list(p_vault text)
returns setof caffeine_logs language sql security definer set search_path = public as $$
  select * from caffeine_logs where vault = p_vault order by consumed_at;
$$;

create or replace function public.caffeine_delete(p_vault text, p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from caffeine_logs where vault = p_vault and id = p_id;
$$;

create or replace function public.caffeine_erase(p_vault text)
returns void language sql security definer set search_path = public as $$
  delete from caffeine_logs where vault = p_vault;
$$;

-- ----------------------------------------------------------------------------
-- PROJECTS
-- ----------------------------------------------------------------------------
create or replace function public.project_upsert(p_vault text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if (p_payload ? 'id') and (p_payload->>'id') is not null then
    pid := (p_payload->>'id')::uuid;
    update projects set name = coalesce(p_payload->>'name', name)
    where id = pid and vault = p_vault;
  else
    insert into projects (vault, name) values (p_vault, p_payload->>'name')
    returning id into pid;
  end if;
  return pid::text;
end $$;

create or replace function public.project_list(p_vault text)
returns setof projects language sql security definer set search_path = public as $$
  select * from projects where vault = p_vault order by created_at;
$$;

create or replace function public.project_delete(p_vault text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from project_sessions where vault = p_vault and project_id = p_id;
  delete from projects where vault = p_vault and id = p_id;
end $$;

create or replace function public.project_log_session(p_vault text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  insert into project_sessions (vault, project_id, project_name, note, started_at, ended_at,
    seconds, local_date, local_hour, weekday)
  values (p_vault, nullif(p_payload->>'project_id','')::uuid, p_payload->>'project_name',
    p_payload->>'note', (p_payload->>'started_at')::timestamptz, (p_payload->>'ended_at')::timestamptz,
    (p_payload->>'seconds')::int, (p_payload->>'local_date')::date,
    (p_payload->>'local_hour')::int, (p_payload->>'weekday')::int)
  returning id into new_id;
  return new_id::text;
end $$;

create or replace function public.project_list_sessions(p_vault text)
returns setof project_sessions language sql security definer set search_path = public as $$
  select * from project_sessions where vault = p_vault order by started_at;
$$;

create or replace function public.project_delete_session(p_vault text, p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from project_sessions where vault = p_vault and id = p_id;
$$;

create or replace function public.project_erase(p_vault text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from project_sessions where vault = p_vault;
  delete from projects where vault = p_vault;
end $$;

-- ----------------------------------------------------------------------------
-- Expose the functions to the anon/authenticated roles (the client uses the
-- publishable/anon key). Tables stay locked by RLS above.
-- ----------------------------------------------------------------------------
grant execute on all functions in schema public to anon, authenticated;
