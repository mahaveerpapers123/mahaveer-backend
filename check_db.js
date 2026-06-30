
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;

if (!connectionString) {
    console.error("No DATABASE_URL found!");
    process.exit(1);
}

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
});

async function test() {
    try {
        console.log("Connecting to:", connectionString.replace(/:[^:@]+@/, ':***@'));
        const c = await pool.connect();
        console.log("Connected!");

        // Check tables
        const tables = ["NavLinks", "Users", "Products", "orders", "ProductReviews"];
        for (const t of tables) {
            try {
                const res = await c.query(`SELECT count(*) FROM "${t}"`);
                console.log(`Table "${t}" exists. Count:`, res.rows[0].count);
            } catch (e) {
                console.error(`Error checking table "${t}":`, e.message);
            }
        }

        c.release();
        pool.end();
    } catch (e) {
        console.error("Connection failed:", e);
        process.exit(1);
    }
}

test();
