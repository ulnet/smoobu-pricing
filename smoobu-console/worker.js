// ### 1 --- config (password is the ADMIN_PASSWORD secret binding, never in code)
const SESSION_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ### 2 --- auth: constant-time compare, lockout kept in settings table
function safeEqual(a, b) {
  const x = String(a), y = String(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return d === 0;
}

async function getSetting(env, key) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}

async function putSetting(env, key, value) {
  await env.DB
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, String(value))
    .run();
}

function getToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

async function isAuthed(request, env) {
  const token = getToken(request);
  if (!token) return false;
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token = ?").bind(token).first();
  if (!row) return false;
  return new Date(row.expires_at) > new Date();
}

async function requireAuth(request, env) {
  if (!(await isAuthed(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "login not configured" }, 503);

  const lockedUntil = await getSetting(env, "login_locked_until");
  if (lockedUntil && new Date(lockedUntil) > new Date()) {
    const mins = Math.ceil((new Date(lockedUntil) - new Date()) / 60000);
    return json({ ok: false, locked: true, error: `Too many attempts. Try again in ${mins} minute(s).` }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad request" }, 400);
  }

  if (!safeEqual(body.password || "", env.ADMIN_PASSWORD)) {
    const failed = (parseInt(await getSetting(env, "login_failed"), 10) || 0) + 1;
    if (failed >= MAX_FAILED) {
      await putSetting(env, "login_failed", 0);
      await putSetting(env, "login_locked_until", new Date(Date.now() + LOCK_MINUTES * 60000).toISOString());
      return json({ ok: false, locked: true, error: `Too many attempts. Locked for ${LOCK_MINUTES} minutes.` }, 429);
    }
    await putSetting(env, "login_failed", failed);
    return json({ ok: false, error: "invalid password", attemptsLeft: MAX_FAILED - failed }, 401);
  }

  await putSetting(env, "login_failed", 0);
  await putSetting(env, "login_locked_until", "");
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()).run();

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expiresAt).run();
  return json({ ok: true, token });
}

async function handleLogout(request, env) {
  const token = getToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true });
}

async function handleCheck(request, env) {
  return json({ authed: await isAuthed(request, env) });
}

// ### 3 --- menu_items
async function listMenuItems(env) {
  const { results } = await env.DB
    .prepare("SELECT * FROM menu_items WHERE enabled = 1 ORDER BY sort_order, id")
    .all();
  return json(results);
}

async function createMenuItem(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { label, type, target, sort_order = 0 } = await request.json();
  if (!label || !type || !target) return json({ ok: false, error: "missing fields" }, 400);
  const res = await env.DB
    .prepare("INSERT INTO menu_items (label, type, target, sort_order) VALUES (?, ?, ?, ?)")
    .bind(label, type, target, sort_order)
    .run();
  return json({ ok: true, id: res.meta.last_row_id });
}

async function updateMenuItem(request, env, id) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { label, type, target, sort_order, enabled } = await request.json();
  await env.DB
    .prepare(
      `UPDATE menu_items SET
        label = COALESCE(?, label),
        type = COALESCE(?, type),
        target = COALESCE(?, target),
        sort_order = COALESCE(?, sort_order),
        enabled = COALESCE(?, enabled)
       WHERE id = ?`
    )
    .bind(label ?? null, type ?? null, target ?? null, sort_order ?? null, enabled ?? null, id)
    .run();
  return json({ ok: true });
}

async function deleteMenuItem(request, env, id) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  await env.DB.prepare("DELETE FROM menu_items WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ### 4 --- pages
async function listPages(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { results } = await env.DB
    .prepare("SELECT id, slug, title, updated_at FROM pages ORDER BY updated_at DESC")
    .all();
  return json(results);
}

async function servePage(env, slug) {
  const row = await env.DB.prepare("SELECT html_content FROM pages WHERE slug = ?").bind(slug).first();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(row.html_content, { headers: { "Content-Type": "text/html", ...corsHeaders() } });
}

async function upsertPage(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { slug, title, html_content } = await request.json();
  if (!slug || !title || !html_content) return json({ ok: false, error: "missing fields" }, 400);
  await env.DB
    .prepare(
      `INSERT INTO pages (slug, title, html_content, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET title = excluded.title, html_content = excluded.html_content, updated_at = datetime('now')`
    )
    .bind(slug, title, html_content)
    .run();
  return json({ ok: true });
}

async function deletePage(request, env, id) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  await env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ### 5 --- router
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const m = request.method;

    if (m === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    if (url.pathname === "/api/login" && m === "POST") return handleLogin(request, env);
    if (url.pathname === "/api/logout" && m === "POST") return handleLogout(request, env);
    if (url.pathname === "/api/check" && m === "GET") return handleCheck(request, env);

    if (url.pathname === "/api/menu" && m === "GET") return listMenuItems(env);
    if (url.pathname === "/api/menu" && m === "POST") return createMenuItem(request, env);
    if (parts[0] === "api" && parts[1] === "menu" && parts[2] && m === "PUT") return updateMenuItem(request, env, parts[2]);
    if (parts[0] === "api" && parts[1] === "menu" && parts[2] && m === "DELETE") return deleteMenuItem(request, env, parts[2]);

    if (url.pathname === "/api/pages" && m === "GET") return listPages(request, env);
    if (url.pathname === "/api/pages" && m === "POST") return upsertPage(request, env);
    if (parts[0] === "api" && parts[1] === "pages" && parts[2] && m === "DELETE") return deletePage(request, env, parts[2]);
    if (parts[0] === "page" && parts[1]) return servePage(env, parts[1]);

    return new Response("Not found", { status: 404 });
  },
};
