import "dotenv/config";
import { pool } from "../db.js";

async function main() {
  // Remove duplicate (owner_user_id, phone_e164) pairs before adding constraint,
  // keeping the oldest row for each pair.
  await pool.query(`
    DELETE FROM contacts
    WHERE id NOT IN (
      SELECT DISTINCT ON (owner_user_id, phone_e164) id
      FROM contacts
      ORDER BY owner_user_id, phone_e164, created_at ASC
    );
  `);

  await pool.query(`
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_owner_phone_unique UNIQUE (owner_user_id, phone_e164);
  `);

  console.log("Migration complete.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
