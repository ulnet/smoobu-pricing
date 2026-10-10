import admin from './admin.js';
import site from './pages.js';
import { cleanupHolds } from './bookings.js';
import { telegram } from './public.js';
import { html } from './util.js';

// ### 1 --- public image route (photos from R2)
async function img(env, p) {
  const k = p.slice(5);
  if (!/^[a-f0-9-]{36}\.jpg$/.test(k)) return new Response('Not found', { status: 404 });
  const o = await env.PHOTOS.get('p/' + k);
  if (!o) return new Response('Not found', { status: 404 });
  return new Response(o.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
}

// ### 2 --- fetch handler
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupHolds(env).catch(e => telegram(env, '⚠️ Direct site: hold cleanup failed: ' + e.message)));
  },
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    try {
      if (p === '/admin' || p.startsWith('/admin/')) return await admin(req, env, u);
      if (p.startsWith('/img/') && req.method === 'GET') return await img(env, p);
      const res = await site(req, env, u);
      if (res) return res;
      return html('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>', 404);
    } catch (e) {
      console.error(e.stack || e.message);
      return html('<!doctype html><meta charset="utf-8"><title>Error</title><p>Something went wrong.</p>', 500);
    }
  }
};
