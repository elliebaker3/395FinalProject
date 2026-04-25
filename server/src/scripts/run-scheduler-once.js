import "dotenv/config";
import { pool } from "../db.js";
import { sendNudge } from "../push.js";

/**
 * Cron pass: for each user, send one nudge for their most-overdue contact —
 * but only if the current time falls within one of their availability windows.
 * Users with no availability windows set are always eligible.
 */
async function main() {
  const users = await pool.query(`SELECT id, timezone FROM users`);

  for (const u of users.rows) {
    // If the user has any availability windows, check whether now falls in one.
    const availCheck = await pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM user_availability
         WHERE user_id = $1
       ) AS has_windows,
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
      console.log(`skipping user ${u.id} — outside availability window`);
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

    const device = await pool.query(
      `SELECT expo_push_token, fcm_token FROM device_tokens WHERE user_id = $1`,
      [u.id]
    );
    const row = device.rows[0];
    if (!row?.expo_push_token && !row?.fcm_token) continue;

    const result = await sendNudge(
      { expoPushToken: row.expo_push_token, fcmToken: row.fcm_token },
      {
        title: "CallWizard",
        body: `Tap to call ${contact.name}`,
        data: { contactPhone: contact.phone_e164, contactId: String(contact.id) },
      }
    );

    if (result.ok) {
      await pool.query(`UPDATE contacts SET last_nudged_at = now() WHERE id = $1`, [
        contact.id,
      ]);
      console.log(`nudged user ${u.id} for contact ${contact.name}`);
    } else {
      console.warn(`failed user ${u.id}:`, result.errors);
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
