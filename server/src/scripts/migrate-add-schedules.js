import "dotenv/config";
import { pool } from "../db.js";

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      contact_id UUID NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
      recurrence TEXT NOT NULL CHECK (recurrence IN ('weekly', 'biweekly', 'monthly')),
      day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
      day_of_month SMALLINT CHECK (day_of_month BETWEEN 1 AND 31),
      scheduled_time TIME NOT NULL,
      last_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (
        (recurrence IN ('weekly', 'biweekly') AND day_of_week IS NOT NULL AND day_of_month IS NULL)
        OR
        (recurrence = 'monthly' AND day_of_month IS NOT NULL AND day_of_week IS NULL)
      )
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS schedules_user_idx ON contact_schedules (user_id);
  `);

  console.log("Migration complete.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
