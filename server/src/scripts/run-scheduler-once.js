import "dotenv/config";
import { pool } from "../db.js";
import { passFrequencyNudges, passScheduledCalls } from "../scheduler.js";

async function main() {
  await passFrequencyNudges();
  await passScheduledCalls();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
