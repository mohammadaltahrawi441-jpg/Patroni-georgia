/* Patroni — the whole server in one file.

   Cloudflare Pages "advanced mode": a single _worker.js at the site root
   handles every request. Anything this file does not claim is handed to
   env.ASSETS, which serves index.html, the images, the magazines and applies
   _headers exactly as before.

   This replaces the functions/ directory. That directory used Cloudflare's own
   naming convention — functions/review/[id].js, functions/media/[[path]].js —
   and square brackets in a filename are what the dashboard's upload box
   rejects with "file type not supported". One file, no brackets, same
   behaviour, and the routes are now written out where you can read them.

   Bindings, set once in the Pages project settings:
     env.PATRONI_KV     KV namespace  — listing records and the live index
     env.PATRONI_MEDIA  R2 bucket     — the photos and the video
     env.ASSETS         provided automatically by Pages

   With either binding missing, every endpoint answers honestly and the
   website falls back to its WhatsApp flow on its own. */

/* ==================== storage helpers ==================== */

const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;      // 6 MB each after the browser resizes
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;     // 60 MB
const MAX_TOTAL_BYTES = 90 * 1024 * 1024;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8",
               "cache-control": "no-store", ...extra }
  });

const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

function stores(env) {
  const kv = env && env.PATRONI_KV, r2 = env && env.PATRONI_MEDIA;
  return { kv, r2, ready: !!(kv && r2) };
}

const HEX = "0123456789abcdef";
function rnd(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15];
  return s;
}
const newId = () => Date.now().toString(36) + rnd(3);
const newToken = () => rnd(16);

/* constant-time-ish compare so a wrong token cannot be found byte by byte */
function sameToken(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* Is this you? ADMIN_KEY is set once in the Pages project settings and never
   appears in the site's code. With it unset this always answers no and the
   site keeps its original behaviour. */
function adminOK(request, env) {
  const want = env && env.ADMIN_KEY;
  if (!want) return false;
  const got = request.headers.get("x-admin-key") || "";
  return sameToken(got, String(want));
}

const clean = (s, max) =>
  String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);

/* Everything a seller types is escaped before it is written into HTML. */
const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function readIndex(kv) {
  try {
    const raw = await kv.get("index");
    const v = raw ? JSON.parse(raw) : null;
    if (v && Array.isArray(v.ids)) return v;
  } catch (e) { /* a corrupt index must not take the board down */ }
  return { v: 0, ids: [] };
}

async function writeIndex(kv, ids) {
  /* The version must strictly increase. Date.now() alone does not: two writes
     inside the same millisecond — an approval immediately followed by an edit —
     produced an identical version, and a browser polling with ?v= was told
     "same" and never saw the change. */
  const prev = await readIndex(kv);
  const now = Date.now();
  const v = now > prev.v ? now : prev.v + 1;
  const next = { v, ids: ids.slice(0, 500) };
  await kv.put("index", JSON.stringify(next));
  return next;
}

/* ==================== POST /api/submit ==================== */

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
              "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

export async function handleSubmit(request, env) {
  const { kv, r2, ready } = stores(env);
  if (!ready) return bad("storage-not-configured", 503);

  let form;
  try { form = await request.formData(); }
  catch (e) { return bad("bad-form"); }

  let f;
  try { f = JSON.parse(form.get("listing") || "{}"); }
  catch (e) { return bad("bad-listing-json"); }

  const rec = {
    title: clean(f.title, 120),
    cat:   f.cat === "tour" ? "tour" : "property",
    city:  clean(f.city, 60),
    price: /^\d{1,9}$/.test(String(f.price || "")) ? +f.price : null,
    area:  clean(f.area, 20),
    rooms: clean(f.rooms, 20),
    desc:  clean(f.desc, 4000),
    who:   ["owner", "developer", "agency", "other"].includes(f.who) ? f.who : "owner",
    whoTxt: clean(f.whoTxt, 80),
    name:  clean(f.name, 80),
    phone: clean(f.phone, 40),
    lang:  ["en", "ar", "ka", "tr"].includes(f.lang) ? f.lang : "en"
  };
  if (rec.title.length < 4 || rec.city.length < 2 || rec.name.length < 2
      || rec.phone.replace(/\D/g, "").length < 7) return bad("missing-fields");

  /* Validate every file BEFORE writing any of them. Writing as we went left
     orphaned objects in the bucket whenever a later file failed the check. */
  const files = [];
  let total = 0, photos = 0;
  for (const [key, val] of form.entries()) {
    if (typeof val === "string" || !val || !val.size) continue;
    const isVideo = key === "video";
    if (!isVideo && !key.startsWith("photo")) continue;

    const type = String(val.type || "");
    if (!EXT[type]) return bad("unsupported-type:" + (type || "unknown"));
    if (isVideo && !type.startsWith("video/")) return bad("video-not-video");
    if (!isVideo && !type.startsWith("image/")) return bad("photo-not-image");

    if (isVideo) { if (files.some(x => x.isVideo)) return bad("one-video-only"); }
    else if (++photos > MAX_PHOTOS) return bad("too-many-photos");

    if (val.size > (isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES))
      return bad(isVideo ? "video-too-big" : "photo-too-big");
    total += val.size;
    if (total > MAX_TOTAL_BYTES) return bad("upload-too-big");

    files.push({ isVideo, type, val, n: isVideo ? 0 : photos - 1 });
  }

  const id = newId(), token = newToken();
  const media = [];
  try {
    for (const x of files) {
      const name = id + "/" + (x.isVideo ? "video" : "p" + String(x.n).padStart(2, "0"))
                 + "." + EXT[x.type];
      await r2.put(name, x.val.stream(), { httpMetadata: { contentType: x.type } });
      media.push({ kind: x.isVideo ? "video" : "photo", url: "/media/" + name, type: x.type });
    }
  } catch (e) {
    for (const m of media) { try { await r2.delete(m.url.slice(7)); } catch (e2) {} }
    return bad("store-failed", 500);
  }

  rec.media = media;
  rec.at = Date.now();
  rec.id = id;
  rec.token = token;
  rec.status = "pending";

  /* If the poster is signed in, the listing belongs to the account as well as
     to the token. That is what lets them manage it from a second device, and
     what lets deleting the account take its listings with it. Posting without
     an account still works exactly as before — the token in the browser is
     then the only proof of ownership. */
  const who = await whoami(kv, request, null);
  if (who) {
    rec.owner = who.user.email;
    who.user.ids = [id, ...(who.user.ids || [])].slice(0, 500);
    await kv.put("user:" + who.user.email, JSON.stringify(who.user));
  }

  await kv.put("pending:" + id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });

  const origin = new URL(request.url).origin;
  return json({ ok: true, id, token, review: origin + "/review/" + id + "?t=" + token });
}

/* ==================== POST /api/decide ==================== */

export async function handleDecide(request, env) {
  const { kv, r2, ready } = stores(env);
  if (!ready) return bad("storage-not-configured", 503);

  let body;
  try { body = await request.json(); } catch (e) { return bad("bad-json"); }
  const id = String(body.id || ""), token = String(body.token || "");
  const action = body.action === "reject" ? "reject"
               : body.action === "approve" ? "approve" : null;
  /* No token needed in the body any more: being signed in to the account that
     posted it, or holding the admin key, is proof too. The three ways are
     weighed together a few lines down. */
  if (!id || !action) return bad("missing-fields");

  const pendingRaw = await kv.get("pending:" + id);
  const liveRaw = pendingRaw ? null : await kv.get("live:" + id);
  const raw = pendingRaw || liveRaw;
  if (!raw) return bad("not-found", 404);

  const rec = JSON.parse(raw);

  /* Three ways to prove you may act on this listing:
       - the token handed back when it was posted (the seller's own device);
       - being signed in to the account that posted it (any device);
       - the admin key, which is you.                                      */
  const admin = adminOK(request, env);
  let allowed = sameToken(rec.token, token);
  if (!allowed) {
    const me = await whoami(kv, request, body);
    allowed = !!(me && rec.owner && me.user.email === rec.owner);
  }
  if (!allowed && !admin) return bad("bad-token", 403);

  /* Publishing is a different act from withdrawing.

     The review link travels to you inside a message the SELLER's own browser
     composes, so the seller can read it — which means the token in it cannot
     be what authorises publication, or anyone could wave their own listing
     onto the board. Set ADMIN_KEY in the Pages settings and only you can
     approve. Until you set it, this behaves exactly as it did before, so
     nothing breaks the day you deploy; the review page says which it is. */
  if (action === "approve" && env && env.ADMIN_KEY && !admin)
    return bad("admin-key-required", 403);

  if (action === "approve") {
    if (liveRaw) return json({ ok: true, already: true, status: "live" });
    rec.status = "live";
    rec.liveAt = Date.now();
    await kv.put("live:" + id, JSON.stringify(rec));
    await kv.delete("pending:" + id);
    const idx = await readIndex(kv);
    if (!idx.ids.includes(id)) idx.ids.unshift(id);
    await writeIndex(kv, idx.ids);
    return json({ ok: true, status: "live" });
  }

  /* reject: the record and every file it brought go away */
  for (const m of rec.media || []) {
    try { await r2.delete(m.url.slice(7)); } catch (e) { /* already gone */ }
  }
  await kv.delete("pending:" + id);
  if (liveRaw) {
    await kv.delete("live:" + id);
    const idx = await readIndex(kv);
    await writeIndex(kv, idx.ids.filter(x => x !== id));
  }
  /* and it stops counting against the account that posted it */
  if (rec.owner) {
    const u = await readUser(kv, rec.owner);
    if (u) {
      u.ids = (u.ids || []).filter(x => x !== id);
      await kv.put("user:" + rec.owner, JSON.stringify(u));
    }
  }
  return json({ ok: true, status: "rejected" });
}

/* ==================== POST /api/update ====================

   A seller who holds the token for their own listing can correct its text.
   Photos are deliberately not editable here: replacing files would orphan the
   old objects in R2 and re-open the moderation question, so a listing whose
   pictures are wrong is withdrawn and posted again.

   An edit to a LIVE listing bumps the index version, so every open browser
   picks the correction up on its next poll. */

export async function handleUpdate(request, env) {
  const { kv, ready } = stores(env);
  if (!ready) return bad("storage-not-configured", 503);

  let body;
  try { body = await request.json(); } catch (e) { return bad("bad-json"); }
  const id = String(body.id || ""), token = String(body.token || "");
  if (!id) return bad("missing-fields");

  const pendingRaw = await kv.get("pending:" + id);
  const liveRaw = pendingRaw ? null : await kv.get("live:" + id);
  const raw = pendingRaw || liveRaw;
  if (!raw) return bad("not-found", 404);

  const rec = JSON.parse(raw);
  /* the posting token, or the account that posted it, or you */
  let allowed = token && sameToken(rec.token, token);
  if (!allowed) {
    const me = await whoami(kv, request, body);
    allowed = !!(me && rec.owner && me.user.email === rec.owner);
  }
  if (!allowed && !adminOK(request, env)) return bad("bad-token", 403);

  const f = body.fields || {};
  const next = {
    title: clean(f.title, 120),
    city:  clean(f.city, 60),
    price: /^\d{1,9}$/.test(String(f.price || "")) ? +f.price : null,
    area:  clean(f.area, 20),
    rooms: clean(f.rooms, 20),
    desc:  clean(f.desc, 4000),
    name:  clean(f.name, 80),
    phone: clean(f.phone, 40),
    who:   ["owner", "developer", "agency", "other"].includes(f.who) ? f.who : rec.who,
    whoTxt: clean(f.whoTxt, 80)
  };
  if (next.title.length < 4 || next.city.length < 2 || next.name.length < 2
      || next.phone.replace(/\D/g, "").length < 7) return bad("missing-fields");

  Object.assign(rec, next);
  rec.editedAt = Date.now();

  if (liveRaw) {
    await kv.put("live:" + id, JSON.stringify(rec));
    const idx = await readIndex(kv);
    await writeIndex(kv, idx.ids);          /* new version -> browsers refresh */
  } else {
    await kv.put("pending:" + id, JSON.stringify(rec),
                 { expirationTtl: 60 * 60 * 24 * 30 });
  }
  return json({ ok: true, status: liveRaw ? "live" : "pending" });
}

/* ==================== /api/blog ====================

   GET  returns the posts the daily task has published, newest first.
   POST publishes one, and is guarded by a secret you set once in the
        Cloudflare dashboard as the environment variable BLOG_KEY. Without
        that variable the endpoint refuses every write, so an unconfigured
        site cannot be posted to by anyone.

   Posts are kept in KV next to the listings. The site ships with its own
   posts compiled in; these are merged on top of them at runtime, so the blog
   still reads correctly on a deployment where storage was never switched on. */

const BLOG_MAX = 400;

export async function handleBlog(request, env) {
  const { kv, ready } = stores(env);
  const m = request.method;

  if (m === "GET") {
    if (!ready) return json({ ok: true, items: [] }, 200, { "cache-control": "public, max-age=30" });
    let idx = [];
    try { idx = JSON.parse((await kv.get("blogindex")) || "[]"); } catch (e) {}
    const items = [];
    for (const slug of idx.slice(0, BLOG_MAX)) {
      const raw = await kv.get("post:" + slug);
      if (raw) { try { items.push(JSON.parse(raw)); } catch (e) {} }
    }
    return json({ ok: true, items }, 200, { "cache-control": "public, max-age=30" });
  }

  if (m !== "POST") return bad("get-or-post", 405);
  if (!ready) return bad("storage-not-configured", 503);

  const key = env && env.BLOG_KEY;
  if (!key) return bad("blog-key-not-set", 503);
  if (!sameToken(request.headers.get("x-blog-key") || "", key)) return bad("bad-key", 403);

  let post;
  try { post = await request.json(); } catch (e) { return bad("bad-json"); }

  const slug = String(post.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80);
  if (slug.length < 4) return bad("bad-slug");

  const two = v => Array.isArray(v) ? [clean(v[0], 4000), clean(v[1] || v[0], 4000)] : null;
  const rec = {
    slug,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(post.date || "")) ? post.date
        : new Date().toISOString().slice(0, 10),
    cat:  post.cat === "travel" ? "travel" : "property",
    hero: clean(post.hero, 40),
    kw:   clean(post.kw, 120),
    title: two(post.title), dek: two(post.dek), cap: two(post.cap),
    tags: Array.isArray(post.tags) ? post.tags.slice(0, 12).map(x => clean(x, 40)) : [],
    body: Array.isArray(post.body)
      ? post.body.slice(0, 12).map(b => ({ h: two(b.h), p: two(b.p) })).filter(b => b.h && b.p)
      : []
  };
  if (!rec.title || !rec.dek || !rec.cap || !rec.body.length) return bad("missing-fields");

  await kv.put("post:" + slug, JSON.stringify(rec));
  let idx = [];
  try { idx = JSON.parse((await kv.get("blogindex")) || "[]"); } catch (e) {}
  idx = [slug].concat(idx.filter(x => x !== slug)).slice(0, BLOG_MAX);
  await kv.put("blogindex", JSON.stringify(idx));

  const origin = new URL(request.url).origin;
  return json({ ok: true, slug, url: origin + "/blog/" + slug + "/", count: idx.length });
}

/* ==================== GET /api/feed ==================== */

export async function handleFeed(request, env) {
  const { kv, ready } = stores(env);
  if (!ready) return json({ ok: false, error: "storage-not-configured", items: [], v: 0 }, 503);

  const idx = await readIndex(kv);
  const asked = new URL(request.url).searchParams.get("v");
  if (asked && String(idx.v) === asked)
    return json({ ok: true, v: idx.v, same: true },
                200, { "cache-control": "public, max-age=10" });

  const items = [];
  for (const id of idx.ids.slice(0, 200)) {
    const raw = await kv.get("live:" + id);
    if (!raw) continue;
    const r = JSON.parse(raw);
    delete r.token;                       /* the approval secret never leaves KV */
    delete r.owner;                       /* whose account posted it is nobody's business */
    /* The seller's telephone number is not in the public feed. The card says
       there is one; /api/account/phone hands it over to someone signed in.
       Scraping the board for numbers therefore costs an account, and a number
       can be withdrawn by withdrawing the listing. */
    r.hasPhone = !!(r.phone && String(r.phone).replace(/\D/g, "").length >= 7);
    delete r.phone;
    items.push(r);
  }
  return json({ ok: true, v: idx.v, items },
              200, { "cache-control": "public, max-age=10" });
}

/* ==================== GET /review/<id>?t=<token> ==================== */

const page = (title, body, status = 200) => new Response(
'<!doctype html><html lang="en"><head><meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
'<meta name="robots" content="noindex,nofollow">\n' +
'<title>' + esc(title) + ' · Patroni</title>\n' +
`<style>
:root{--bg:#F1F3F6;--panel:#fff;--ink:#16232E;--ink2:#43535F;--ink3:#77858F;
      --line:#E1E6EB;--yl:#FFE500;--blue:#0A5FB4;--red:#B4321E;--good:#1E7A4B}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
     font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Manrope,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:20px 16px 64px}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:.02em;margin-bottom:18px}
.brand i{width:26px;height:26px;background:var(--blue);border-radius:6px;display:block}
h1{font-size:24px;line-height:1.2;margin:0 0 4px}
.sub{color:var(--ink3);font-size:14px;margin:0 0 18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
.role{display:inline-block;background:var(--yl);color:var(--ink);font-weight:700;
      font-size:12.5px;padding:5px 11px;border-radius:999px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:15px}
th{text-align:start;color:var(--ink3);font-weight:600;width:38%;padding:7px 0;vertical-align:top}
td{padding:7px 0;word-break:break-word}
.desc{white-space:pre-wrap;font-size:15px;color:var(--ink2)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.shots img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:9px;display:block;background:var(--line)}
video{width:100%;border-radius:11px;margin-top:10px;background:#000}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
button{font:inherit;font-weight:700;border-radius:999px;padding:14px 24px;border:1px solid transparent;cursor:pointer}
.ok{background:var(--yl);color:var(--ink);flex:1;min-width:180px}
.no{background:transparent;border-color:var(--red);color:var(--red);flex:1;min-width:150px}
button[disabled]{opacity:.5;cursor:default}
.msg{margin-top:14px;padding:13px 15px;border-radius:11px;font-weight:600;display:none}
.msg.on{display:block}
.msg.good{background:#E8F5EE;color:var(--good)}
.msg.err{background:#FBECE9;color:var(--red)}
.note{color:var(--ink3);font-size:13.5px;margin-top:14px}
a{color:var(--blue)}
</style></head><body><div class="wrap">
<div class="brand"><i></i>Patroni</div>
` + body + '\n</div></body></html>',
  { status, headers: { "content-type": "text/html; charset=utf-8",
                       "cache-control": "no-store",
                       "x-robots-tag": "noindex, nofollow" } });

const ROLE = { owner: "Owner", developer: "Developer",
               agency: "Real-estate agency", other: "Other" };

export async function handleReview(request, env, id) {
  const { kv, ready } = stores(env);
  if (!ready) return page("Not configured",
    '<h1>Storage is not switched on yet</h1>' +
    '<p class="sub">This link needs the KV namespace and the R2 bucket bound to the Pages ' +
    'project. Until then listings still arrive as messages.</p>', 503);

  const token = new URL(request.url).searchParams.get("t") || "";
  const raw = (await kv.get("pending:" + id)) || (await kv.get("live:" + id));
  if (!raw) return page("Not found",
    '<h1>Nothing here</h1><p class="sub">This listing was rejected, or the link is wrong.</p>', 404);

  const r = JSON.parse(raw);
  if (!sameToken(r.token, token)) return page("Not found",
    '<h1>Nothing here</h1><p class="sub">This link is not valid.</p>', 403);

  const photos = (r.media || []).filter(m => m.kind === "photo");
  const video = (r.media || []).find(m => m.kind === "video");
  const role = r.who === "other" ? (r.whoTxt || "Other") : (ROLE[r.who] || "Owner");
  const live = r.status === "live";

  const rows = [
    ["Category", r.cat === "tour" ? "Tour" : "Property"],
    ["City", r.city],
    ["Price", r.price ? "$" + r.price.toLocaleString("en-US") : "Ask for a price"],
    ["Area", r.area ? r.area + " m²" : "—"],
    ["Rooms", r.rooms || "—"],
    ["Photos", String(photos.length)],
    ["Video", video ? "yes" : "no"],
    ["Posted by", r.name],
    ["Phone", r.phone],
    ["Sent", new Date(r.at).toISOString().replace("T", " ").slice(0, 16) + " UTC"]
  ];

  const gallery = photos.length
    ? '<div class="card"><div class="shots">'
      + photos.map(p => '<img src="' + esc(p.url) + '" alt="" loading="lazy">').join("")
      + '</div>'
      + (video ? '<video controls preload="metadata" src="' + esc(video.url) + '"></video>' : "")
      + '</div>'
    : video
      ? '<div class="card"><video controls preload="metadata" src="' + esc(video.url) + '"></video></div>'
      : '<div class="card"><p class="sub" style="margin:0">No photos were attached.</p></div>';

  return page("Review listing",
    '<h1>' + esc(r.title) + '</h1>' +
    '<p class="sub">' + (live ? "Already approved and on the site."
                              : "Waiting for your decision.") + '</p>' +
    '<div class="card"><span class="role">' + esc(role) + '</span>' +
    '<table><tbody>' + rows.map(kvp =>
      '<tr><th>' + esc(kvp[0]) + '</th><td>' + esc(kvp[1]) + '</td></tr>').join("") +
    '</tbody></table></div>' +
    (r.desc ? '<div class="card"><div class="desc">' + esc(r.desc) + '</div></div>' : "") +
    gallery +
    '<div class="card"><div class="row">' +
    '<button class="ok" id="ok"' + (live ? " disabled" : "") + '>' +
      (live ? "Already live" : "Approve and publish") + '</button>' +
    '<button class="no" id="no">' + (live ? "Take it down" : "Reject") + '</button>' +
    '</div><div class="msg" id="msg"></div>' +
    '<p class="note">Approving puts it on the public board within about a minute. ' +
    'Rejecting deletes the listing and every file with it, permanently.</p></div>' +
    '<script>\n' +
    'var ID=' + JSON.stringify(id) + ', TK=' + JSON.stringify(token) + ';\n' +
    'var NEEDKEY=' + JSON.stringify(!!(env && env.ADMIN_KEY)) + ';\n' +
    /* The admin key is typed once on this device and kept here, never in the
       link — because the link passes through the seller's own phone. */
    'function adminKey(ask){ var k=null;\n' +
    ' try{ k=localStorage.getItem("pt_admin"); }catch(e){}\n' +
    ' if(!k && ask){ k=prompt("Admin key (set once, remembered on this device)");\n' +
    '   if(k){ try{ localStorage.setItem("pt_admin",k); }catch(e){} } }\n' +
    ' return k||""; }\n' +
    'function headers(){ var h={"content-type":"application/json"};\n' +
    ' if(NEEDKEY){ var k=adminKey(true); if(k) h["x-admin-key"]=k; }\n' +
    ' return h; }\n' +
    'var msg=document.getElementById("msg");\n' +
    'function say(text,good){ msg.textContent=text; msg.className="msg on "+(good?"good":"err"); }\n' +
    'function enable(on){ document.getElementById("ok").disabled=!on;' +
    ' document.getElementById("no").disabled=!on; }\n' +
    'function go(action){ enable(false); say("Working\\u2026",true);\n' +
    ' fetch("/api/decide",{method:"POST",headers:headers(),' +
    ' body:JSON.stringify({id:ID,token:TK,action:action})})\n' +
    '  .then(function(r){return r.json()})\n' +
    '  .then(function(d){ if(d&&d.ok){ say(action==="approve"?' +
    '"Approved. It is on the site now.":"Rejected and deleted.",true); }\n' +
    '    else { if(d&&d.error==="admin-key-required"){ try{localStorage.removeItem("pt_admin");}catch(e){} \n' +
    '        say("That admin key was wrong. Press Approve again to retype it.",false); }\n' +
    '      else say("Did not work: "+((d&&d.error)||"unknown"),false); enable(true); } })\n' +
    '  .catch(function(){ say("No connection. Try again.",false); enable(true); });\n' +
    '}\n' +
    'document.getElementById("ok").onclick=function(){ go("approve") };\n' +
    'document.getElementById("no").onclick=function(){\n' +
    ' if(confirm("Reject and delete this listing and its files?")) go("reject"); };\n' +
    '<\/script>');
}

/* ==================== GET /media/<id>/<file> ==================== */

export async function handleMedia(request, env, key) {
  const { r2, ready } = stores(env);
  if (!ready) return new Response("storage not configured", { status: 503 });
  if (!key || key.includes("..")) return new Response("bad path", { status: 400 });

  const range = request.headers.get("range");
  const obj = await r2.get(key, range ? { range: request.headers } : undefined);
  if (!obj) return new Response("not found", { status: 404 });

  const h = new Headers();
  if (obj.writeHttpMetadata) obj.writeHttpMetadata(h);
  h.set("cache-control", "public, max-age=31536000, immutable");
  h.set("accept-ranges", "bytes");
  h.set("etag", obj.httpEtag || "");
  if (obj.range && obj.size != null) {
    const start = obj.range.offset || 0;
    const len = obj.range.length != null ? obj.range.length : obj.size - start;
    h.set("content-range", "bytes " + start + "-" + (start + len - 1) + "/" + obj.size);
    return new Response(obj.body, { status: 206, headers: h });
  }
  return new Response(obj.body, { headers: h });
}

/* ==================== accounts ====================

   Free accounts, email and password, no third party and nothing to pay for.

   What an account is for:
     - posting a listing, and editing or withdrawing it afterwards from any
       device rather than only the browser that posted it;
     - seeing the telephone number on someone else's listing.

   What it deliberately is NOT: the email is stored UNVERIFIED. There is no
   mail server here yet, so nobody is emailed a code and nobody is locked out
   waiting for one. The record carries verified:false and the profile says so
   out loud. Every listing is still read by a human before it goes live, which
   is what actually keeps rubbish off the board — a verified email would not.
   When an email sender is configured, verification slots in on top of this
   without anyone having to sign up again.

   Passwords are never stored. PBKDF2-SHA256, 150,000 iterations, a fresh
   16-byte salt each — the same shape of thing a bank would use, done with the
   crypto that is already in the runtime.

   KV layout:
     user:<email>    the account. Holds the salt and hash, never the password.
     sess:<token>    a signed-in device. Expires on its own after 60 days.
     lock:<email>    failed sign-in attempts, so a password cannot be guessed
                     a million times.                                        */

const SESSION_DAYS = 60;
const PW_ITER = 150000;
const MAX_TRIES = 8;               /* failed sign-ins before a 15-minute wait */
const LOCK_SECONDS = 15 * 60;
const MAX_SESSIONS = 12;           /* devices remembered per account */

const b64 = buf => {
  const a = new Uint8Array(buf);
  let s = "";
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s);
};

/* One spelling of an address, so Ali@Gmail.com and ali@gmail.com are one
   person and not two. Deliberately permissive about what an address may look
   like — refusing an unusual but real address is worse than accepting an
   unusable one nobody is emailing anyway. */
function emailKey(raw) {
  const e = String(raw || "").trim().toLowerCase();
  if (e.length < 6 || e.length > 160) return null;
  if (!/^[^\s@,;:<>"'\\]+@[^\s@.,;:<>"'\\]+(\.[^\s@.,;:<>"'\\]+)+$/.test(e)) return null;
  return e;
}

async function pwHash(password, saltB64, iter) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)),
      iterations: iter, hash: "SHA-256" }, key, 256);
  return b64(bits);
}

/* the part of an account that may be sent to the browser */
const publicUser = u => ({
  email: u.email, name: u.name, phone: u.phone,
  verified: !!u.verified, at: u.at, listings: (u.ids || []).length
});

async function readUser(kv, email) {
  try {
    const raw = await kv.get("user:" + email);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function startSession(kv, user) {
  const token = newToken() + newToken();                  /* 32 bytes of hex */
  await kv.put("sess:" + token, user.email,
               { expirationTtl: 60 * 60 * 24 * SESSION_DAYS });
  user.sess = [token, ...(user.sess || [])].slice(0, MAX_SESSIONS);
  await kv.put("user:" + user.email, JSON.stringify(user));
  return token;
}

function bearer(request, body) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (m) return m[1];
  if (body && body.auth) return String(body.auth);
  const q = new URL(request.url).searchParams.get("auth");
  return q ? String(q) : "";
}

/* who is asking? null when nobody is signed in — never an error, because
   most endpoints work perfectly well for a stranger. */
async function whoami(kv, request, body) {
  const token = bearer(request, body);
  if (!token) return null;
  const email = await kv.get("sess:" + token);
  if (!email) return null;
  const user = await readUser(kv, email);
  return user ? { user, token } : null;
}

export async function handleAccount(request, env, action) {
  const { kv, r2, ready } = stores(env);
  if (!ready) return bad("storage-not-configured", 503);

  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch (e) { return bad("bad-json"); }
  }

  /* ---------- who am I, and what have I posted ---------- */
  if (action === "me") {
    const me = await whoami(kv, request, body);
    if (!me) return bad("not-signed-in", 401);
    const mine = [];
    for (const id of (me.user.ids || []).slice(0, 200)) {
      const raw = await kv.get("live:" + id) || await kv.get("pending:" + id);
      if (!raw) continue;
      const r = JSON.parse(raw);
      mine.push(r);                    /* own listings come back complete,
                                          token included: it is theirs */
    }
    return json({ ok: true, user: publicUser(me.user), listings: mine });
  }

  /* ---------- sign up ---------- */
  if (action === "signup") {
    const email = emailKey(body.email);
    if (!email) return bad("bad-email");
    const password = String(body.password || "");
    if (password.length < 8) return bad("password-too-short");
    if (password.length > 200) return bad("password-too-long");
    const name = clean(body.name, 80);
    if (name.length < 2) return bad("name-too-short");
    const phone = clean(body.phone, 40);
    if (phone && phone.replace(/\D/g, "").length < 7) return bad("bad-phone");

    if (await readUser(kv, email)) return bad("email-taken", 409);

    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const user = {
      email, name, phone,
      salt, hash: await pwHash(password, salt, PW_ITER), iter: PW_ITER,
      verified: false, at: Date.now(), ids: [], sess: []
    };
    const token = await startSession(kv, user);
    return json({ ok: true, auth: token, user: publicUser(user) });
  }

  /* ---------- sign in ---------- */
  if (action === "login") {
    const email = emailKey(body.email);
    if (!email) return bad("bad-credentials", 401);

    const tries = +(await kv.get("lock:" + email) || 0);
    if (tries >= MAX_TRIES) return bad("too-many-tries", 429);

    const user = await readUser(kv, email);
    /* Run the hash even when there is no such account, so the time taken
       does not reveal which addresses are registered. */
    const salt = user ? user.salt : b64(new Uint8Array(16));
    const got = await pwHash(String(body.password || ""), salt,
                             (user && user.iter) || PW_ITER);
    if (!user || !sameToken(got, user.hash)) {
      await kv.put("lock:" + email, String(tries + 1),
                   { expirationTtl: LOCK_SECONDS });
      return bad("bad-credentials", 401);
    }
    await kv.delete("lock:" + email);
    const token = await startSession(kv, user);
    return json({ ok: true, auth: token, user: publicUser(user) });
  }

  /* ---------- sign out ---------- */
  if (action === "logout") {
    const me = await whoami(kv, request, body);
    if (me) {
      await kv.delete("sess:" + me.token);
      me.user.sess = (me.user.sess || []).filter(t => t !== me.token);
      await kv.put("user:" + me.user.email, JSON.stringify(me.user));
    }
    return json({ ok: true });          /* signing out always "works" */
  }

  /* ---------- edit the profile ---------- */
  if (action === "update") {
    const me = await whoami(kv, request, body);
    if (!me) return bad("not-signed-in", 401);
    const u = me.user;
    if (body.name !== undefined) {
      const n = clean(body.name, 80);
      if (n.length < 2) return bad("name-too-short");
      u.name = n;
    }
    if (body.phone !== undefined) {
      const p = clean(body.phone, 40);
      if (p && p.replace(/\D/g, "").length < 7) return bad("bad-phone");
      u.phone = p;
    }
    if (body.password) {
      const cur = await pwHash(String(body.current || ""), u.salt, u.iter);
      if (!sameToken(cur, u.hash)) return bad("bad-current-password", 403);
      const np = String(body.password);
      if (np.length < 8) return bad("password-too-short");
      u.salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      u.iter = PW_ITER;
      u.hash = await pwHash(np, u.salt, u.iter);
      /* a password change signs every other device out */
      for (const t of (u.sess || [])) if (t !== me.token) await kv.delete("sess:" + t);
      u.sess = [me.token];
    }
    await kv.put("user:" + u.email, JSON.stringify(u));
    return json({ ok: true, user: publicUser(u) });
  }

  /* ---------- the telephone number on someone else's listing ----------

     This is the gate. The feed never carries a seller's number; it says only
     that there is one. Signing in is what opens it, on the website and in the
     app alike. */
  if (action === "phone") {
    const me = await whoami(kv, request, body);
    if (!me) return bad("sign-in-to-see-number", 401);
    const id = String(body.id || "").replace(/^lv-/, "");
    if (!id) return bad("missing-fields");
    const raw = await kv.get("live:" + id);
    if (!raw) return bad("not-found", 404);
    const r = JSON.parse(raw);
    return json({ ok: true, id, phone: r.phone, name: r.name });
  }

  /* ---------- delete the account ----------

     Google Play requires that an app offering accounts lets a person delete
     theirs from inside the app, and from a web page. This is that endpoint,
     and both the app and the website call it.

     It takes the password again on purpose: an unlocked phone left on a table
     should not be one tap away from erasing somebody's listings. Everything
     goes — the profile, the password hash, every listing they posted and
     every photograph that came with it. Nothing is kept and nothing can be
     restored afterwards, which is what "delete" ought to mean. */
  if (action === "delete") {
    const me = await whoami(kv, request, body);
    if (!me) return bad("not-signed-in", 401);
    const u = me.user;
    const cur = await pwHash(String(body.password || ""), u.salt, u.iter);
    if (!sameToken(cur, u.hash)) return bad("bad-current-password", 403);

    let removed = 0;
    const gone = new Set();
    for (const id of (u.ids || [])) {
      for (const pre of ["pending:", "live:"]) {
        const raw = await kv.get(pre + id);
        if (!raw) continue;
        const r = JSON.parse(raw);
        for (const m of r.media || []) {
          try { await r2.delete(m.url.slice(7)); } catch (e) { /* already gone */ }
        }
        await kv.delete(pre + id);
        gone.add(id);
      }
      removed++;
    }
    if (gone.size) {
      const idx = await readIndex(kv);
      await writeIndex(kv, idx.ids.filter(x => !gone.has(x)));
    }
    for (const t of (u.sess || [])) await kv.delete("sess:" + t);
    await kv.delete("sess:" + me.token);
    await kv.delete("user:" + u.email);
    await kv.delete("lock:" + u.email);
    return json({ ok: true, deleted: true, listings: removed });
  }

  return bad("unknown-action", 404);
}

/* ==================== the router ==================== */

/* The four files a crawler looks for before it looks at anything else.

   Each one is written into the folder by the build AND baked into this worker
   as a copy, because the failure that actually happened here was a partial
   upload: index.html landed, the rest did not, and every crawler that came
   asking for /robots.txt got a 404. A 404 on robots.txt is not "blocked" — it
   just tells the crawler nothing. With this, the folder copy is served when it
   is present and the baked copy answers when it is not, so these four never
   404 as long as the worker itself is deployed.

   Filled in by build.py after prerender.py, from the real generated files. */
const FALLBACK = {"/robots.txt": {"type": "text/plain; charset=utf-8", "body": "# robots.txt for patronigeorgia.com — RFC 9309\n# Patroni Georgia — real estate, tours and experiences in Georgia.\n#\n# Everything public is open to every crawler, including AI crawlers.\n# Only two paths are closed, and neither holds content worth indexing:\n#   /api/     machine endpoints (JSON), no pages\n#   /review/  the private approval screen for new listings\n#\n# A named group replaces the wildcard group for that crawler, so the two\n# Disallow lines are repeated in every group on purpose. Do not delete them.\n\nUser-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\n# ---------- search engines ----------\n\nUser-agent: Googlebot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Googlebot-Image\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Googlebot-News\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Bingbot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Slurp\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: DuckDuckBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: YandexBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Baiduspider\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Applebot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: facebookexternalhit\nAllow: /\n\nUser-agent: Twitterbot\nAllow: /\n\nUser-agent: LinkedInBot\nAllow: /\n\nUser-agent: WhatsApp\nAllow: /\n\nUser-agent: TelegramBot\nAllow: /\n\nUser-agent: Pinterestbot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\n# ---------- AI crawlers and assistants ----------\n# These are allowed deliberately. Patroni Georgia wants to be quotable:\n# when someone asks an assistant what an apartment in Batumi costs or what\n# the residency threshold is, the honest numbers should come from here.\n\nUser-agent: GPTBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: OAI-SearchBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: ChatGPT-User\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: ClaudeBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Claude-Web\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Claude-SearchBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Claude-User\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: anthropic-ai\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: PerplexityBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Perplexity-User\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Google-Extended\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Applebot-Extended\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: meta-externalagent\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: meta-externalfetcher\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Amazonbot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Bytespider\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: CCBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: cohere-ai\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: cohere-training-data-crawler\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: MistralAI-User\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: DuckAssistBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: YouBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Diffbot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: ImagesiftBot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Timpibot\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: omgili\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nUser-agent: Webzio-Extended\nAllow: /\nDisallow: /api/\nDisallow: /review/\n\nSitemap: https://patronigeorgia.com/sitemap.xml\n"}, "/sitemap.xml": {"type": "application/xml; charset=utf-8", "body": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"\n        xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">\n  <url><loc>https://patronigeorgia.com/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>1.0</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/account-deletion/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/account-deletion/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/account-deletion/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/account-deletion/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/account-deletion/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/account-deletion/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/account-deletion/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/account-deletion/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/blog/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/blog/apartments-for-sale-in-batumi-what-they-cost/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/blog/best-day-trips-from-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/best-day-trips-from-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/blog/can-foreigners-buy-property-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/can-foreigners-buy-property-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/blog/georgia-residence-permit-150000-what-changed/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/georgia-residence-permit-150000-what-changed/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/georgia-residence-permit-150000-what-changed/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/georgia-residence-permit-150000-what-changed/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/blog/georgia-visa-free-one-year/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/georgia-visa-free-one-year/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/georgia-visa-free-one-year/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/georgia-visa-free-one-year/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/blog/tbilisi-vs-batumi-which-to-buy/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/batumi-travel-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/batumi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/batumi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/batumi-travel-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/best-areas-to-buy-property-in-batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-areas-to-buy-property-in-batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/best-areas-to-buy-property-in-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/best-day-trips-from-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-day-trips-from-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/best-places-to-visit-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-places-to-visit-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-places-to-visit-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-places-to-visit-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/can-foreigners-buy-property-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/can-foreigners-buy-property-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/cost-of-apartments-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/cost-of-apartments-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/cost-of-apartments-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/cost-of-apartments-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/georgia-residence-permit-through-property/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/georgia-residence-permit-through-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/georgia-residence-permit-through-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/georgia-residence-permit-through-property/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/georgia-travel-guide-first-time/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/georgia-travel-guide-first-time/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/georgia-travel-guide-first-time/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/georgia-travel-guide-first-time/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/how-to-buy-an-apartment-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/how-to-buy-an-apartment-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/how-to-buy-an-apartment-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/how-to-buy-an-apartment-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/is-georgia-good-for-real-estate-investment/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/is-georgia-good-for-real-estate-investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/is-georgia-good-for-real-estate-investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/is-georgia-good-for-real-estate-investment/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/kakheti-wine-region-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/kakheti-wine-region-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/kakheti-wine-region-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/kakheti-wine-region-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/kazbegi-travel-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/kazbegi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/kazbegi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/kazbegi-travel-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/guides/tbilisi-vs-batumi-real-estate/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/tbilisi-vs-batumi-real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/tbilisi-vs-batumi-real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/tbilisi-vs-batumi-real-estate/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/privacy/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/privacy/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/address/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/address/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/address/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/address/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/collection/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/collection/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/collection/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/collection/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/downtown/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/downtown/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/downtown/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/downtown/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/gardens/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/gardens/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/gardens/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/gardens/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/magnolia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/magnolia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/magnolia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/magnolia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/nextapartments/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/nextapartments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/nextapartments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/nextapartments/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/nextgreen/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/nextgreen/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/nextgreen/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/nextgreen/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/nextwhite/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/nextwhite/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/nextwhite/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/nextwhite/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/radisson/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/radisson/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/radisson/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/radisson/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/villapark/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/villapark/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/villapark/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/villapark/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/batumi/wyndham/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/wyndham/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/wyndham/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/wyndham/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/investment/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/investment/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/kobuleti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/kobuleti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/kobuleti/kobuleti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/kobuleti/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/kobuleti/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/kobuleti/kobuleti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/new-developments/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/new-developments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/new-developments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/new-developments/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/tbilisi/cinema/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/cinema/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/cinema/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/cinema/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/tbilisi/oriental/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/oriental/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/oriental/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/oriental/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/real-estate/tbilisi/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/borjomi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/borjomi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/borjomi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/borjomi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/gonio/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/gonio/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/gonio/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/gonio/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/kakheti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/kakheti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/kakheti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/kakheti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/kazbegi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/kazbegi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/kazbegi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/kazbegi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/kutaisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/kutaisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/kutaisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/kutaisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/mtskheta/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/mtskheta/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/mtskheta/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/mtskheta/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/svaneti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/svaneti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/svaneti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/svaneti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ar/tours/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/blog/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/blog/apartments-for-sale-in-batumi-what-they-cost/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/blog/best-day-trips-from-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/best-day-trips-from-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/blog/can-foreigners-buy-property-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/can-foreigners-buy-property-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/blog/georgia-residence-permit-150000-what-changed/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/georgia-residence-permit-150000-what-changed/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/georgia-residence-permit-150000-what-changed/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/georgia-residence-permit-150000-what-changed/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/blog/georgia-visa-free-one-year/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/georgia-visa-free-one-year/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/georgia-visa-free-one-year/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/georgia-visa-free-one-year/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/blog/tbilisi-vs-batumi-which-to-buy/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/batumi-travel-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/batumi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/batumi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/batumi-travel-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/best-areas-to-buy-property-in-batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-areas-to-buy-property-in-batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/best-areas-to-buy-property-in-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/best-day-trips-from-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-day-trips-from-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/best-places-to-visit-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/best-places-to-visit-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/best-places-to-visit-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/best-places-to-visit-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/can-foreigners-buy-property-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/can-foreigners-buy-property-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/cost-of-apartments-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/cost-of-apartments-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/cost-of-apartments-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/cost-of-apartments-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/georgia-residence-permit-through-property/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/georgia-residence-permit-through-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/georgia-residence-permit-through-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/georgia-residence-permit-through-property/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/georgia-travel-guide-first-time/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/georgia-travel-guide-first-time/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/georgia-travel-guide-first-time/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/georgia-travel-guide-first-time/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/how-to-buy-an-apartment-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/how-to-buy-an-apartment-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/how-to-buy-an-apartment-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/how-to-buy-an-apartment-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/is-georgia-good-for-real-estate-investment/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/is-georgia-good-for-real-estate-investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/is-georgia-good-for-real-estate-investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/is-georgia-good-for-real-estate-investment/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/kakheti-wine-region-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/kakheti-wine-region-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/kakheti-wine-region-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/kakheti-wine-region-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/kazbegi-travel-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/kazbegi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/kazbegi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/kazbegi-travel-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/guides/tbilisi-vs-batumi-real-estate/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/guides/tbilisi-vs-batumi-real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/guides/tbilisi-vs-batumi-real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/guides/tbilisi-vs-batumi-real-estate/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/account-deletion/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/account-deletion/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/account-deletion/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/account-deletion/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/blog/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/blog/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/blog/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/blog/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/blog/apartments-for-sale-in-batumi-what-they-cost/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/blog/apartments-for-sale-in-batumi-what-they-cost/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/blog/best-day-trips-from-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/blog/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/blog/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/blog/best-day-trips-from-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/blog/can-foreigners-buy-property-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/blog/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/blog/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/blog/can-foreigners-buy-property-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/blog/georgia-residence-permit-150000-what-changed/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/blog/georgia-residence-permit-150000-what-changed/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/blog/georgia-residence-permit-150000-what-changed/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/blog/georgia-residence-permit-150000-what-changed/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/blog/georgia-visa-free-one-year/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/blog/georgia-visa-free-one-year/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/blog/georgia-visa-free-one-year/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/blog/georgia-visa-free-one-year/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/blog/tbilisi-vs-batumi-which-to-buy/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/blog/tbilisi-vs-batumi-which-to-buy/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/batumi-travel-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/batumi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/batumi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/batumi-travel-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/best-areas-to-buy-property-in-batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/best-areas-to-buy-property-in-batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/best-areas-to-buy-property-in-batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/best-areas-to-buy-property-in-batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/best-areas-to-buy-property-in-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/best-areas-to-buy-property-in-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/best-day-trips-from-tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/best-day-trips-from-tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/best-day-trips-from-tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/best-places-to-visit-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/best-places-to-visit-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/best-places-to-visit-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/best-places-to-visit-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/can-foreigners-buy-property-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/can-foreigners-buy-property-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/can-foreigners-buy-property-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/cost-of-apartments-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/cost-of-apartments-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/cost-of-apartments-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/cost-of-apartments-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/georgia-residence-permit-through-property/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/georgia-residence-permit-through-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/georgia-residence-permit-through-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/georgia-residence-permit-through-property/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/georgia-travel-guide-first-time/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/georgia-travel-guide-first-time/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/georgia-travel-guide-first-time/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/georgia-travel-guide-first-time/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/how-to-buy-an-apartment-in-georgia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/how-to-buy-an-apartment-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/how-to-buy-an-apartment-in-georgia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/how-to-buy-an-apartment-in-georgia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/is-georgia-good-for-real-estate-investment/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/is-georgia-good-for-real-estate-investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/is-georgia-good-for-real-estate-investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/is-georgia-good-for-real-estate-investment/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/kakheti-wine-region-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/kakheti-wine-region-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/kakheti-wine-region-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/kakheti-wine-region-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/kazbegi-travel-guide/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/kazbegi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/kazbegi-travel-guide/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/kazbegi-travel-guide/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/guides/tbilisi-vs-batumi-real-estate/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/guides/tbilisi-vs-batumi-real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/guides/tbilisi-vs-batumi-real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/guides/tbilisi-vs-batumi-real-estate/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/list-your-property/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/list-your-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/list-your-property/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/list-your-property/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/privacy/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/privacy/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/privacy/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/privacy/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/address/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/address/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/address/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/address/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/collection/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/collection/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/collection/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/collection/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/downtown/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/downtown/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/downtown/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/downtown/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/gardens/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/gardens/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/gardens/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/gardens/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/magnolia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/magnolia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/magnolia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/magnolia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/nextapartments/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/nextapartments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/nextapartments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/nextapartments/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/nextgreen/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/nextgreen/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/nextgreen/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/nextgreen/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/nextwhite/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/nextwhite/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/nextwhite/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/nextwhite/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/radisson/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/radisson/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/radisson/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/radisson/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/villapark/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/villapark/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/villapark/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/villapark/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/batumi/wyndham/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/wyndham/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/batumi/wyndham/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/batumi/wyndham/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/investment/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/investment/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/kobuleti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/kobuleti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/kobuleti/kobuleti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/kobuleti/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/kobuleti/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/kobuleti/kobuleti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/new-developments/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/new-developments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/new-developments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/new-developments/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/tbilisi/cinema/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/cinema/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/tbilisi/cinema/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/cinema/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/tbilisi/oriental/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/oriental/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/tbilisi/oriental/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/oriental/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/real-estate/tbilisi/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/real-estate/tbilisi/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/real-estate/tbilisi/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/borjomi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/borjomi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/borjomi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/borjomi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/gonio/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/gonio/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/gonio/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/gonio/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/kakheti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/kakheti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/kakheti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/kakheti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/kazbegi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/kazbegi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/kazbegi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/kazbegi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/kutaisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/kutaisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/kutaisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/kutaisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/mtskheta/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/mtskheta/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/mtskheta/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/mtskheta/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/svaneti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/svaneti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/svaneti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/svaneti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/ka/tours/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/ka/tours/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/ka/tours/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/ka/tours/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/privacy/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/privacy/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/privacy/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/address/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/address/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/address/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/address/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/collection/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/collection/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/collection/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/collection/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/downtown/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/downtown/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/downtown/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/downtown/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/gardens/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/gardens/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/gardens/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/gardens/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/magnolia/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/magnolia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/magnolia/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/magnolia/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/nextapartments/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/nextapartments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/nextapartments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/nextapartments/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/nextgreen/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/nextgreen/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/nextgreen/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/nextgreen/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/nextwhite/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/nextwhite/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/nextwhite/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/nextwhite/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/radisson/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/radisson/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/radisson/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/radisson/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/villapark/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/villapark/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/villapark/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/villapark/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/batumi/wyndham/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/batumi/wyndham/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/batumi/wyndham/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/batumi/wyndham/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/investment/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/investment/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/investment/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/kobuleti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/kobuleti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/kobuleti/kobuleti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/kobuleti/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/kobuleti/kobuleti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/kobuleti/kobuleti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/new-developments/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/new-developments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/new-developments/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/new-developments/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/tbilisi/cinema/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/cinema/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/cinema/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/cinema/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/tbilisi/oriental/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/oriental/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/oriental/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/oriental/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/real-estate/tbilisi/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/real-estate/tbilisi/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/real-estate/tbilisi/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/real-estate/tbilisi/tbilisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/batumi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/batumi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/batumi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/borjomi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/borjomi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/borjomi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/borjomi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/gonio/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/gonio/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/gonio/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/gonio/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/kakheti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/kakheti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/kakheti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/kakheti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/kazbegi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/kazbegi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/kazbegi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/kazbegi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/kutaisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/kutaisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/kutaisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/kutaisi/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/mtskheta/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/mtskheta/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/mtskheta/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/mtskheta/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/svaneti/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/svaneti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/svaneti/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/svaneti/\"/>\n  </url>\n  <url><loc>https://patronigeorgia.com/tours/tbilisi/</loc><lastmod>2026-09-15</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>\n    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://patronigeorgia.com/tours/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"ar\" href=\"https://patronigeorgia.com/ar/tours/tbilisi/\"/>\n    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://patronigeorgia.com/tours/tbilisi/\"/>\n  </url>\n</urlset>\n"}, "/llms.txt": {"type": "text/plain; charset=utf-8", "body": "# Patroni Georgia\n\n> Real estate, tours and experiences in Georgia (the country). We sell and rent apartments in Batumi, Tbilisi, Kobuleti, Gonio and Kvariati, and we run private tours from those cities. Prices, fees and residency rules on this site are the real ones, with the date they were checked.\n\nChecked and rebuilt: 2026-09-15. Languages: English at the root, Arabic under /ar/. Every page has an hreflang pair.\n\nContact: WhatsApp +90 541 654 2996 · https://wa.me/905416542996\n\n## Start here\n\n- [Patroni Georgia](https://patronigeorgia.com/): Property, tours and experiences in Georgia in one place.\n- [Real estate in Georgia](https://patronigeorgia.com/real-estate/): Every project and listing we have, by city, with asking prices.\n- [Tours and experiences](https://patronigeorgia.com/tours/): Private tours built city by city rather than sold as fixed packages.\n- [Guides](https://patronigeorgia.com/guides/): Long-form answers on buying, owning, renting and travelling in Georgia.\n- [Blog](https://patronigeorgia.com/blog/): Shorter pieces on the Georgian property and travel market.\n\n## Cities with inventory\n\n- [Property in Batumi](https://patronigeorgia.com/real-estate/batumi/): Projects and listings in Batumi, with prices and sizes.\n- [Property in Tbilisi](https://patronigeorgia.com/real-estate/tbilisi/): Projects and listings in Tbilisi, with prices and sizes.\n- [Property in Kobuleti](https://patronigeorgia.com/real-estate/kobuleti/): Projects and listings in Kobuleti, with prices and sizes.\n\n- [Investment property in Georgia](https://patronigeorgia.com/real-estate/investment/): Rental yield, purchase costs and the residency threshold, with the numbers written out.\n- [New developments](https://patronigeorgia.com/real-estate/new-developments/): Projects under construction and their handover dates.\n\n## Guides\n\n- [Can Foreigners Buy Property in Georgia?](https://patronigeorgia.com/guides/can-foreigners-buy-property-in-georgia/): Yes — foreigners buy apartments, houses and commercial property in Georgia freehold, with no visa and no residency. The one exception is agricultural land.\n- [How to Buy an Apartment in Georgia](https://patronigeorgia.com/guides/how-to-buy-an-apartment-in-georgia/): The process for a foreign buyer: the registry check, off-plan versus finished, payment, registration, and the five checks that prevent costly mistakes.\n- [Georgia Residence Permit by Property: The $150,000 Rule](https://patronigeorgia.com/guides/georgia-residence-permit-through-property/): Since 1 March 2026 the threshold is $150,000, on a certified valuation and registered ownership. What counts, what does not, and the grandfather clause.\n- [Tbilisi vs Batumi Real Estate](https://patronigeorgia.com/guides/tbilisi-vs-batumi-real-estate/): Two different markets. Batumi is seasonal, foreign-driven and yield-led; Tbilisi is year-round and steadier. Which suits which buyer.\n- [Is Georgia Good for Real Estate Investment?](https://patronigeorgia.com/guides/is-georgia-good-for-real-estate-investment/): 5% rental tax, zero capital gains after two years, 17,478 Batumi sales in 2025, 8–10% growth — and the four risks nobody selling you an apartment mentions.\n- [Best Areas to Buy Property in Batumi](https://patronigeorgia.com/guides/best-areas-to-buy-property-in-batumi/): New Boulevard, Old Batumi, the first and second rows back from the sea, Gonio and Kvariati — what each area is actually like to own in, and who each one suits.\n- [Best Areas to Buy Property in Tbilisi](https://patronigeorgia.com/guides/best-areas-to-buy-property-in-tbilisi/): Vake, Saburtalo, Vera, Sololaki, Old Tbilisi and Didi Dighomi — the character, the tenant, the trade-off and the honest warning for each.\n- [Cost of Apartments in Georgia 2026](https://patronigeorgia.com/guides/cost-of-apartments-in-georgia/): Average $1,395–1,500 per square metre in Tbilisi and Batumi, plus the costs nobody quotes: finishing, furniture, service charges, valuation and legal fees.\n- [Georgia Travel Guide for First-Time Visitors](https://patronigeorgia.com/guides/georgia-travel-guide-first-time/): Visa-free for a full year for 94 nationalities. When to go, what it costs, how to get around, and the mistakes first-time visitors make.\n- [Best Places to Visit in Georgia](https://patronigeorgia.com/guides/best-places-to-visit-in-georgia/): Tbilisi, Kazbegi, Svaneti, Kakheti, Batumi, Mtskheta, Borjomi, Kutaisi and Gonio — what each is for, how long to give it, and when to go.\n- [Best Day Trips from Tbilisi](https://patronigeorgia.com/guides/best-day-trips-from-tbilisi/): Mtskheta, Kakheti, Ananuri, Gudauri and more — honest driving times, what each day actually delivers, and the one trip you should not attempt in a day.\n- [Kakheti Wine Region Guide](https://patronigeorgia.com/guides/kakheti-wine-region-guide/): 8,000 years of qvevri winemaking, Sighnaghi, Bodbe and Telavi — when the harvest is, and how to get into the good small wineries.\n- [Kazbegi Travel Guide: Gergeti Trinity Church](https://patronigeorgia.com/guides/kazbegi-travel-guide/): The Georgian Military Highway, Ananuri, Gudauri and the church at 2,170 m — driving times, how to get up to Gergeti, and why you should stay the night.\n- [Batumi Travel Guide](https://patronigeorgia.com/guides/batumi-travel-guide/): The boulevard, the botanical garden, Ali & Nino, Gonio fortress and the beaches south — plus an honest account of Batumi outside the summer season.\n\n## Recent posts\n\n- [The $150,000 residence permit rule, in one page](https://patronigeorgia.com/blog/georgia-residence-permit-150000-what-changed/): Since 1 March 2026 a Georgian residence permit through property needs $150,000, judged on a certified valuation and on registered ownership. Here is what that…\n- [What apartments in Batumi actually cost](https://patronigeorgia.com/blog/apartments-for-sale-in-batumi-what-they-cost/): Around $1,395–1,500 per square metre on average — and five things that move that number far more than the district name does.\n- [Tbilisi or Batumi? The buyer mix tells you everything](https://patronigeorgia.com/blog/tbilisi-vs-batumi-which-to-buy/): Both average about $1,500 per square metre. Underneath, they are not the same market at all — and one statistic explains why.\n- [Yes, foreigners can buy property in Georgia — with one exception](https://patronigeorgia.com/blog/can-foreigners-buy-property-in-georgia/): Freehold, in your own name, no visa and no residency required. The exception is agricultural land, and it catches people out in one specific way.\n- [The best day trips from Tbilisi — and the one not to attempt](https://patronigeorgia.com/blog/best-day-trips-from-tbilisi/): Mtskheta in half a day, Kakheti in a full one, Ananuri and Gudauri if you leave early. And Kazbegi, which everybody sells as a day trip and nobody should book…\n- [Ninety-four countries can stay in Georgia for a year, visa-free](https://patronigeorgia.com/blog/georgia-visa-free-one-year/): No registration, no fee, no application — including every Gulf state, Jordan and Turkey. Plus the second route most people have never heard of.\n\n## Notes for machines\n\n- Sitemap: https://patronigeorgia.com/sitemap.xml\n- robots.txt allows every crawler listed by name, AI crawlers included.\n- Closed: /api/ (JSON endpoints) and /review/ (private approval screen).\n- Every page carries JSON-LD: Organization, WebSite, the page type and a BreadcrumbList. Guides with questions also carry FAQPage.\n- Prices are quoted in US dollars unless the page says otherwise, and each carries the date it was checked. Quote the date with the number.\n- Arabic mirror of any page: put /ar in front of the path.\n\n"}, "/.well-known/assetlinks.json": {"type": "application/json; charset=utf-8", "body": "[\n  {\n    \"relation\": [\n      \"delegate_permission/common.handle_all_urls\"\n    ],\n    \"target\": {\n      \"namespace\": \"android_app\",\n      \"package_name\": \"com.patronigeorgia.app\",\n      \"sha256_cert_fingerprints\": [\n        \"BF:E3:5E:BE:3D:2B:CA:B4:90:4A:BA:3C:CD:FB:88:B6:54:C8:8E:6E:21:8F:9E:0D:14:CB:F9:0F:91:C0:8E:EE\"\n      ]\n    }\n  }\n]\n"}};

const REDIRECTS = {
  "/ar/city/batumi": "/ar/tours/batumi",
  "/ar/city/borjomi": "/ar/tours/borjomi",
  "/ar/city/gonio": "/ar/tours/gonio",
  "/ar/city/kakheti": "/ar/tours/kakheti",
  "/ar/city/kazbegi": "/ar/tours/kazbegi",
  "/ar/city/kutaisi": "/ar/tours/kutaisi",
  "/ar/city/mtskheta": "/ar/tours/mtskheta",
  "/ar/city/svaneti": "/ar/tours/svaneti",
  "/ar/city/tbilisi": "/ar/tours/tbilisi",
  "/ar/guide": "/ar/guides/georgia-residence-permit-through-property",
  "/ar/project/address": "/ar/real-estate/batumi/address",
  "/ar/project/cinema": "/ar/real-estate/tbilisi/cinema",
  "/ar/project/collection": "/ar/real-estate/batumi/collection",
  "/ar/project/downtown": "/ar/real-estate/batumi/downtown",
  "/ar/project/gardens": "/ar/real-estate/batumi/gardens",
  "/ar/project/kobuleti": "/ar/real-estate/kobuleti/kobuleti",
  "/ar/project/magnolia": "/ar/real-estate/batumi/magnolia",
  "/ar/project/nextapartments": "/ar/real-estate/batumi/nextapartments",
  "/ar/project/nextgreen": "/ar/real-estate/batumi/nextgreen",
  "/ar/project/nextwhite": "/ar/real-estate/batumi/nextwhite",
  "/ar/project/oriental": "/ar/real-estate/tbilisi/oriental",
  "/ar/project/radisson": "/ar/real-estate/batumi/radisson",
  "/ar/project/tbilisi": "/ar/real-estate/tbilisi/tbilisi",
  "/ar/project/villapark": "/ar/real-estate/batumi/villapark",
  "/ar/project/wyndham": "/ar/real-estate/batumi/wyndham",
  "/ar/projects": "/ar/real-estate",
  "/city/batumi": "/tours/batumi",
  "/city/borjomi": "/tours/borjomi",
  "/city/gonio": "/tours/gonio",
  "/city/kakheti": "/tours/kakheti",
  "/city/kazbegi": "/tours/kazbegi",
  "/city/kutaisi": "/tours/kutaisi",
  "/city/mtskheta": "/tours/mtskheta",
  "/city/svaneti": "/tours/svaneti",
  "/city/tbilisi": "/tours/tbilisi",
  "/guide": "/guides/georgia-residence-permit-through-property",
  "/project/address": "/real-estate/batumi/address",
  "/project/cinema": "/real-estate/tbilisi/cinema",
  "/project/collection": "/real-estate/batumi/collection",
  "/project/downtown": "/real-estate/batumi/downtown",
  "/project/gardens": "/real-estate/batumi/gardens",
  "/project/kobuleti": "/real-estate/kobuleti/kobuleti",
  "/project/magnolia": "/real-estate/batumi/magnolia",
  "/project/nextapartments": "/real-estate/batumi/nextapartments",
  "/project/nextgreen": "/real-estate/batumi/nextgreen",
  "/project/nextwhite": "/real-estate/batumi/nextwhite",
  "/project/oriental": "/real-estate/tbilisi/oriental",
  "/project/radisson": "/real-estate/batumi/radisson",
  "/project/tbilisi": "/real-estate/tbilisi/tbilisi",
  "/project/villapark": "/real-estate/batumi/villapark",
  "/project/wyndham": "/real-estate/batumi/wyndham",
  "/projects": "/real-estate"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    try {
      if (p === "/api/submit")
        return m === "POST" ? await handleSubmit(request, env) : bad("post-only", 405);
      if (p === "/api/decide")
        return m === "POST" ? await handleDecide(request, env) : bad("post-only", 405);
      if (p === "/api/update")
        return m === "POST" ? await handleUpdate(request, env) : bad("post-only", 405);
      if (p === "/api/blog")
        return await handleBlog(request, env);
      if (p === "/api/feed")
        return m === "GET" ? await handleFeed(request, env) : bad("get-only", 405);
      if (p.startsWith("/api/account/")) {
        const act = p.slice(13);
        if (act === "me") return await handleAccount(request, env, "me");
        return m === "POST" ? await handleAccount(request, env, act)
                            : bad("post-only", 405);
      }
      if (p.startsWith("/review/"))
        return await handleReview(request, env, decodeURIComponent(p.slice(8)));
      if (p.startsWith("/media/"))
        return await handleMedia(request, env, decodeURIComponent(p.slice(7)));
    } catch (e) {
      /* a bug in here must never take the website down with it */
      if (p.startsWith("/api/")) return bad("server-error", 500);
      return new Response("Something went wrong.", { status: 500 });
    }

    /* robots.txt, sitemap.xml, llms.txt, assetlinks.json — folder copy first,
       baked copy if the folder copy is missing, never a 404. */
    if (Object.prototype.hasOwnProperty.call(FALLBACK, p)) {
      const f = FALLBACK[p];
      let r = null;
      try { r = await env.ASSETS.fetch(request); } catch (e) { r = null; }
      if (r && r.status === 200) {
        const h = new Headers(r.headers);
        h.set("content-type", f.type);
        return new Response(r.body, { status: 200, headers: h });
      }
      return new Response(f.body, {
        status: 200,
        headers: { "content-type": f.type,
                   "cache-control": "public, max-age=3600",
                   "x-patroni-source": "worker-fallback" }
      });
    }

    /* The URL tree moved when the site was restructured around the two
       businesses. These 301s keep every address we ever published alive, so
       no link and no crawled page is lost. */
    {
      const from = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
      const to = REDIRECTS[from];
      if (to) return Response.redirect(new URL(to + "/", request.url).toString(), 301);
    }

    /* everything else is a static file, headers and all */
    return env.ASSETS.fetch(request);
  }
};
