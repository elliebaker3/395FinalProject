import "dotenv/config";
import { pool } from "../db.js";
import { sendNudge } from "../push.js";

/**
 * Minimal "cron" pass: one contact per user where last_nudged is null or older than frequency.
 * Production: run on a schedule (GitHub Action, Render cron, etc.) or use node-cron in-process.
 */
async function main() {
  const users = await pool.query(`SELECT id FROM users`);
  for (const u of users.rows) {
    const due = await pool.query(
      `SELECT c.id, c.name, c.phone_e164, c.frequency_days, c.last_nudged_at
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
        data: {
          contactPhone: contact.phone_e164,
          contactId: String(contact.id),
        },
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
