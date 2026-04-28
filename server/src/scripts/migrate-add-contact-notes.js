import "dotenv/config";
import { pool } from "../db.js";

async function main() {
  await pool.query(`
    ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS notes TEXT;
  `);

  console.log("Migration complete.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
