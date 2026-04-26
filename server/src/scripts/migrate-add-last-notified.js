import "dotenv/config";
import { pool } from "../db.js";

async function main() {
  await pool.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
  `);
  console.log("Migration complete: added last_notified_at to contacts.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
