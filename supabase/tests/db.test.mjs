/**
 * supabase/migrations/0001_init.sql + supabase/admin-views.sql 시험(`npm run test:db`).
 * 일회용 PostgreSQL 에 작은 Supabase 흉내(shim.sql)를 깔고, PostgREST 가 하듯 role 과 request.jwt.claims 를 바꿔 가며
 * RLS·열 권한·RPC·요약 보기를 확인한다. 두 가지 기본 권한(예전 Supabase: 다 줌 / 지금: 안 줌) 모두에서 같은 시험을 돈다.
 * PostgreSQL 이 없으면 건너뛴다(실패 아님). `npm test` 와 Vercel 빌드에는 들어가지 않는다.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findPostgres, startPostgres } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "..", "migrations", "0001_init.sql");
const ADMIN_VIEWS = join(here, "..", "admin-views.sql");
const SHIM = join(here, "shim.sql");
const README = join(here, "..", "..", "README.md");

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // 이메일 계정
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // 이메일 계정
const N = "cccccccc-0000-4000-8000-000000000003"; // 익명 계정(기록 있음)
const S = "dddddddd-0000-4000-8000-000000000004"; // Seo 본인(is_internal)
const G = "eeeeeeee-0000-4000-8000-000000000005"; // 익명 계정(기록 없음: 초기화하고 남은 옛 계정 같은)

const SEED = `
insert into auth.users (id, email, is_anonymous) values
  ('${A}', 'a@example.com', false),
  ('${B}', 'b@example.com', false),
  ('${N}', null, true),
  ('${S}', 'seo@example.com', false),
  ('${G}', null, true);
update public.profiles set is_internal = true where user_id = '${S}';
update public.profiles set display_name = 'A', onboarding_complete = true, default_alerts = '{D-7,D-1}', consented_at = now() where user_id = '${A}';
insert into public.interests (user_id, interest_id) values
  ('${A}', 'category:music'), ('${B}', 'entity:teen-top'), ('${B}', 'category:game');
insert into public.saves (user_id, release_id, alert_presets) values
  ('${A}', 'rel-1', null), ('${A}', 'rel-2', '{}'), ('${B}', 'rel-1', '{D-7}');
insert into public.events (user_id, device_id, session_id, name, properties, path, display_mode, os, browser, in_app, client_at) values
  ('${A}', 'dev-a', 's-a', 'app_open', '{"display_mode":"browser"}', '/home', 'browser', 'ios', 'safari', null, '2026-10-21T15:30:00Z'),
  ('${A}', 'dev-a', 's-a', 'add_to_trove', '{"item_id":"rel-1"}', '/home', 'browser', 'ios', 'safari', null, '2026-10-21T15:31:00Z'),
  ('${B}', 'dev-b', 's-b', 'app_open', '{}', '/home', 'standalone', 'android', 'chrome', 'kakaotalk', '2026-10-21T14:59:00Z'),
  ('${N}', 'dev-n', 's-n', 'app_open', '{}', '/home', 'browser', 'mac', 'chrome', null, '2026-10-22T01:00:00Z'),
  ('${S}', 'dev-s', 's-s', 'app_open', '{}', '/home', 'browser', 'mac', 'safari', null, '2026-10-22T02:00:00Z');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('${A}', 'https://push.example/a', 'p-a', 'k-a'), ('${B}', 'https://push.example/b', 'p-b', 'k-b');
insert into public.push_deliveries (user_id, release_id, kind, due_date, slot_at, status, sent_count) values
  ('${A}', 'rel-1', 'D-1', '2026-10-23', '2026-10-22T11:00:00Z', 'sent', 1),
  ('${B}', 'rel-1', 'D-7', '2026-10-29', '2026-10-22T11:00:00Z', 'failed', 0);
`;

/** PostgREST 처럼: 이 트랜잭션 동안 role = authenticated, JWT 클레임 = 이 사용자 */
function as(userId, { anonymous = false } = {}) {
  const claims = JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated", is_anonymous: anonymous });
  return `do $$ begin perform set_config('request.jwt.claims', '${claims}', true); end $$;\nset local role authenticated;\n`;
}

/** 로그인 전(JWT 없음) */
const asAnon = "set local role anon;\n";

const found = findPostgres();

if (found.skip) {
  console.log(`\n[test:db] ${found.skip}\n`);
  test("Supabase 마이그레이션·RLS 시험", { skip: found.skip }, () => {});
} else {
  const pg = await startPostgres(found);
  after(() => pg.stop());

  for (const mode of [
    { name: "legacy-grants", legacy: true, label: "예전 Supabase 기본 권한(새 표를 anon·authenticated 에게 다 줌)" },
    { name: "no-auto-grants", legacy: false, label: "지금 Supabase 기본 권한(새 표에 자동 권한 없음)" },
  ]) {
    describe(mode.label, () => {
      const db = mode.name;

      /** 트랜잭션 안에서 실행하고 되돌린다. 성공해야 하고, 결과 줄들을 돌려준다 */
      async function rows(body) {
        const result = await pg.sql(db, `begin;\n${body}\nrollback;\n`);
        if (result.code !== 0) assert.fail(`SQL 실패:\n${result.stderr}\n--- SQL ---\n${body}`);
        return result.stdout.trim() === "" ? [] : result.stdout.trim().split("\n");
      }
      const one = async (body) => (await rows(body)).at(-1);

      /** 실패해야 하는 SQL. 오류 문구가 pattern 에 맞는지 본다 */
      async function rejects(body, pattern) {
        const result = await pg.sql(db, `begin;\n${body}\nrollback;\n`);
        assert.notEqual(result.code, 0, `실패해야 하는데 성공했어요:\n${body}\n${result.stdout}`);
        assert.match(result.stderr, pattern, `오류가 달라요:\n${result.stderr}`);
      }

      async function file(path, vars) {
        const result = await pg.sql(db, await readFile(path, "utf8"), { vars });
        if (result.code !== 0) throw new Error(`${path} 실패:\n${result.stderr}`);
        return result;
      }

      before(async () => {
        await pg.createDatabase(db);
        await file(SHIM, { legacy_grants: mode.legacy });
        await file(MIGRATION);
        await file(ADMIN_VIEWS);
        const seeded = await pg.sql(db, SEED);
        if (seeded.code !== 0) throw new Error(`시드 실패:\n${seeded.stderr}`);
      });

      describe("구조", () => {
        test("두 SQL 파일을 다시 실행해도 오류 없이 끝나고 데이터는 그대로다", async () => {
          await file(MIGRATION);
          await file(ADMIN_VIEWS);
          assert.equal(await one("select count(*) from public.events;"), "5");
          assert.equal(await one("select count(*) from public.profiles;"), "5");
          assert.equal(await one(`select is_internal from public.profiles where user_id = '${S}';`), "t");
        });

        test("public 의 표 6개 모두 RLS 가 켜져 있다", async () => {
          const tables = await rows(
            "select c.relname || ':' || c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1;",
          );
          assert.deepEqual(tables, ["events:true", "interests:true", "profiles:true", "push_deliveries:true", "push_subscriptions:true", "saves:true"]);
        });

        test("security definer 함수는 search_path 가 비어 있고, anon·PUBLIC 은 RPC 를 실행할 수 없다", async () => {
          const definers = await rows(
            "select p.proname || ':' || array_to_string(p.proconfig, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef order by 1;",
          );
          assert.deepEqual(definers, [
            'delete_my_data:search_path=""',
            'handle_new_user:search_path=""',
            'register_push_subscription:search_path=""',
          ]);
          const privileges = await rows(`
            select has_function_privilege('anon', 'public.delete_my_data()', 'execute'),
                   has_function_privilege('authenticated', 'public.delete_my_data()', 'execute'),
                   has_function_privilege('anon', 'public.register_push_subscription(text,text,text,text,text)', 'execute'),
                   has_function_privilege('authenticated', 'public.register_push_subscription(text,text,text,text,text)', 'execute'),
                   has_function_privilege('authenticated', 'public.handle_new_user()', 'execute'),
                   exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                           where p.proname in ('delete_my_data', 'register_push_subscription', 'handle_new_user') and a.grantee = 0);`);
          assert.deepEqual(privileges, ["f|t|f|t|f|f"]);
        });

        test("auth.users 에 사용자가 생기면(익명 포함) profiles 행이 기본값으로 생긴다", async () => {
          const result = await one(`
            insert into auth.users (id, is_anonymous) values ('ffffffff-0000-4000-8000-000000000009', true);
            select onboarding_complete || '|' || default_alerts::text || '|' || weekly_digest || '|' || is_internal
              from public.profiles where user_id = 'ffffffff-0000-4000-8000-000000000009';`);
          assert.equal(result, "false|{D-1,D-Day}|true|false");
        });

        test("auth.users 를 지우면 그 사용자의 모든 행이 함께 지워진다(cascade)", async () => {
          const result = await one(`
            delete from auth.users where id = '${A}';
            select (select count(*) from public.profiles where user_id = '${A}')
                 + (select count(*) from public.events where user_id = '${A}')
                 + (select count(*) from public.saves where user_id = '${A}')
                 + (select count(*) from public.interests where user_id = '${A}')
                 + (select count(*) from public.push_subscriptions where user_id = '${A}')
                 + (select count(*) from public.push_deliveries where user_id = '${A}');`);
          assert.equal(result, "0");
        });
      });

      describe("profiles", () => {
        test("내 프로필만 보인다", async () => {
          assert.deepEqual(await rows(`${as(A)} select user_id from public.profiles;`), [A]);
        });

        test("내 프로필의 정해진 열은 고칠 수 있고 updated_at 이 갱신된다", async () => {
          const result = await one(`${as(A)}
            update public.profiles set default_alerts = '{D-Day}', weekly_digest = false, notifications_seen_ids = '{x}' where user_id = '${A}';
            select default_alerts::text || '|' || weekly_digest || '|' || (updated_at = now()) from public.profiles;`);
          assert.equal(result, "{D-Day}|false|true");
        });

        test("남의 프로필은 고칠 수 없다(0행)", async () => {
          const result = await rows(`${as(A)}
            with changed as (update public.profiles set onboarding_complete = true where user_id = '${B}' returning 1)
            select count(*) from changed;
            reset role;
            select onboarding_complete from public.profiles where user_id = '${B}';`);
          assert.deepEqual(result, ["0", "f"]);
        });

        test("is_internal 은 클라이언트가 바꿀 수 없다", async () => {
          await rejects(`${as(A)} update public.profiles set is_internal = true where user_id = '${A}';`, /permission denied for table profiles/);
        });

        test("consented_at 은 클라이언트가 직접 쓸 수 없다", async () => {
          await rejects(`${as(A)} update public.profiles set consented_at = now() where user_id = '${A}';`, /permission denied for table profiles/);
        });

        test("프로필을 직접 만들거나 지울 수 없다", async () => {
          await rejects(`${as(A)} insert into public.profiles (user_id) values ('${A}');`, /permission denied for table profiles/);
          await rejects(`${as(A)} delete from public.profiles where user_id = '${A}';`, /permission denied for table profiles/);
        });

        test("허용 목록 밖의 알림 시점은 저장되지 않는다", async () => {
          await rejects(`${as(A)} update public.profiles set default_alerts = '{D-3}' where user_id = '${A}';`, /profiles_default_alerts_check/);
        });
      });

      describe("interests · saves", () => {
        test("내 관심사·담기만 보인다", async () => {
          assert.deepEqual(await rows(`${as(A)} select interest_id from public.interests order by 1;`), ["category:music"]);
          assert.deepEqual(await rows(`${as(A)} select release_id || ':' || coalesce(alert_presets::text, 'default') from public.saves order by 1;`), [
            "rel-1:default",
            "rel-2:{}",
          ]);
          assert.equal(await one(`${as(A)} select count(*) from public.saves where user_id = '${B}';`), "0");
        });

        test("user_id 없이 넣으면 내 것이 되고, 남의 user_id 로는 넣을 수 없다", async () => {
          const owner = await one(`${as(A)}
            insert into public.interests (interest_id) values ('entity:new-artist');
            insert into public.saves (release_id) values ('rel-9');
            reset role;
            select (select user_id from public.interests where interest_id = 'entity:new-artist') || '|' ||
                   (select user_id from public.saves where release_id = 'rel-9');`);
          assert.equal(owner, `${A}|${A}`);
          await rejects(`${as(A)} insert into public.interests (user_id, interest_id) values ('${B}', 'category:movie');`, /row-level security/);
          await rejects(`${as(A)} insert into public.saves (user_id, release_id) values ('${B}', 'rel-9');`, /row-level security/);
        });

        test("관심사 id 는 category: 또는 entity: 로 시작해야 한다", async () => {
          await rejects(`${as(A)} insert into public.interests (interest_id) values ('music');`, /interests_interest_id_check/);
        });

        test("남의 담기는 고치거나 지울 수 없다(0행), 내 담기는 된다", async () => {
          const result = await rows(`${as(A)}
            update public.saves set alert_presets = '{D-Day}' where user_id = '${B}';
            delete from public.saves where user_id = '${B}';
            delete from public.interests where user_id = '${B}';
            update public.saves set alert_presets = '{D-7,D-Day}' where release_id = 'rel-1';
            delete from public.interests where interest_id = 'category:music';
            reset role;
            select alert_presets::text from public.saves where user_id = '${B}' and release_id = 'rel-1';
            select count(*) from public.interests where user_id = '${B}';
            select alert_presets::text from public.saves where user_id = '${A}' and release_id = 'rel-1';
            select count(*) from public.interests where user_id = '${A}';`);
          assert.deepEqual(result, ["{D-7}", "2", "{D-7,D-Day}", "0"]);
        });

        test("내 담기를 남에게 넘길 수 없다(user_id 열은 고칠 수 없다)", async () => {
          await rejects(`${as(A)} update public.saves set user_id = '${B}' where release_id = 'rel-1';`, /permission denied for table saves/);
        });

        test("PostgREST upsert 모양(on conflict … do update set release_id, alert_presets)으로 담기·알림을 한 번에 저장한다", async () => {
          // supabase-js .from('saves').upsert({ release_id, alert_presets }) → Prefer: resolution=merge-duplicates
          const upsert = (release, presets) => `
            insert into public.saves (release_id, alert_presets) values ('${release}', '${presets}')
              on conflict (user_id, release_id) do update set release_id = excluded.release_id, alert_presets = excluded.alert_presets;`;
          const result = await rows(`${as(A)}
            ${upsert("rel-1", "{D-1}")}
            ${upsert("rel-new", "{D-7}")}
            reset role;
            select release_id || ':' || coalesce(alert_presets::text, 'default') from public.saves where user_id = '${A}' order by 1;
            select alert_presets::text from public.saves where user_id = '${B}' and release_id = 'rel-1';`);
          assert.deepEqual(result, ["rel-1:{D-1}", "rel-2:{}", "rel-new:{D-7}", "{D-7}"]);
        });

        test("알림 시점은 허용 목록 안에서만", async () => {
          await rejects(`${as(A)} update public.saves set alert_presets = '{D-30}' where release_id = 'rel-1';`, /saves_alert_presets_check/);
        });
      });

      describe("events", () => {
        const insert = (extra = "") => `
          insert into public.events (client_event_id, device_id, session_id, name, properties, path, display_mode, app_version, os, browser, in_app, client_at${extra ? ", " + extra.split("=")[0] : ""})
          values ('11111111-1111-4111-8111-111111111111', 'dev-a', 's-a', 'home_view', '{"surface":"home"}', '/home', 'browser', 'abc1234', 'ios', 'safari', null, '2026-10-22T03:00:00Z'${extra ? ", " + extra.split("=")[1] : ""});`;

        test("user_id 없이 넣으면(returning 없이) 내 기록이 되고 받은 시각이 붙는다", async () => {
          const result = await one(`${as(A)} ${insert()}
            reset role;
            select user_id || '|' || (received_at = now()) || '|' || name from public.events where client_event_id = '11111111-1111-4111-8111-111111111111';`);
          assert.equal(result, `${A}|true|home_view`);
        });

        test("PostgREST 가 만드는 모양(json 묶음 + RETURNING 1, return=minimal)으로 여러 개를 한 번에 넣을 수 있다", async () => {
          const body = JSON.stringify([
            { client_event_id: "22222222-2222-4222-8222-222222222221", device_id: "dev-a", session_id: "s", name: "app_open", properties: { display_mode: "browser" }, path: "/home", display_mode: "browser", app_version: "dev", os: "ios", browser: "safari", in_app: null, client_at: "2026-10-22T03:00:00Z" },
            { client_event_id: "22222222-2222-4222-8222-222222222222", device_id: "dev-a", session_id: "s", name: "home_view", properties: {}, path: "/home", display_mode: "browser", app_version: "dev", os: "ios", browser: "safari", in_app: "kakaotalk", client_at: "2026-10-22T03:00:01Z" },
          ]);
          const result = await rows(`${as(A)}
            with pgrst_source as (
              insert into public.events (client_event_id, device_id, session_id, name, properties, path, display_mode, app_version, os, browser, in_app, client_at)
              select pgrst_body.client_event_id, pgrst_body.device_id, pgrst_body.session_id, pgrst_body.name, pgrst_body.properties, pgrst_body.path,
                     pgrst_body.display_mode, pgrst_body.app_version, pgrst_body.os, pgrst_body.browser, pgrst_body.in_app, pgrst_body.client_at
                from (select '${body}'::json as json_data) pgrst_payload,
                     lateral (select * from json_to_recordset(pgrst_payload.json_data) as _(
                       client_event_id uuid, device_id text, session_id text, name text, properties jsonb, path text,
                       display_mode text, app_version text, os text, browser text, in_app text, client_at timestamptz)) pgrst_body
              returning 1
            )
            select count(*) from pgrst_source;
            reset role;
            select count(*) from public.events where user_id = '${A}' and client_event_id::text like '22222222-%';`);
          assert.deepEqual(result, ["2", "2"]);
        });

        test("익명 계정도 넣을 수 있다", async () => {
          const result = await one(`${as(N, { anonymous: true })} ${insert()}
            reset role;
            select user_id from public.events where client_event_id = '11111111-1111-4111-8111-111111111111';`);
          assert.equal(result, N);
        });

        test("읽을 수 없다(내 기록도)", async () => {
          await rejects(`${as(A)} select count(*) from public.events;`, /permission denied for table events/);
          await rejects(`${as(A)} ${insert().replace(/;\s*$/, "")} returning id;`, /permission denied for table events/);
        });

        test("user_id 를 직접 넣을 수 없다(남의 것으로 꾸밀 수 없다)", async () => {
          await rejects(`${as(A)} ${insert(`user_id='${B}'`)}`, /permission denied for table events/);
          await rejects(`${as(A)} ${insert(`user_id='${A}'`)}`, /permission denied for table events/);
        });

        test("받은 시각·id 를 꾸밀 수 없다", async () => {
          await rejects(`${as(A)} ${insert("received_at='2020-01-01T00:00:00Z'")}`, /permission denied for table events/);
        });

        test("고치거나 지울 수 없다", async () => {
          await rejects(`${as(A)} update public.events set name = 'x' where user_id = '${A}';`, /permission denied for table events/);
          await rejects(`${as(A)} delete from public.events where user_id = '${A}';`, /permission denied for table events/);
        });

        test("같은 client_event_id 는 한 번만 들어간다(다른 계정이면 따로)", async () => {
          await rejects(`${as(A)} ${insert()} ${insert()}`, /events_user_client_event_key/);
          const count = await one(`${as(A)} ${insert()} ${as(B)} ${insert()}
            reset role;
            select count(*) from public.events where client_event_id = '11111111-1111-4111-8111-111111111111';`);
          assert.equal(count, "2");
        });

        test("크기 제한: properties 2KB, 객체만, 이름 형식", async () => {
          const big = JSON.stringify({ query: "가".repeat(1200) });
          await rejects(`${as(A)} ${insert().replace(`'{"surface":"home"}'`, `'${big}'`)}`, /events_properties_check/);
          await rejects(`${as(A)} ${insert().replace(`'{"surface":"home"}'`, `'[1,2]'`)}`, /events_properties_check/);
          await rejects(`${as(A)} ${insert().replace("'home_view'", "'Home View'")}`, /events_name_check/);
          await rejects(`${as(A)} ${insert().replace("'/home'", `'/${"x".repeat(400)}'`)}`, /events_path_check/);
        });
      });

      describe("로그인 전(anon, JWT 없음)", () => {
        const statements = [
          "select * from public.profiles;",
          "select * from public.interests;",
          "select * from public.saves;",
          "select * from public.push_subscriptions;",
          "select * from public.push_deliveries;",
          "insert into public.events (device_id, name, client_at) values ('d', 'home_view', now());",
          "insert into public.saves (user_id, release_id) values (gen_random_uuid(), 'rel-1');",
          "update public.profiles set onboarding_complete = true;",
        ];
        for (const statement of statements) {
          test(`막힌다: ${statement}`, async () => {
            await rejects(`${asAnon} ${statement}`, /permission denied for table/);
          });
        }

        test("RPC 도 못 부른다", async () => {
          await rejects(`${asAnon} select public.delete_my_data();`, /permission denied for function delete_my_data/);
          await rejects(
            `${asAnon} select public.register_push_subscription('https://push.example/x', 'p', 'k');`,
            /permission denied for function register_push_subscription/,
          );
        });

        test("JWT 없이 authenticated 로만 와도 delete_my_data 는 아무것도 지우지 않고 거절한다", async () => {
          await rejects("set local role authenticated; select public.delete_my_data();", /not signed in/);
        });
      });

      describe("익명 계정 = authenticated 와 같은 규칙", () => {
        test("내 프로필을 읽고 담기를 넣고, 남의 것은 안 보인다", async () => {
          const result = await rows(`${as(N, { anonymous: true })}
            select count(*) from public.profiles;
            insert into public.saves (release_id) values ('rel-1');
            select count(*) from public.saves;
            select count(*) from public.interests;`);
          assert.deepEqual(result, ["1", "1", "0"]);
        });
      });

      describe("push_subscriptions · push_deliveries", () => {
        test("구독은 직접 넣거나 고칠 수 없고(RPC 로만), 내 것만 보이고 지울 수 있다", async () => {
          await rejects(
            `${as(A)} insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${A}', 'https://push.example/z', 'p', 'k');`,
            /permission denied for table push_subscriptions/,
          );
          await rejects(`${as(A)} update public.push_subscriptions set disabled_at = now();`, /permission denied for table push_subscriptions/);
          const result = await rows(`${as(A)}
            select endpoint from public.push_subscriptions;
            delete from public.push_subscriptions where user_id = '${B}';
            delete from public.push_subscriptions where user_id = '${A}';
            reset role;
            select count(*) from public.push_subscriptions where user_id = '${B}';
            select count(*) from public.push_subscriptions where user_id = '${A}';`);
          assert.deepEqual(result, ["https://push.example/a", "1", "0"]);
        });

        test("register_push_subscription: 새 주소는 내 것으로, 같은 주소를 다른 계정이 등록하면 그 계정으로 옮긴다", async () => {
          const result = await rows(`${as(A)}
            select public.register_push_subscription('https://push.example/new', 'p1', 'k1', 'ios safari', 'standalone') is not null;
            ${as(B)}
            select public.register_push_subscription('https://push.example/new', 'p2', 'k2', 'android chrome', 'browser') is not null;
            select count(*) from public.push_subscriptions where endpoint = 'https://push.example/new';
            ${as(A)}
            select count(*) from public.push_subscriptions where endpoint = 'https://push.example/new';
            reset role;
            select user_id || '|' || p256dh || '|' || auth || '|' || display_mode from public.push_subscriptions where endpoint = 'https://push.example/new';`);
          assert.deepEqual(result, ["t", "t", "1", "0", `${B}|p2|k2|browser`]);
        });

        test("register_push_subscription: 다른 계정의 기존 구독도 옮기고, 다시 켠다", async () => {
          const result = await one(`
            update public.push_subscriptions set disabled_at = now(), failure_count = 3 where endpoint = 'https://push.example/a';
            ${as(B)}
            select public.register_push_subscription('https://push.example/a', 'p3', 'k3');
            reset role;
            select user_id || '|' || (disabled_at is null) || '|' || failure_count || '|' || (select count(*) from public.push_subscriptions where user_id = '${A}')
              from public.push_subscriptions where endpoint = 'https://push.example/a';`);
          assert.equal(result, `${B}|true|0|0`);
        });

        test("register_push_subscription: https 주소만", async () => {
          await rejects(`${as(A)} select public.register_push_subscription('http://push.example/x', 'p', 'k');`, /push_subscriptions_endpoint_check/);
        });

        test("발송 기록은 내 것만 읽을 수 있고, 넣거나 고치거나 지울 수 없다", async () => {
          assert.deepEqual(await rows(`${as(A)} select kind || ':' || status from public.push_deliveries;`), ["D-1:sent"]);
          await rejects(
            `${as(A)} insert into public.push_deliveries (user_id, release_id, kind, due_date, slot_at) values ('${A}', 'rel-2', 'D-1', '2026-10-30', now());`,
            /permission denied for table push_deliveries/,
          );
          await rejects(`${as(A)} update public.push_deliveries set status = 'failed';`, /permission denied for table push_deliveries/);
          await rejects(`${as(A)} delete from public.push_deliveries;`, /permission denied for table push_deliveries/);
        });
      });

      describe("delete_my_data", () => {
        test("부른 사람의 서버 기록만 지우고 프로필을 기본값으로 되돌린다", async () => {
          const result = await rows(`${as(A)}
            do $$ begin perform public.delete_my_data(); end $$;
            reset role;
            select (select count(*) from public.events where user_id = '${A}') || '|' ||
                   (select count(*) from public.saves where user_id = '${A}') || '|' ||
                   (select count(*) from public.interests where user_id = '${A}') || '|' ||
                   (select count(*) from public.push_subscriptions where user_id = '${A}') || '|' ||
                   (select count(*) from public.push_deliveries where user_id = '${A}');
            select coalesce(display_name, '-') || '|' || onboarding_complete || '|' || default_alerts::text || '|' || (consented_at is null)
              from public.profiles where user_id = '${A}';
            select (select count(*) from public.events where user_id = '${B}') || '|' ||
                   (select count(*) from public.saves where user_id = '${B}') || '|' ||
                   (select count(*) from public.interests where user_id = '${B}') || '|' ||
                   (select count(*) from public.push_subscriptions where user_id = '${B}') || '|' ||
                   (select count(*) from public.push_deliveries where user_id = '${B}');
            select count(*) from public.events;`);
          assert.deepEqual(result, ["0|0|0|0|0", "-|false|{D-1,D-Day}|true", "1|1|2|1|1", "3"]);
        });

        test("익명 계정도 부를 수 있다", async () => {
          const result = await rows(`${as(N, { anonymous: true })}
            do $$ begin perform public.delete_my_data(); end $$;
            reset role;
            select count(*) from public.events where user_id = '${N}';`);
          assert.deepEqual(result, ["0"]);
        });

        test("is_internal 표시는 남긴다", async () => {
          const result = await one(`${as(S)}
            do $$ begin perform public.delete_my_data(); end $$;
            reset role;
            select is_internal from public.profiles where user_id = '${S}';`);
          assert.equal(result, "t");
        });
      });

      describe("admin 요약 보기", () => {
        test("앱(anon·authenticated)은 admin 스키마를 볼 수 없다", async () => {
          for (const view of ["testers", "daily", "funnel", "recent_events", "push_log"]) {
            await rejects(`${as(A)} select * from admin.${view};`, /permission denied for schema admin/);
            await rejects(`${asAnon} select * from admin.${view};`, /permission denied for schema admin/);
          }
          assert.deepEqual(
            await rows("select has_schema_privilege('anon', 'admin', 'usage'), has_schema_privilege('authenticated', 'admin', 'usage');"),
            ["f|f"],
          );
        });

        test("testers: 한 사람당 한 줄, Seo 본인과 기록 없는 익명 계정은 뺀다", async () => {
          const result = await rows(`
            select tester || '|' || saves || '|' || follows_entity || '|' || follows_category || '|' || alerts_on || '|' ||
                   default_alerts || '|' || push_devices || '|' || home_screen_app || '|' || active_days || '|' ||
                   coalesce(last_browser, '-') || '|' || opened_in_app_browser || '|' || to_char(first_seen_kst, 'YYYY-MM-DD HH24:MI')
              from admin.testers order by tester;`);
          assert.deepEqual(result, [
            "a@example.com|2|0|1|1|D-7, D-1|1|false|1|safari|false|2026-10-22 00:30",
            "b@example.com|1|1|1|1|D-1, D-Day|1|true|1|chrome|true|2026-10-21 23:59",
            `익명 · ${N.slice(0, 8)}|0|0|0|0|D-1, D-Day|0|false|1|chrome|false|2026-10-22 10:00`,
          ]);
        });

        test("daily: 한국 날짜로 묶고 Seo 본인은 뺀다", async () => {
          const result = await rows("select day_kst || '|' || visitors || '|' || events from admin.daily where events > 0 order by day_kst;");
          assert.deepEqual(result, ["2026-10-21|1|1", "2026-10-22|2|3"]);
          assert.deepEqual(await rows("select sum(new_saves) || '|' || sum(push_sent) from admin.daily;"), ["3|1"]);
        });

        test("funnel: 단계별로 닿은 방문자 수", async () => {
          const result = await rows("select step || ':' || label || ':' || users || ':' || coalesce(pct_of_visitors::text, '-') from admin.funnel;");
          assert.deepEqual(result, [
            "1:방문:3:100.0",
            "2:관심사 고름:2:66.7",
            "3:첫 담기:2:66.7",
            "4:로그인:2:66.7",
            "5:알림 허용:2:66.7",
            "6:푸시 눌러 들어옴:0:0.0",
          ]);
        });

        test("recent_events: 최근 것부터, Seo 본인 기록은 internal 로 표시해 보여 준다", async () => {
          const result = await rows("select name || '|' || tester || '|' || internal from admin.recent_events;");
          assert.equal(result.length, 5);
          assert.equal(result[0], "app_open|seo@example.com|true");
          assert.equal(result.at(-1), "app_open|b@example.com|false");
        });

        test("README 의 '본인 기기 빼기' SQL 을 그대로 돌리면 그 계정만 is_internal 이 되고 testers 에서 빠진다", async () => {
          const readme = await readFile(README, "utf8");
          const snippet = readme.slice(readme.indexOf("본인 기기 빼기")).match(/```sql\n([\s\S]*?)```/)?.[1];
          assert.ok(snippet, "README 에서 SQL 을 찾지 못했어요");
          const result = await rows(`
            insert into public.events (user_id, device_id, name, properties, client_at)
              values ('${N}', 'dev-n', 'discover_search', '{"query":"seo-내기기"}', now());
            ${snippet}
            select is_internal from public.profiles where user_id = '${N}';
            select count(*) from public.profiles where is_internal;
            select count(*) from admin.testers where tester = '익명 · ${N.slice(0, 8)}';`);
          assert.deepEqual(result, ["t", "2", "0"]);
        });

        test("push_log: 발송 기록과 결과", async () => {
          const result = await rows("select tester || '|' || kind || '|' || status || '|' || to_char(slot_kst, 'HH24:MI') from admin.push_log order by tester;");
          assert.deepEqual(result, ["a@example.com|D-1|sent|20:00", "b@example.com|D-7|failed|20:00"]);
        });
      });
    });
  }
}
