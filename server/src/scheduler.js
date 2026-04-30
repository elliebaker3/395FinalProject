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

export async function passFrequencyNudges() {
  const users = await pool.query(`SELECT id, timezone FROM users`);

  for (const u of users.rows) {
    const inWindow = await inActiveAvailabilityWindow(u.id, u.timezone);
    if (!inWindow) {
      console.log(`frequency pass: skipping user ${u.id} — outside availability window`);
      continue;
    }

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
      [u.id]
    );
    const contact = due.rows[0];
    if (!contact) continue;

    const tokens = await getDeviceTokens(u.id);
    if (!tokens?.expo_push_token && !tokens?.fcm_token) continue;

    await sendAndLog(
      tokens,
      {
        title: "CallWizard",
        body: `Tap to call ${contact.name}`,
        data: {
          contactPhone: contact.phone_e164,
          contactId: String(contact.id),
          contactName: contact.name,
        },
      },
      () => pool.query(`UPDATE contacts SET last_notified_at = now() WHERE id = $1`, [contact.id])
    );
  }
}

export async function passScheduledCalls() {
  const due = await pool.query(`
    SELECT cs.id, cs.user_id, cs.contact_id, cs.recurrence,
           c.name AS contact_name, c.phone_e164 AS contact_phone,
           u.timezone
    FROM contact_schedules cs
    JOIN users u ON u.id = cs.user_id
    JOIN contacts c ON c.id = cs.contact_id
    WHERE
      EXTRACT(HOUR FROM cs.scheduled_time) = EXTRACT(HOUR FROM now() AT TIME ZONE u.timezone)
      AND EXTRACT(MINUTE FROM cs.scheduled_time) = EXTRACT(MINUTE FROM now() AT TIME ZONE u.timezone)
      AND (
        (cs.recurrence IN ('weekly', 'biweekly')
          AND cs.day_of_week = EXTRACT(DOW FROM now() AT TIME ZONE u.timezone)::int)
        OR
        (cs.recurrence = 'monthly'
          AND cs.day_of_month = EXTRACT(DAY FROM now() AT TIME ZONE u.timezone)::int)
      )
      AND (
        cs.last_sent_at IS NULL
        OR (cs.recurrence = 'weekly'   AND cs.last_sent_at < now() - interval '6 days')
        OR (cs.recurrence = 'biweekly' AND cs.last_sent_at < now() - interval '13 days')
        OR (cs.recurrence = 'monthly'  AND cs.last_sent_at < now() - interval '27 days')
      )
  `);

  for (const row of due.rows) {
    const inWindow = await inActiveAvailabilityWindow(row.user_id, row.timezone);
    if (!inWindow) continue;

    const tokens = await getDeviceTokens(row.user_id);
    if (!tokens?.expo_push_token && !tokens?.fcm_token) continue;

    await sendAndLog(
      tokens,
      {
        title: "Time for a call!",
        body: `Time to call ${row.contact_name}!`,
        data: {
          contactPhone: row.contact_phone,
          contactId: String(row.contact_id),
          contactName: row.contact_name,
        },
      },
      () =>
        pool.query(`UPDATE contact_schedules SET last_sent_at = now() WHERE id = $1`, [row.id])
    );
  }
}