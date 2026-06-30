const express = require("express");
const pool = require("../db");

const router = express.Router();

function isValidGstin(gstin) {
  const v = String(gstin || "").trim().toUpperCase();
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v);
}

router.get("/users", async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT id, name, email, user_type, gst_number, gst_verified, created_at
       FROM "Users"
       ORDER BY created_at DESC NULLS LAST, id DESC`
    );
    res.json({ users: q.rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

router.patch("/users/:id/type", async (req, res) => {
  const id = req.params.id;
  const { userType, gstVerified } = req.body || {};
  const toType = String(userType || "").toLowerCase();
  if (!["b2c", "b2b"].includes(toType)) return res.status(400).json({ error: "Invalid userType" });
  try {
    const cur = await pool.query(
      `SELECT id, user_type, gst_number, gst_verified FROM "Users" WHERE id = $1`,
      [id]
    );
    const row = cur.rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });

    if (toType === "b2b") {
      if (!row.gst_number) return res.status(422).json({ error: "GST number required" });
      if (!isValidGstin(row.gst_number)) return res.status(422).json({ error: "Invalid GST number" });
      const upd = await pool.query(
        `UPDATE "Users" SET user_type = 'b2b', gst_verified = $2 WHERE id = $1 RETURNING id, name, email, user_type, gst_number, gst_verified, created_at`,
        [id, gstVerified === true]
      );
      return res.json({ user: upd.rows[0] });
    } else {
      const upd = await pool.query(
        `UPDATE "Users" SET user_type = 'b2c', gst_verified = FALSE WHERE id = $1 RETURNING id, name, email, user_type, gst_number, gst_verified, created_at`,
        [id]
      );
      return res.json({ user: upd.rows[0] });
    }
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
