import { pool } from "./db.js";
import { sendNudge } from "./push.js";

async function getDeviceTokens(userId) {
  const r = await pool.query(
    `SELECT expo_push_token, fcm_token FROM device_tokens WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ?? null;
}

async function inActiveAvailabilityWindow(userId, timezone) {
  const r = await pool.query(
    `WITH wk AS (
       SELECT (date_trunc('day', now() AT TIME ZONE $2)::date - EXTRACT(DOW FROM now() AT TIME ZONE $2)::int) AS week_start
     ),
     week_slots AS (
       SELECT 1
       FROM user_week_availability uwa, wk
       WHERE uwa.user_id = $1
         AND uwa.week_start_date = wk.week_start
     ),
     active_week AS (
       SELECT EXISTS(SELECT 1 FROM week_slots) AS has_week,
              EXISTS(
                SELECT 1
                FROM user_week_availability uwa, wk
                WHERE uwa.user_id = $1
                  AND uwa.week_start_date = wk.week_start
                  AND uwa.day_of_week = EXTRACT(DOW FROM now() AT TIME ZONE $2)::int
                  AND uwa.start_time <= (now() AT TIME ZONE $2)::time
                  AND uwa.end_time > (now() AT TIME ZONE $2)::time
              ) AS in_week
     ),
     active_general AS (
       SELECT EXISTS(SELECT 1 FROM user_availability WHERE user_id = $1) AS has_general,
              EXISTS(
                SELECT 1 FROM user_availability
                WHERE user_id = $1
                  AND day_of_week = EXTRACT(DOW FROM now() AT TIME ZONE $2)::int
                  AND start_time <= (now() AT TIME ZONE $2)::time
                  AND end_time > (now() AT TIME ZONE $2)::time
              ) AS in_general
     )
     SELECT
       (SELECT has_week FROM active_week) AS has_week,
       (SELECT in_week FROM active_week) AS in_week,
       (SELECT has_general FROM active_general) AS has_general,
       (SELECT in_general FROM active_general) AS in_general`,
    [userId, timezone]
  );

  const row = r.rows[0];
  if (row.has_week || row.has_general) return row.in_week || row.in_general;
  return true;
}

/** Next instant a recurring availability slot opens (after now), or null. */
async function getNextAvailabilityStartUtc(userId, timezone) {
  const r = await pool.query(
    `
    WITH tz AS (SELECT $2::text AS tzname),
    wk AS (
      SELECT (
        date_trunc('day', now() AT TIME ZONE (SELECT tzname FROM tz))::date
        - EXTRACT(DOW FROM now() AT TIME ZONE (SELECT tzname FROM tz))::int
      ) AS week_start
      FROM tz
    ),
    has_week AS (
      SELECT EXISTS (
        SELECT 1
        FROM user_week_availability uwa, wk
        WHERE uwa.user_id = $1 AND uwa.week_start_date = wk.week_start
      ) AS v
    ),
    effective_slots AS (
      SELECT uwa.day_of_week, uwa.start_time, uwa.end_time
      FROM user_week_availability uwa, wk, has_week hw
      WHERE uwa.user_id = $1 AND uwa.week_start_date = wk.week_start AND hw.v
      UNION ALL
      SELECT ua.day_of_week, ua.start_time, ua.end_time
      FROM user_availability ua, has_week hw
      WHERE ua.user_id = $1 AND NOT hw.v
    ),
    params AS (
      SELECT (now() AT TIME ZONE (SELECT tzname FROM tz))::date AS local_today
      FROM tz
    ),
    days AS (
      SELECT
        (p.local_today + g.i)::date AS cal_date,
        EXTRACT(DOW FROM (p.local_today + g.i)::date)::int AS dow
      FROM params p
      CROSS JOIN generate_series(0, 14) AS g(i)
    )
    SELECT min(
      ((d.cal_date + s.start_time)::timestamp AT TIME ZONE (SELECT tzname FROM tz))
    ) AS next_start
    FROM days d
    INNER JOIN effective_slots s ON s.day_of_week = d.dow
    CROSS JOIN tz
    WHERE ((d.cal_date + s.start_time)::timestamp AT TIME ZONE (SELECT tzname FROM tz)) > now()
    `,
    [userId, timezone]
  );
  const t = r.rows[0]?.next_start;
  return t ? new Date(t) : null;
}

async function selectMostOverdueContactForFrequencyNudge(userId) {
  const due = await pool.query(
    `SELECT c.id, c.name, c.phone_e164
     FROM contacts c
            LEFT JOIN users cu ON cu.phone_e164 = c.phone_e164
     WHERE c.owner_user_id = $1
       AND (
         c.last_notified_at IS NULL
         OR c.last_notified_at <= now() - COALESCE(c.frequency_days, 7) * interval '1 day'
       )
            AND (
              cu.id IS NULL
              OR EXISTS (
                SELECT 1
                FROM user_availability ua
                WHERE ua.user_id = cu.id
                  AND ua.day_of_week = EXTRACT(DOW FROM now() AT TIME ZONE cu.timezone)::int
                  AND ua.start_time <= (now() AT TIME ZONE cu.timezone)::time
                  AND ua.end_time > (now() AT TIME ZONE cu.timezone)::time
              )
            )
     ORDER BY c.last_notified_at NULLS FIRST
     LIMIT 1`,
    [userId]
  );
  return due.rows[0] ?? null;
}

function toPgTime(t) {
  if (t == null) return "00:00:00";
  if (typeof t === "string") return t.length === 5 ? `${t}:00` : t;
  if (t instanceof Date) return t.toISOString().slice(11, 19);
  return String(t);
}

/** Next UTC instant for weekly/biweekly slot (cooldown days after last_sent_at). */
async function nextWeeklyFireUtc(timezone, scheduledTime, dayOfWeek, lastSentAt, cooldownDays) {
  const timeStr = toPgTime(scheduledTime);
  const r = await pool.query(
    `
    WITH tz AS (SELECT $1::text AS tzname),
    params AS (
      SELECT (now() AT TIME ZONE (SELECT tzname FROM tz))::date AS local_today
      FROM tz
    ),
    days AS (
      SELECT (p.local_today + g.i)::date AS cal_date,
             EXTRACT(DOW FROM (p.local_today + g.i)::date)::int AS dow
      FROM params p
      CROSS JOIN generate_series(0, 400) AS g(i)
    ),
    candidates AS (
      SELECT ((d.cal_date + $2::time)::timestamp AT TIME ZONE (SELECT tzname FROM tz)) AS fire_utc
      FROM days d
      WHERE d.dow = $3::int
        -- Grace: include the scheduled minute for ~3m after it starts so a late sync still schedules
        AND ((d.cal_date + $2::time)::timestamp AT TIME ZONE (SELECT tzname FROM tz)) > now() - interval '3 minutes'
        AND (
          $4::timestamptz IS NULL
          OR ((d.cal_date + $2::time)::timestamp AT TIME ZONE (SELECT tzname FROM tz))
             > $4::timestamptz + ($5::int || ' days')::interval
        )
    )
    SELECT min(fire_utc) AS next_fire FROM candidates
    `,
    [timezone, timeStr, dayOfWeek, lastSentAt, cooldownDays]
  );
  const x = r.rows[0]?.next_fire;
  return x ? new Date(x) : null;
}

async function nextMonthlyFireUtc(timezone, scheduledTime, dayOfMonth, lastSentAt) {
  const timeStr = toPgTime(scheduledTime);
  const r = await pool.query(
    `
    WITH tz AS (SELECT $1::text AS tzname),
    params AS (
      SELECT (now() AT TIME ZONE (SELECT tzname FROM tz))::date AS local_today
      FROM tz
    ),
    days AS (
      SELECT (p.local_today + g.i)::date AS cal_date
      FROM params p
      CROSS JOIN generate_series(0, 400) AS g(i)
    ),
    candidates AS (
      SELECT ((d.cal_date + $2::time)::timestamp AT TIME ZONE (SELECT tzname FROM tz)) AS fire_utc
      FROM days d
      WHERE EXTRACT(DAY FROM d.cal_date)::int = $3::int
        AND ((d.cal_date + $2::time)::timestamp AT TIME ZONE (SELECT tzname FROM tz)) > now() - interval '3 minutes'
        AND (
          $4::timestamptz IS NULL
          OR ((d.cal_date + $2::time)::timestamp AT TIME ZONE (SELECT tzname FROM tz))
             > $4::timestamptz + interval '27 days'
        )
    )
    SELECT min(fire_utc) AS next_fire FROM candidates
    `,
    [timezone, timeStr, dayOfMonth, lastSentAt]
  );
  const x = r.rows[0]?.next_fire;
  return x ? new Date(x) : null;
}

async function nextScheduleFireUtc(row, timezone) {
  const last = row.last_sent_at;
  if (row.recurrence === "weekly") {
    return nextWeeklyFireUtc(timezone, row.scheduled_time, row.day_of_week, last, 6);
  }
  if (row.recurrence === "biweekly") {
    return nextWeeklyFireUtc(timezone, row.scheduled_time, row.day_of_week, last, 13);
  }
  if (row.recurrence === "monthly") {
    return nextMonthlyFireUtc(timezone, row.scheduled_time, row.day_of_month, last);
  }
  return null;
}

/**
 * Frequency nudge: most overdue contact + when to fire a local notification (ISO UTC).
 */
export async function getPendingFrequencyLocal(userId) {
  const u = await pool.query(`SELECT id, timezone FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]) return { error: "user_not_found" };

  const timezone = u.rows[0].timezone;
  const contact = await selectMostOverdueContactForFrequencyNudge(userId);
  if (!contact) return { pending: null };

  const inWindow = await inActiveAvailabilityWindow(userId, timezone);
  let fireAt;
  if (inWindow) {
    fireAt = new Date(Date.now() + 10_000);
  } else {
    const next = await getNextAvailabilityStartUtc(userId, timezone);
    fireAt = next ? new Date(next.getTime() + 10_000) : new Date(Date.now() + 60_000);
  }

  return {
    pending: {
      kind: "frequency",
      contactId: contact.id,
      contactName: contact.name,
      contactPhone: contact.phone_e164,
      fireAt: fireAt.toISOString(),
    },
  };
}

/**
 * Scheduled-call reminders: next fire time per row (for local scheduling on device).
 */
export async function getPendingScheduledLocals(userId) {
  const u = await pool.query(`SELECT id, timezone FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]) return { error: "user_not_found" };

  const timezone = u.rows[0].timezone;
  const rows = await pool.query(
    `SELECT cs.id AS schedule_id, cs.contact_id, cs.recurrence, cs.day_of_week, cs.day_of_month,
            cs.scheduled_time, cs.last_sent_at,
            c.name AS contact_name, c.phone_e164 AS contact_phone
     FROM contact_schedules cs
     JOIN contacts c ON c.id = cs.contact_id
     WHERE cs.user_id = $1`,
    [userId]
  );

  const items = [];
  const horizon = Date.now() + 90 * 86_400_000;
  for (const row of rows.rows) {
    const fire = await nextScheduleFireUtc(row, timezone);
    if (fire && fire.getTime() <= horizon) {
      items.push({
        kind: "scheduled",
        scheduleId: row.schedule_id,
        contactId: row.contact_id,
        contactName: row.contact_name,
        contactPhone: row.contact_phone,
        fireAt: fire.toISOString(),
      });
    }
  }
  items.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  return { scheduled: items };
}

/** Combined payload for one GET (mobile sync). */
export async function getPendingLocalReminders(userId) {
  const freq = await getPendingFrequencyLocal(userId);
  if (freq.error) return freq;
  const sch = await getPendingScheduledLocals(userId);
  if (sch.error) return sch;
  return {
    frequency: freq.pending,
    scheduled: sch.scheduled,
  };
}

async function sendAndLog(tokens, payload, onSuccess) {
  const result = await sendNudge(
    { expoPushToken: tokens.expo_push_token, fcmToken: tokens.fcm_token },
    payload
  );
  if (result.ok) {
    await onSuccess();
    console.log(`sent: ${payload.body}`);
  } else {
    console.warn(`send failed:`, result.errors);
  }
}

/** Server push disabled — app uses local notifications via GET /pending-local-reminders. */
export async function passFrequencyNudges() {}

/** Server push disabled — app uses local notifications. */
export async function passScheduledCalls() {}
