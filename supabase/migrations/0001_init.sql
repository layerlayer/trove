-- Trove 서버 1단계: 전체 표 구조 + 보안 규칙(RLS) + RPC
--
-- 어떻게 실행하나요
--   Supabase 대시보드 › SQL Editor 에 이 파일 내용을 통째로 붙여 Run. 그다음 supabase/admin-views.sql 을 같은 방법으로.
--   한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않아요. 다시 실행해도 안전해요(있는 표·행은 그대로 두고
--   함수·트리거·정책·권한만 이 파일 내용으로 다시 맞춰요). 단, 이미 만든 표의 열이나 제약을 바꾸지는 않아요 —
--   그건 다음 번호 파일(0002_…)로 해요.
--
-- 지키는 원칙
--   * public 의 모든 표에 RLS 를 켜고, 클라이언트(anon·authenticated)에게는 필요한 권한만 직접 준다.
--     Supabase 는 2026-10-30 부터 새 표에 권한을 자동으로 주지 않는다(예전 프로젝트는 다 줬다).
--     어느 쪽이든 결과가 같도록 먼저 전부 거둔 뒤(revoke) 필요한 것만 준다(grant).
--   * 익명 로그인 사용자도 role 은 authenticated 다(JWT 의 is_anonymous 로만 구분). 그래서 정책은 to authenticated.
--   * anon(로그인 전, JWT 없음)은 아무 표도 못 읽고 못 쓴다.
--   * 정책 안의 auth.uid() 는 (select auth.uid()) 로 감싸 한 번만 계산되게 한다(Supabase 권장).
--   * security definer 함수는 search_path = '' 로 고정하고 이름을 모두 schema 까지 적는다.
--   * is_internal(Seo 본인 표시)과 consented_at(약관 동의 시각)은 클라이언트가 바꿀 수 없다(열 권한).
--     is_internal 은 SQL Editor 에서 Seo 가, consented_at 은 PR2 에서 만들 RPC 가 서버 시각으로만 쓴다.

begin;

-- ---------------------------------------------------------------------------
-- 공통 트리거 함수

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: 계정당 한 줄. auth.users 에 사용자가 생기면 트리거가 만든다

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  onboarding_complete boolean not null default false,
  default_alerts text[] not null default '{D-1,D-Day}'
    check (default_alerts <@ array['D-7', 'D-1', 'D-Day', 'DATE_CONFIRMED', 'DATE_CHANGED']::text[]),
  weekly_digest boolean not null default true,
  notifications_seen_at timestamptz,
  notifications_seen_ids text[] not null default '{}'
    check (cardinality(notifications_seen_ids) <= 500 and pg_column_size(notifications_seen_ids) <= 65536),
  -- 약관·처리방침·만 14세 확인 시각. 클라이언트는 직접 못 쓴다(PR2 의 RPC 가 now() 로 기록)
  consented_at timestamptz,
  -- Seo 본인 계정. 요약 보기(admin.*)에서 뺀다. 클라이언트는 못 바꾼다
  is_internal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is '계정당 한 줄(익명 포함). auth.users 에 사용자가 생기면 자동으로 생겨요. is_internal = Seo 본인 계정(요약에서 제외).';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 이 파일을 실행하기 전에 이미 생긴 사용자(예: 앱을 먼저 배포해 익명 계정이 생긴 경우)
insert into public.profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- interests: 관심사·팔로우. category:<id> 또는 entity:<slug>

create table if not exists public.interests (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  interest_id text not null check (interest_id ~ '^(category|entity):.+' and char_length(interest_id) <= 200),
  created_at timestamptz not null default now(),
  primary key (user_id, interest_id)
);

comment on table public.interests is '관심사·팔로우. category:<카테고리> 또는 entity:<아티스트·브랜드>. PR3 부터 채워져요.';

-- ---------------------------------------------------------------------------
-- saves: 담기. alert_presets NULL = 기본 알림 사용, {} = 알림 해제, 값 = 그 시점들

create table if not exists public.saves (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  release_id text not null check (char_length(release_id) between 1 and 300),
  alert_presets text[]
    check (alert_presets <@ array['D-7', 'D-1', 'D-Day', 'DATE_CONFIRMED', 'DATE_CHANGED']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, release_id)
);

comment on table public.saves is '담은 기다림. alert_presets: 비어 있음(NULL) = 기본 알림, {} = 알림 해제. PR3 부터 채워져요.';

create index if not exists saves_release_id_idx on public.saves (release_id);

drop trigger if exists saves_set_updated_at on public.saves;
create trigger saves_set_updated_at
  before update on public.saves
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- events: 앱 안 사용 기록. 클라이언트는 넣기만 한다(읽기·고치기·지우기 없음, 지우기는 delete_my_data)

create table if not exists public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- 앱이 만든 무작위 id. 같은 기록을 두 번 보내도(페이지가 닫히며 보낸 것을 다음에 또 보낼 때) 한 줄만 남는다
  client_event_id uuid not null default gen_random_uuid(),
  -- 이 브라우저(또는 홈 화면 앱)의 무작위 id. Safari 와 홈 화면 앱을 가른다. 초기화하면 새로
  device_id text not null check (char_length(device_id) between 1 and 64),
  -- 30분 쉬면 바뀌는 방문 id
  session_id text check (char_length(session_id) <= 64),
  name text not null check (name ~ '^[a-z][a-z0-9_]*$' and char_length(name) <= 64),
  properties jsonb not null default '{}'::jsonb
    check (jsonb_typeof(properties) = 'object' and pg_column_size(properties) <= 2048),
  path text check (char_length(path) <= 300),
  -- standalone(홈 화면 앱) / browser
  display_mode text check (char_length(display_mode) <= 16),
  -- 빌드한 커밋 앞 7자리, 로컬 빌드는 dev
  app_version text check (char_length(app_version) <= 64),
  -- 브라우저 요약(원문 User-Agent 는 받지 않는다): ios/android/mac/windows/other
  os text check (char_length(os) <= 16),
  -- safari/chrome/samsung/firefox/edge/whale/opera/other
  browser text check (char_length(browser) <= 24),
  -- 앱 안 브라우저면 그 앱(kakaotalk, instagram, naver, …), 아니면 비어 있음
  in_app text check (char_length(in_app) <= 24),
  -- 기기 시계 기준 시각
  client_at timestamptz not null,
  received_at timestamptz not null default now(),
  constraint events_user_client_event_key unique (user_id, client_event_id)
);

comment on table public.events is '앱 안 사용 기록(이벤트). 앱은 넣기만 해요. 원문 UA·IP 는 없어요. properties.migrated = 서버 연결 전에 이 기기에 남았던 기록.';

create index if not exists events_user_id_client_at_idx on public.events (user_id, client_at);
create index if not exists events_name_client_at_idx on public.events (name, client_at);

-- ---------------------------------------------------------------------------
-- push_subscriptions: 기기별 웹 푸시 구독(PR4). 넣기·고치기는 register_push_subscription 로만

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1024),
  p256dh text not null check (char_length(p256dh) between 1 and 256),
  auth text not null check (char_length(auth) between 1 and 64),
  user_agent text check (char_length(user_agent) <= 300),
  display_mode text check (char_length(display_mode) <= 16),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count int not null default 0,
  disabled_at timestamptz
);

comment on table public.push_subscriptions is '기기별 웹 푸시 구독(PR4 부터). 앱은 register_push_subscription RPC 로만 넣어요.';

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- push_deliveries: 알림 발송 기록(PR5 발송기가 서버 키로만 쓴다). (user, 일정, 종류, 날짜)가 멱등성 열쇠

create table if not exists public.push_deliveries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  release_id text not null check (char_length(release_id) between 1 and 300),
  kind text not null check (kind in ('D-7', 'D-1', 'D-Day', 'test')),
  -- 한국 날짜
  due_date date not null,
  -- 09:00 또는 20:00 KST
  slot_at timestamptz not null,
  status text not null default 'claimed'
    check (status in ('claimed', 'sent', 'partial', 'failed', 'no_subscription')),
  sent_count int not null default 0,
  error text check (char_length(error) <= 2000),
  created_at timestamptz not null default now(),
  constraint push_deliveries_once_key unique (user_id, release_id, kind, due_date)
);

comment on table public.push_deliveries is '알림 발송 기록(PR5 발송기만 써요). 같은 사람·일정·종류·날짜는 한 번만.';

-- ---------------------------------------------------------------------------
-- 권한: 먼저 모두 거두고 필요한 것만 준다

revoke all on table public.profiles, public.interests, public.saves, public.events,
  public.push_subscriptions, public.push_deliveries
  from public, anon, authenticated, service_role;

-- 행 번호(identity) 시퀀스는 클라이언트가 직접 쓸 일이 없다(표에 넣는 권한만으로 번호가 매겨진다)
do $$
declare
  seq text;
begin
  foreach seq in array array[
    pg_get_serial_sequence('public.events', 'id'),
    pg_get_serial_sequence('public.push_deliveries', 'id')
  ] loop
    execute format('revoke all on sequence %s from public, anon, authenticated', seq);
    execute format('grant usage, select on sequence %s to service_role', seq);
  end loop;
end;
$$;

-- profiles: 내 행 읽기, 정해진 열만 고치기. 넣기는 트리거, 지우기는 계정 삭제(cascade)로만
grant select on table public.profiles to authenticated;
grant update (display_name, onboarding_complete, default_alerts, weekly_digest, notifications_seen_at, notifications_seen_ids)
  on table public.profiles to authenticated;

-- interests·saves: 내 행 읽기·넣기·고치기·지우기(user_id 는 auth.uid() 와 같아야 한다)
grant select, delete on table public.interests, public.saves to authenticated;
grant insert (user_id, interest_id) on table public.interests to authenticated;
grant update (interest_id) on table public.interests to authenticated;
grant insert (user_id, release_id, alert_presets) on table public.saves to authenticated;
grant update (alert_presets) on table public.saves to authenticated;

-- events: 넣기만. user_id·received_at·id 는 줄 수 없다(user_id 는 기본값 auth.uid())
grant insert (client_event_id, device_id, session_id, name, properties, path, display_mode, app_version, os, browser, in_app, client_at)
  on table public.events to authenticated;

-- push_subscriptions: 내 구독 읽기·지우기. 넣기·고치기는 RPC
grant select, delete on table public.push_subscriptions to authenticated;

-- push_deliveries: 내 발송 기록 읽기만
grant select on table public.push_deliveries to authenticated;

-- 서버 쪽(PR5 발송기, sb_secret_ 키 = service_role, RLS 우회)
grant select, insert, update, delete on table public.profiles, public.interests, public.saves, public.events,
  public.push_subscriptions, public.push_deliveries to service_role;

-- ---------------------------------------------------------------------------
-- RLS: 모든 표에 켜고, 정책은 "내 행"만

alter table public.profiles enable row level security;
alter table public.interests enable row level security;
alter table public.saves enable row level security;
alter table public.events enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_deliveries enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "interests: read own" on public.interests;
create policy "interests: read own" on public.interests
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "interests: insert own" on public.interests;
create policy "interests: insert own" on public.interests
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "interests: update own" on public.interests;
create policy "interests: update own" on public.interests
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "interests: delete own" on public.interests;
create policy "interests: delete own" on public.interests
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "saves: read own" on public.saves;
create policy "saves: read own" on public.saves
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "saves: insert own" on public.saves;
create policy "saves: insert own" on public.saves
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "saves: update own" on public.saves;
create policy "saves: update own" on public.saves
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "saves: delete own" on public.saves;
create policy "saves: delete own" on public.saves
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- events: 넣기만(읽기 정책 없음 → 앱에서 insert 할 때 returning 을 쓰지 않는다)
drop policy if exists "events: insert own" on public.events;
create policy "events: insert own" on public.events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions: read own" on public.push_subscriptions;
create policy "push_subscriptions: read own" on public.push_subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions: delete own" on public.push_subscriptions;
create policy "push_subscriptions: delete own" on public.push_subscriptions
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "push_deliveries: read own" on public.push_deliveries;
create policy "push_deliveries: read own" on public.push_deliveries
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- RPC

-- MVP 데이터 초기화: 부른 사람의 서버 기록을 지우고 profiles 를 기본값으로(is_internal·만든 시각은 둔다)
create or replace function public.delete_my_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'delete_my_data: not signed in' using errcode = '42501';
  end if;
  delete from public.events where user_id = uid;
  delete from public.saves where user_id = uid;
  delete from public.interests where user_id = uid;
  delete from public.push_deliveries where user_id = uid;
  delete from public.push_subscriptions where user_id = uid;
  update public.profiles
     set display_name = null,
         onboarding_complete = false,
         default_alerts = '{D-1,D-Day}',
         weekly_digest = true,
         notifications_seen_at = null,
         notifications_seen_ids = '{}',
         consented_at = null
   where user_id = uid;
end;
$$;

-- 웹 푸시 구독 등록(PR4). 같은 주소가 다른 계정에 있으면 지금 계정으로 옮긴다
-- (한 기기에서 계정을 바꾸면 RLS 때문에 upsert 가 막히는 문제를 피한다). 구독 id 를 돌려준다
create or replace function public.register_push_subscription(
  endpoint text,
  p256dh text,
  auth text,
  user_agent text default null,
  display_mode text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid uuid := (select auth.uid());
  subscription_id uuid;
begin
  if uid is null then
    raise exception 'register_push_subscription: not signed in' using errcode = '42501';
  end if;
  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, user_agent, display_mode)
  values (
    uid,
    register_push_subscription.endpoint,
    register_push_subscription.p256dh,
    register_push_subscription.auth,
    left(register_push_subscription.user_agent, 300),
    left(register_push_subscription.display_mode, 16)
  )
  on conflict (endpoint) do update
     set user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         display_mode = excluded.display_mode,
         created_at = case when s.user_id = excluded.user_id then s.created_at else now() end,
         last_seen_at = now(),
         failure_count = 0,
         disabled_at = null
  returning s.id into subscription_id;
  return subscription_id;
end;
$$;

-- 함수 실행 권한: Postgres 는 새 함수를 PUBLIC 에게 열어 두고, Supabase 는 anon·authenticated 에게도 준다. 다 거두고 필요한 곳만
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.delete_my_data() from public, anon, authenticated;
revoke all on function public.register_push_subscription(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.delete_my_data() to authenticated;
grant execute on function public.register_push_subscription(text, text, text, text, text) to authenticated;

commit;
