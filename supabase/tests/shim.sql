-- 시험용 "작은 Supabase". 진짜 Supabase 에서는 실행하지 않아요(이미 다 있어요).
-- 0001_init.sql 이 기대하는 것만 흉내 내요: anon·authenticated·service_role 역할, auth 스키마와 auth.users,
-- auth.uid()/auth.jwt()(PostgREST 가 넣는 request.jwt.claims 를 읽음), 그리고 새 표에 주는 기본 권한.
--
-- psql 변수 legacy_grants:
--   true  = 2026-10-30 이전 Supabase: public 의 새 표·시퀀스·함수를 anon·authenticated·service_role 에게 자동으로 다 준다
--           (0001 의 revoke 가 제대로 거두는지 본다)
--   false = 이후 Supabase: 표·시퀀스는 자동으로 주지 않는다(0001 의 grant 만으로 앱이 도는지 본다). 함수는 여전히 준다

\set ON_ERROR_STOP 1

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  is_anonymous boolean not null default false,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Supabase 의 정의와 같다(request.jwt.claim.sub 이 먼저, 없으면 request.jwt.claims 의 sub)
create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- 함수: Supabase 는 지금도 public 의 새 함수를 세 역할에게 준다
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

\if :legacy_grants
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
\endif
