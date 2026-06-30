require("dotenv").config();
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;

if (!connectionString) {
  console.warn("[db] DATABASE_URL (or NEON_DATABASE_URL) not set.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client", err);
});

module.exports = pool;