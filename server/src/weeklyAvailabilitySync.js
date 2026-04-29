import { pool } from "./db.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FREE_BUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseHHMM(hhmm) {
  const [h, m] = String(hhmm).split(":").map((v) => Number(v));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function startOfWeekSundayLocal(now = new Date()) {
  const d = new Date(now);
  const dow = d.getDay(); // 0=Sun
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dow);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    if (next.start <= cur.end) cur.end = Math.max(cur.end, next.end);
    else {
      out.push(cur);
      cur = { ...next };
    }
  }
  out.push(cur);
  return out;
}

function subtractIntervals(base, blockers) {
  let parts = [...base];
  for (const b of blockers) {
    parts = parts
      .flatMap((p) => {
        if (b.end <= p.start || b.start >= p.end) return [p];
        const out = [];
        if (b.start > p.start) out.push({ start: p.start, end: Math.min(b.start, p.end) });
        if (b.end < p.end) out.push({ start: Math.max(b.end, p.start), end: p.end });
        return out;
      })
      .filter((x) => x.end > x.start);
  }
  return mergeIntervals(parts);
}

function busyByWeekDayFromIso(busy) {
  const out = new Map(); // dow -> intervals in local day minutes
  for (const iv of busy ?? []) {
    const s = new Date(iv.start);
    const e = new Date(iv.end);
    if (!(s instanceof Date) || !(e instanceof Date) || Number.isNaN(+s) || Number.isNaN(+e) || e <= s) {
      continue;
    }
    const dow = s.getDay();
    const sMin = s.getHours() * 60 + s.getMinutes();
    const eMin = e.getHours() * 60 + e.getMinutes();
    const arr = out.get(dow) ?? [];
    arr.push({ start: sMin, end: Math.max(sMin + 1, eMin) });
    out.set(dow, arr);
  }
  for (const [k, v] of out) out.set(k, mergeIntervals(v));
  return out;
}

async function fetchPrimaryBusy(accessToken, timeMin, timeMax) {
  const res = await fetch(GOOGLE_FREE_BUSY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: [{ id: "primary" }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`freeBusy failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.calendars?.primary?.busy ?? [];
}

async function refreshGoogleAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID || process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  if (!clientId) throw new Error("missing GOOGLE_WEB_CLIENT_ID for backend refresh");
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);
  if (process.env.GOOGLE_CLIENT_SECRET) {
    params.set("client_secret", process.env.GOOGLE_CLIENT_SECRET);
  }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`token refresh failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

export async function upsertGoogleTokensForUser({ userId, refreshToken, accessToken, expiresInSec, scope }) {
  const encKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!encKey) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is required");
  const expiry = expiresInSec ? new Date(Date.now() + Number(expiresInSec) * 1000) : null;
  await pool.query(
    `INSERT INTO user_google_tokens (user_id, refresh_token, access_token, token_expiry, scope, updated_at)
     VALUES ($1,
             CASE WHEN $2::text IS NULL THEN NULL ELSE pgp_sym_encrypt($2::text, $6::text) END,
             CASE WHEN $3::text IS NULL THEN NULL ELSE pgp_sym_encrypt($3::text, $6::text) END,
             $4,
             $5,
             now())
     ON CONFLICT (user_id) DO UPDATE
     SET refresh_token = COALESCE(EXCLUDED.refresh_token, user_google_tokens.refresh_token),
         access_token = COALESCE(EXCLUDED.access_token, user_google_tokens.access_token),
         token_expiry = COALESCE(EXCLUDED.token_expiry, user_google_tokens.token_expiry),
         scope = COALESCE(EXCLUDED.scope, user_google_tokens.scope),
         updated_at = now()`,
    [userId, refreshToken ?? null, accessToken ?? null, expiry, scope ?? null, encKey]
  );
}

export async function computeAndPersistThisWeekAvailability(userId) {
  const encKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!encKey) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is required");

  const userRes = await pool.query(
    `SELECT id, timezone, min_call_minutes FROM users WHERE id = $1`,
    [userId]
  );
  const user = userRes.rows[0];
  if (!user) throw new Error("user_not_found");

  const generalRes = await pool.query(
    `SELECT day_of_week, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time
     FROM user_availability WHERE user_id = $1 ORDER BY day_of_week, start_time`,
    [userId]
  );
  const generalByDow = new Map();
  for (const row of generalRes.rows) {
    const s = parseHHMM(row.start_time);
    const e = parseHHMM(row.end_time);
    if (s == null || e == null || e <= s) continue;
    const arr = generalByDow.get(row.day_of_week) ?? [];
    arr.push({ start: s, end: e });
    generalByDow.set(row.day_of_week, arr);
  }
  if (generalByDow.size === 0) {
    return { weekStart: startOfWeekSundayLocal(), slots: [] };
  }

  const tokRes = await pool.query(
    `SELECT
       CASE WHEN refresh_token IS NULL THEN NULL ELSE pgp_sym_decrypt(refresh_token, $2::text) END AS refresh_token,
       CASE WHEN access_token IS NULL THEN NULL ELSE pgp_sym_decrypt(access_token, $2::text) END AS access_token,
       token_expiry
     FROM user_google_tokens
     WHERE user_id = $1`,
    [userId, encKey]
  );
  const tok = tokRes.rows[0];
  if (!tok?.refresh_token && !tok?.access_token) {
    return { weekStart: startOfWeekSundayLocal(), slots: [] };
  }

  let accessToken = tok?.access_token ?? null;
  if (!accessToken || (tok.token_expiry && new Date(tok.token_expiry) <= new Date(Date.now() + 60_000))) {
    if (!tok?.refresh_token) throw new Error("missing_refresh_token");
    const refreshed = await refreshGoogleAccessToken(tok.refresh_token);
    accessToken = refreshed.access_token;
    await upsertGoogleTokensForUser({
      userId,
      accessToken,
      expiresInSec: refreshed.expires_in,
      scope: refreshed.scope ?? null,
    });
  }

  const weekStart = startOfWeekSundayLocal();
  const weekEnd = addDays(weekStart, 7);
  const busy = await fetchPrimaryBusy(accessToken, weekStart.toISOString(), weekEnd.toISOString());
  const busyByDow = busyByWeekDayFromIso(busy);

  const minLen = Math.max(1, Number(user.min_call_minutes ?? 15));
  const weekSlots = [];
  for (let dow = 0; dow < 7; dow += 1) {
    const general = mergeIntervals(generalByDow.get(dow) ?? []);
    if (!general.length) continue;
    const busyForDay = busyByDow.get(dow) ?? [];
    const free = subtractIntervals(general, busyForDay).filter((s) => s.end - s.start >= minLen);
    for (const seg of free) {
      weekSlots.push({
        day_of_week: dow,
        start_time: toHHMM(seg.start),
        end_time: toHHMM(seg.end),
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM user_week_availability WHERE user_id = $1 AND week_start_date = $2::date`,
      [userId, weekStart.toISOString().slice(0, 10)]
    );
    for (const slot of weekSlots) {
      await client.query(
        `INSERT INTO user_week_availability (user_id, week_start_date, day_of_week, start_time, end_time)
         VALUES ($1, $2::date, $3, $4, $5)`,
        [userId, weekStart.toISOString().slice(0, 10), slot.day_of_week, slot.start_time, slot.end_time]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return { weekStart, slots: weekSlots };
}

export async function refreshThisWeekAvailabilityForAllConnectedUsers() {
  const users = await pool.query(`SELECT user_id FROM user_google_tokens`);
  for (const row of users.rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await computeAndPersistThisWeekAvailability(row.user_id);
    } catch (e) {
      console.error(`weekly sync failed for ${row.user_id}:`, e.message);
    }
  }
}
