import "dotenv/config";
import { pool } from "../db.js";
import { sendNudge } from "../push.js";

/**
 * Two-pass scheduler:
 *
 * Pass 1 — frequency-based nudges: for each user, find their most-overdue contact
 *   and send a nudge, respecting their availability windows.
 *
 * Pass 2 — scheduled calls: find all contact_schedules whose day + hour match now
 *   (in the user's timezone) and haven't been sent recently enough. These fire
 *   regardless of availability windows since the user chose those times explicitly.
 */

async function getDeviceTokens(userId) {
  const r = await pool.query(
    `SELECT expo_push_token, fcm_token FROM device_tokens WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ?? null;
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

async function passFrequencyNudges() {
  const users = await pool.query(`SELECT id, timezone FROM users`);

  for (const u of users.rows) {
    const availCheck = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM user_availability WHERE user_id = $1) AS has_windows,
              EXISTS(
                SELECT 1 FROM user_availability
                WHERE user_id = $1
                  AND day_of_week = EXTRACT(DOW FROM now() AT TIME ZONE $2)::int
                  AND start_time <= (now() AT TIME ZONE $2)::time
                  AND end_time   >  (now() AT TIME ZONE $2)::time
              ) AS in_window`,
      [u.id, u.timezone]
    );
    const { has_windows, in_window } = availCheck.rows[0];
    if (has_windows && !in_window) {
      console.log(`frequency pass: skipping user ${u.id} — outside availability window`);
      continue;
    }

    const due = await pool.query(
      `SELECT c.id, c.name, c.phone_e164
       FROM contacts c
       WHERE c.owner_user_id = $1
         AND (
           c.last_nudged_at IS NULL
           OR c.last_nudged_at <= now() - COALESCE(c.frequency_days, 7) * interval '1 day'
         )
       ORDER BY c.last_nudged_at NULLS FIRST
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
        data: { contactPhone: contact.phone_e164, contactId: String(contact.id) },
      },
      () => pool.query(`UPDATE contacts SET last_nudged_at = now() WHERE id = $1`, [contact.id])
    );
  }
}

async function passScheduledCalls() {
  // Find all schedules whose hour + day match now in the user's timezone,
  // and that haven't been sent within their recurrence window.
  const due = await pool.query(`
    SELECT cs.id, cs.user_id, cs.contact_id, cs.recurrence,
           c.name AS contact_name, c.phone_e164 AS contact_phone,
           u.timezone
    FROM contact_schedules cs
    JOIN users u ON u.id = cs.user_id
    JOIN contacts c ON c.id = cs.contact_id
    WHERE
      EXTRACT(HOUR FROM cs.scheduled_time) = EXTRACT(HOUR FROM now() AT TIME ZONE u.timezone)
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
    const tokens = await getDeviceTokens(row.user_id);
    if (!tokens?.expo_push_token && !tokens?.fcm_token) continue;

    await sendAndLog(
      tokens,
      {
        title: "Time for a call!",
        body: `Tap to call ${row.contact_name}`,
        data: { contactPhone: row.contact_phone, contactId: String(row.contact_id) },
      },
      () =>
        pool.query(`UPDATE contact_schedules SET last_sent_at = now() WHERE id = $1`, [row.id])
    );
  }
}

async function main() {
  await passFrequencyNudges();
  await passScheduledCalls();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
