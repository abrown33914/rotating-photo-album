import FRAME_HTML from "./frame.html";

const DRIVE = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const LIST_TTL_MS = 60 * 1000; // re-check the folder at most once a minute

// Kept in memory between requests while the Worker stays warm.
let tokenCache = { value: null, expires: 0 };
let listCache = { photos: null, byId: null, duplicates: 0, expires: 0 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["f", token, ...rest]

    // Everything lives under /f/<FRAME_TOKEN>/. Anything else looks like it doesn't exist.
    if (parts[0] !== "f" || !parts[1] || !tokenMatches(parts[1], env.FRAME_TOKEN)) {
      return new Response("Not found", { status: 404 });
    }
    if (parts.length === 2 && !url.pathname.endsWith("/")) {
      return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 302);
    }

    const rest = parts.slice(2);
    try {
      if (rest.length === 0) return page();
      if (rest[0] === "api" && rest[1] === "photos") return await photosJson(env);
      if (rest[0] === "photo" && rest[1]) return await photo(rest[1], url, env);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
    return new Response("Not found", { status: 404 });
  },
};

// ---------- routes ----------

function page() {
  return new Response(FRAME_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

async function photosJson(env) {
  const { photos, duplicates } = await listPhotos(env);
  return json({ photos: photos.map((p) => ({ id: p.id, name: p.name })), duplicates });
}

async function photo(id, url, env) {
  const size = clamp(parseInt(url.searchParams.get("s"), 10) || 1600, 400, 2048);
  const { byId } = await listPhotos(env);
  const file = byId.get(id);
  if (!file) return new Response("Not in folder", { status: 404 });

  let res = null;

  // Drive thumbnails are JPEGs with rotation applied, sized to what we ask for.
  // This also turns iPhone HEIC photos into something old Safari can show.
  if (file.thumbnailLink) {
    const thumbUrl = file.thumbnailLink.replace(/=s\d+(-[^/=]*)?$/, "") + "=s" + size;
    res = await fetch(thumbUrl);
    if (!res.ok) {
      res = await fetch(thumbUrl, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
    }
  }

  // Fallback: the original file, only for formats every browser can display.
  if ((!res || !res.ok) && /^image\/(jpeg|png|gif|webp)$/.test(file.mimeType)) {
    res = await fetch(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${await accessToken(env)}` },
    });
  }

  if (!res || !res.ok) return new Response("Couldn't load photo", { status: 502 });

  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
      // Only the iPad's own browser caches it, for a week.
      "Cache-Control": "private, max-age=604800",
    },
  });
}

// ---------- Drive ----------

async function listPhotos(env) {
  if (listCache.photos && Date.now() < listCache.expires) return listCache;

  const files = [];
  let pageToken;
  do {
    const params = {
      q: `'${env.FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "nextPageToken, files(id, name, md5Checksum, thumbnailLink, mimeType)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await driveGet("files", params, env);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Sort by name so the same copy of a duplicate is always the one kept.
  files.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set();
  const photos = [];
  let duplicates = 0;
  for (const f of files) {
    if (f.md5Checksum) {
      if (seen.has(f.md5Checksum)) {
        duplicates++;
        continue;
      }
      seen.add(f.md5Checksum);
    }
    photos.push(f);
  }

  listCache = {
    photos,
    byId: new Map(photos.map((p) => [p.id, p])),
    duplicates,
    expires: Date.now() + LIST_TTL_MS,
  };
  return listCache;
}

async function driveGet(path, params, env) {
  const token = await accessToken(env);
  const res = await fetch(`${DRIVE}/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Drive error: ${data.error?.message || res.status}`);
  return data;
}

// ---------- Google service-account sign-in ----------

async function accessToken(env) {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expires) return tokenCache.value;

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  };

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(signature)}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);

  tokenCache = { value: data.access_token, expires: now + (data.expires_in - 120) * 1000 };
  return tokenCache.value;
}

// ---------- helpers ----------

function tokenMatches(given, expected) {
  if (!expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToBytes(pem) {
  const bin = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}