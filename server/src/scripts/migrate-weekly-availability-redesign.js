import "dotenv/config";
import { pool } from "../db.js";

async function main() {
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS min_call_minutes INT NOT NULL DEFAULT 15;
  `);
  await pool.query(`
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_min_call_minutes_check;
  `);
  await pool.query(`
    ALTER TABLE users
      ADD CONSTRAINT users_min_call_minutes_check CHECK (min_call_minutes > 0);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_week_availability (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      week_start_date DATE NOT NULL,
      day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      CHECK (end_time > start_time)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_week_availability_user_week_idx
      ON user_week_availability (user_id, week_start_date);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_google_tokens (
      user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
      refresh_token BYTEA,
      access_token BYTEA,
      token_expiry TIMESTAMPTZ,
      scope TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Backfill current-week slots from general availability for existing users.
  await pool.query(`
    INSERT INTO user_week_availability (user_id, week_start_date, day_of_week, start_time, end_time)
    SELECT
      ua.user_id,
      (date_trunc('day', now() AT TIME ZONE u.timezone)::date - EXTRACT(DOW FROM now() AT TIME ZONE u.timezone)::int) AS week_start_date,
      ua.day_of_week,
      ua.start_time,
      ua.end_time
    FROM user_availability ua
    JOIN users u ON u.id = ua.user_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM user_week_availability uwa
      WHERE uwa.user_id = ua.user_id
        AND uwa.week_start_date = (date_trunc('day', now() AT TIME ZONE u.timezone)::date - EXTRACT(DOW FROM now() AT TIME ZONE u.timezone)::int)
    );
  `);

  console.log("weekly availability redesign migration complete.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
