import "dotenv/config";
import { pool } from "../db.js";

async function main() {
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_availability (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      CHECK (end_time > start_time)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS availability_user_idx ON user_availability (user_id);
  `);

  console.log("Migration complete.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
