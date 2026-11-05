/**
 * 스모크 시험용 가짜 Supabase. 앱이 실제로 쓰는 엔드포인트만 흉내 낸다.
 *   POST /auth/v1/signup          익명 가입 → 세션 JSON
 *   POST /auth/v1/token           refresh_token 으로 새 토큰
 *   POST /auth/v1/logout          로그아웃(토큰 무효)
 *   GET  /auth/v1/user            현재 사용자
 *   POST /rest/v1/events          사용 기록(배열). Prefer: return=minimal, user_id 금지, 같은 client_event_id 는 409
 *   POST /rest/v1/rpc/delete_my_data   그 사용자의 기록 삭제
 * 브라우저에서 다른 출처로 부르므로 CORS(사전 요청 포함)를 연다. 알 수 없는 요청은 unknown 에 남기고 404.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

export async function startMockSupabase({ key }) {
  const state = {
    /** 익명 가입 요청 기록 */
    signups: [],
    /** POST /rest/v1/events 요청마다 { userId, count, status } */
    eventRequests: [],
    /** 들어간 기록(user_id 붙여서) */
    events: [],
    rpcCalls: [],
    logouts: [],
    refreshes: 0,
    unknown: [],
    /** true 면 /rest/v1/events 가 500 */
    failEvents: false,
    tokens: new Map(),
    refreshTokens: new Map(),
    users: new Map(),
  };

  function issue(userId) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: userId, role: "authenticated", aud: "authenticated", is_anonymous: true, iat: now, exp: now + 3600 };
    const accessToken = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.${b64url(randomUUID())}`;
    const refreshToken = randomUUID();
    state.tokens.set(accessToken, userId);
    state.refreshTokens.set(refreshToken, userId);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: refreshToken,
      user: state.users.get(userId),
    };
  }

  const server = createServer(async (req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "apikey, authorization, content-type, prefer, x-client-info",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
    const send = (status, body) => {
      res.writeHead(status, { ...cors, ...(body === undefined ? {} : { "Content-Type": "application/json" }) });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204);

    const url = new URL(req.url ?? "/", "http://mock");
    const raw = await readBody(req);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      return send(400, { code: "PGRST102", message: "invalid json" });
    }
    if (req.headers.apikey !== key) return send(401, { message: "Invalid API key" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const userId = state.tokens.get(bearer) ?? null;

    if (req.method === "POST" && url.pathname === "/auth/v1/signup") {
      if (body?.email || body?.phone || body?.password) return send(422, { msg: "only anonymous sign-ups in this mock" });
      const id = randomUUID();
      const at = new Date().toISOString();
      state.users.set(id, {
        id, aud: "authenticated", role: "authenticated", email: "", phone: "", is_anonymous: true,
        app_metadata: { provider: "anonymous", providers: [] }, user_metadata: {}, identities: [], created_at: at, updated_at: at,
      });
      state.signups.push({ id, at: Date.now() });
      return send(200, issue(id));
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const owner = state.refreshTokens.get(body?.refresh_token);
      if (!owner) return send(400, { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      state.refreshTokens.delete(body.refresh_token);
      state.refreshes += 1;
      return send(200, issue(owner));
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/logout") {
      state.logouts.push({ userId, scope: url.searchParams.get("scope") });
      state.tokens.delete(bearer);
      return send(204);
    }
    if (req.method === "GET" && url.pathname === "/auth/v1/user") {
      return userId ? send(200, state.users.get(userId)) : send(401, { msg: "invalid JWT" });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/events") {
      if (!userId) {
        state.eventRequests.push({ userId: null, count: 0, status: 401 });
        return send(401, { code: "PGRST301", message: "JWT invalid" });
      }
      const rows = Array.isArray(body) ? body : [body];
      if (state.failEvents) {
        state.eventRequests.push({ userId, count: rows.length, status: 500 });
        return send(500, { message: "mock failure" });
      }
      if (!/return=minimal/.test(req.headers.prefer ?? "")) {
        state.eventRequests.push({ userId, count: rows.length, status: 403 });
        return send(403, { code: "42501", message: "events has no select policy: use return=minimal" });
      }
      if (rows.some((row) => "user_id" in row || "received_at" in row || "id" in row)) {
        state.eventRequests.push({ userId, count: rows.length, status: 403 });
        return send(403, { code: "42501", message: "permission denied for table events" });
      }
      if (rows.some((row) => state.events.some((e) => e.user_id === userId && e.client_event_id === row.client_event_id))) {
        state.eventRequests.push({ userId, count: rows.length, status: 409 });
        return send(409, { code: "23505", message: "duplicate key value violates unique constraint" });
      }
      state.eventRequests.push({ userId, count: rows.length, status: 201 });
      for (const row of rows) state.events.push({ ...row, user_id: userId });
      return send(201);
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/delete_my_data") {
      state.rpcCalls.push({ name: "delete_my_data", userId });
      if (!userId) return send(401, { code: "PGRST301", message: "JWT invalid" });
      state.events = state.events.filter((e) => e.user_id !== userId);
      return send(204);
    }
    state.unknown.push(`${req.method} ${url.pathname}${url.search}`);
    return send(404, { message: "not mocked" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
