import "dotenv/config";
import cors from "cors";
import express from "express";
import cron from "node-cron";
import { pool } from "./db.js";
import { sendNudge } from "./push.js";
import { passFrequencyNudges, passScheduledCalls } from "./scheduler.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;

// Keep dev/staging instances compatible if migrations were skipped.
pool
  .query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT`)
  .catch((e) => console.error("schema compatibility check failed:", e));

function parseScheduleInput(body = {}) {
  const { contactId, recurrence, dayOfWeek, dayOfMonth, scheduledTime } = body;
  if (!contactId || !recurrence || !scheduledTime) {
    return { error: "contactId, recurrence, scheduledTime required" };
  }
  if (!["weekly", "biweekly", "monthly"].includes(recurrence)) {
    return { error: "recurrence must be weekly, biweekly, or monthly" };
  }
  if (recurrence === "monthly" && dayOfMonth == null) {
    return { error: "dayOfMonth required for monthly recurrence" };
  }
  if (["weekly", "biweekly"].includes(recurrence) && dayOfWeek == null) {
    return { error: "dayOfWeek required for weekly/biweekly recurrence" };
  }
  return {
    payload: {
      contactId,
      recurrence,
      dayOfWeek: recurrence !== "monthly" ? dayOfWeek : null,
      dayOfMonth: recurrence === "monthly" ? dayOfMonth : null,
      scheduledTime,
    },
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/users", async (req, res) => {
  const { displayName, phoneE164 } = req.body ?? {};
  if (!displayName || !phoneE164) {
    return res.status(400).json({ error: "displayName and phoneE164 required" });
  }
  try {
    const r = await pool.query(
      `INSERT INTO users (display_name, phone_e164) VALUES ($1, $2)
       ON CONFLICT (phone_e164) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, display_name, phone_e164`,
      [displayName, phoneE164]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.post("/users/:userId/device-token", async (req, res) => {
  const { userId } = req.params;
  const { expoPushToken, fcmToken } = req.body ?? {};
  if (!expoPushToken && !fcmToken) {
    return res.status(400).json({ error: "expoPushToken or fcmToken required" });
  }
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, expo_push_token, fcm_token, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET
         expo_push_token = COALESCE(EXCLUDED.expo_push_token, device_tokens.expo_push_token),
         fcm_token = COALESCE(EXCLUDED.fcm_token, device_tokens.fcm_token),
         updated_at = now()`,
      [userId, expoPushToken ?? null, fcmToken ?? null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.post("/users/:userId/contacts", async (req, res) => {
  const { userId } = req.params;
  const { name, phoneE164, frequencyDays } = req.body ?? {};
  if (!name || !phoneE164) {
    return res.status(400).json({ error: "name and phoneE164 required" });
  }
  try {
    const r = await pool.query(
      `INSERT INTO contacts (owner_user_id, name, phone_e164, frequency_days)
       VALUES ($1, $2, $3, $4) RETURNING id, name, phone_e164, frequency_days`,
      [userId, name, phoneE164, frequencyDays ?? 7]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.get("/users/:userId/contacts", async (req, res) => {
  const { userId } = req.params;
  try {
    const r = await pool.query(
      `SELECT id, name, phone_e164, notes, frequency_days, last_nudged_at FROM contacts
       WHERE owner_user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.get("/users/:userId/contacts/:contactId", async (req, res) => {
  const { userId, contactId } = req.params;
  try {
    const contactResult = await pool.query(
      `SELECT id, name, phone_e164, notes, frequency_days, last_nudged_at
       FROM contacts
       WHERE id = $1 AND owner_user_id = $2`,
      [contactId, userId]
    );
    const contact = contactResult.rows[0];
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    const scheduleResult = await pool.query(
      `SELECT id, contact_id, recurrence, day_of_week, day_of_month,
              to_char(scheduled_time, 'HH24:MI') AS scheduled_time,
              created_at
       FROM contact_schedules
       WHERE user_id = $1 AND contact_id = $2
       ORDER BY created_at`,
      [userId, contactId]
    );

    const callHistory = contact.last_nudged_at
      ? [{ type: "called", at: contact.last_nudged_at }]
      : [];

    res.json({
      contact,
      schedules: scheduleResult.rows,
      call_history: callHistory,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.put("/users/:userId/contacts/:contactId", async (req, res) => {
  const { userId, contactId } = req.params;
  const { notes } = req.body ?? {};
  if (notes != null && typeof notes !== "string") {
    return res.status(400).json({ error: "notes must be a string or null" });
  }
  try {
    const r = await pool.query(
      `UPDATE contacts
       SET notes = $1
       WHERE id = $2 AND owner_user_id = $3
       RETURNING id, name, phone_e164, notes, frequency_days, last_nudged_at`,
      [notes ?? null, contactId, userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "contact_not_found" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.post("/users/:userId/contacts/bulk", async (req, res) => {
    const { userId } = req.params;
    const { contacts } = req.body ?? {};
    if (!Array.isArray(contacts)) {
          return res.status(400).json({ error: "contacts must be an array" });
    }
    let added = 0;
    try {
          for (const { name, phoneE164 } of contacts) {
                  if (!name || !phoneE164) continue;
                  const r = await pool.query(
                            `INSERT INTO contacts (owner_user_id, name, phone_e164)
                                     VALUES ($1, $2, $3)
                                              ON CONFLICT (owner_user_id, phone_e164) DO NOTHING`,
                            [userId, name, phoneE164]
                          );
                  added += r.rowCount ?? 0;
          }
          res.json({ added });
    } catch (e) {
          console.error(e);
          res.status(500).json({ error: "db_error" });
    }
});

app.get("/users/:userId/preferences", async (req, res) => {
  const { userId } = req.params;
  try {
    const userRow = await pool.query(
      `SELECT timezone FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRow.rows[0]) return res.status(404).json({ error: "user_not_found" });

    const avail = await pool.query(
      `SELECT day_of_week,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time,   'HH24:MI') AS end_time
       FROM user_availability WHERE user_id = $1
       ORDER BY day_of_week, start_time`,
      [userId]
    );
    res.json({ timezone: userRow.rows[0].timezone, availability: avail.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.put("/users/:userId/preferences", async (req, res) => {
  const { userId } = req.params;
  const { timezone, availability } = req.body ?? {};
  if (!timezone) return res.status(400).json({ error: "timezone required" });
  if (!Array.isArray(availability)) return res.status(400).json({ error: "availability must be an array" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE users SET timezone = $1 WHERE id = $2`, [timezone, userId]);
    await client.query(`DELETE FROM user_availability WHERE user_id = $1`, [userId]);
    for (const w of availability) {
      const { day_of_week, start_time, end_time } = w;
      if (day_of_week == null || !start_time || !end_time) continue;
      await client.query(
        `INSERT INTO user_availability (user_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [userId, day_of_week, start_time, end_time]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "db_error" });
  } finally {
    client.release();
  }
});

app.post("/users/:userId/contacts/bulk", async (req, res) => {
  const { userId } = req.params;
  const { contacts } = req.body ?? {};
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: "contacts array required" });
  }
  let added = 0;
  for (const c of contacts) {
    const { name, phoneE164 } = c;
    if (!name || !phoneE164) continue;
    const r = await pool.query(
      `INSERT INTO contacts (owner_user_id, name, phone_e164, frequency_days)
       VALUES ($1, $2, $3, 7)
       ON CONFLICT (owner_user_id, phone_e164) DO NOTHING`,
      [userId, name, phoneE164]
    ).catch(() => ({ rowCount: 0 }));
    if (r.rowCount > 0) added++;
  }
  res.json({ added });
});

app.get("/users/:userId/schedules", async (req, res) => {
  const { userId } = req.params;
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.contact_id, c.name AS contact_name, c.phone_e164 AS contact_phone,
              cs.recurrence, cs.day_of_week, cs.day_of_month,
              to_char(cs.scheduled_time, 'HH24:MI') AS scheduled_time
       FROM contact_schedules cs
       JOIN contacts c ON c.id = cs.contact_id
       WHERE cs.user_id = $1
       ORDER BY cs.created_at`,
      [userId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.post("/users/:userId/schedules", async (req, res) => {
  const { userId } = req.params;
  const parsed = parseScheduleInput(req.body ?? {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { contactId, recurrence, dayOfWeek, dayOfMonth, scheduledTime } = parsed.payload;
  try {
    const r = await pool.query(
      `INSERT INTO contact_schedules (user_id, contact_id, recurrence, day_of_week, day_of_month, scheduled_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, contactId, recurrence, dayOfWeek, dayOfMonth, scheduledTime]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.put("/users/:userId/schedules/:scheduleId", async (req, res) => {
  const { userId, scheduleId } = req.params;
  const parsed = parseScheduleInput(req.body ?? {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { contactId, recurrence, dayOfWeek, dayOfMonth, scheduledTime } = parsed.payload;
  try {
    const contact = await pool.query(
      `SELECT id FROM contacts WHERE id = $1 AND owner_user_id = $2`,
      [contactId, userId]
    );
    if (!contact.rows[0]) return res.status(404).json({ error: "contact_not_found" });

    const r = await pool.query(
      `UPDATE contact_schedules
       SET contact_id = $1,
           recurrence = $2,
           day_of_week = $3,
           day_of_month = $4,
           scheduled_time = $5
       WHERE id = $6 AND user_id = $7
       RETURNING id`,
      [contactId, recurrence, dayOfWeek, dayOfMonth, scheduledTime, scheduleId, userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "schedule_not_found" });
    res.json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.delete("/users/:userId/schedules/:scheduleId", async (req, res) => {
  const { userId, scheduleId } = req.params;
  try {
    await pool.query(
      `DELETE FROM contact_schedules WHERE id = $1 AND user_id = $2`,
      [scheduleId, userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.post("/users/:userId/contacts/:contactId/called", async (req, res) => {
  const { userId, contactId } = req.params;
  try {
    const r = await pool.query(
      `UPDATE contacts SET last_nudged_at = now()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING last_nudged_at`,
      [contactId, userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "contact_not_found" });
    res.json({ last_nudged_at: r.rows[0].last_nudged_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

/** Manual test: nudge a user to call a specific contact (by contact id). */
app.post("/users/:userId/nudge", async (req, res) => {
  const { userId } = req.params;
  const { contactId } = req.body ?? {};
  if (!contactId) {
    return res.status(400).json({ error: "contactId required" });
  }
  try {
    const contact = await pool.query(
      `SELECT id, name, phone_e164 FROM contacts WHERE id = $1 AND owner_user_id = $2`,
      [contactId, userId]
    );
    if (!contact.rows[0]) {
      return res.status(404).json({ error: "contact_not_found" });
    }
    const device = await pool.query(
      `SELECT expo_push_token, fcm_token FROM device_tokens WHERE user_id = $1`,
      [userId]
    );
    const row = device.rows[0];
    if (!row?.expo_push_token && !row?.fcm_token) {
      return res.status(400).json({ error: "no_device_token" });
    }
    const c = contact.rows[0];
    const result = await sendNudge(
      { expoPushToken: row.expo_push_token, fcmToken: row.fcm_token },
      {
        title: "Time for a call?",
        body: `Tap to call ${c.name}`,
        data: {
          contactPhone: c.phone_e164,
          contactId: String(c.id),
        },
      }
    );
    await pool.query(`UPDATE contacts SET last_notified_at = now() WHERE id = $1`, [c.id]);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "send_failed", message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`CallWizard API http://localhost:${PORT}`);
});

// Run scheduler every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  console.log("scheduler: running");
  try {
    await passFrequencyNudges();
    await passScheduledCalls();
    console.log("scheduler: done");
  } catch (e) {
    console.error("scheduler error:", e.message);
  }
});
