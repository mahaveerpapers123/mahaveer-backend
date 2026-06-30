const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const pool = require("../db");
const getFirebaseAdmin = require("../config/firebaseAdmin");

const router = express.Router();

const LOWER = (s) => (s || "").trim().toLowerCase();
const UPPER = (s) => (s || "").trim().toUpperCase();
const OTP_TTL_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5;
const SHOW_404_WHEN_NOT_FOUND = true;

const smtpConfigured = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") === "true",
  auth: smtpConfigured ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
});

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

async function sendOtpEmail({ to, otp }) {
  if (!smtpConfigured) return { emailSent: false };
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Your password reset code",
    text: `Your OTP is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    html: `<div style="font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial"><p>Use this code to reset your password:</p><p style="font-size:22px;font-weight:700;letter-spacing:2px">${otp}</p><p>This code expires in ${OTP_TTL_MINUTES} minutes.</p></div>`
  });
  return { emailSent: !!info.messageId };
}

function isValidGstin(gstin) {
  const v = UPPER(gstin);
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(v);
}

router.post("/signup", async (req, res) => {
  const { name, email, password, userType, gstNumber } = req.body || {};

  if (!name || !email || !password || !userType) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const emailLc = LOWER(email);
  const type = LOWER(userType);

  if (!["b2c", "b2b"].includes(type)) {
    return res.status(400).json({ error: "Invalid userType" });
  }

  if (type === "b2b") {
    if (!gstNumber) {
      return res.status(400).json({ error: "gstNumber is required for b2b" });
    }
    if (!isValidGstin(gstNumber)) {
      return res.status(422).json({ error: "Invalid GST number" });
    }
  }

  try {
    const existing = await pool.query(
      `SELECT id, auth_provider FROM "Users" WHERE LOWER(email) = $1 LIMIT 1`,
      [emailLc]
    );

    if (existing.rows[0]) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO "Users" (
        name,
        email,
        password,
        user_type,
        gst_number,
        gst_verified,
        auth_provider,
        firebase_uid,
        profile_image,
        email_verified
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, email, user_type, auth_provider, profile_image, email_verified`,
      [
        name,
        emailLc,
        hashedPassword,
        type,
        type === "b2b" ? UPPER(gstNumber) : null,
        false,
        "local",
        null,
        null,
        false
      ]
    );

    return res.status(201).json({
      message: "User created",
      id: result.rows[0].id,
      user: result.rows[0]
    });
  } catch (err) {
    if (String(err.code) === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }
    return res.status(500).json({ error: "Signup failed", detail: String(err.message || err) });
  }
});

router.post("/login", async (req, res) => {
  const { b2cEmail, b2cPassword, email, password, gstNumber, userType } = req.body || {};
  const type = LOWER(userType);

  if (!["b2c", "b2b"].includes(type)) {
    return res.status(400).json({ error: "Invalid userType" });
  }

  if (type === "b2c") {
    if (!b2cEmail || !b2cPassword) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const emailLc = LOWER(b2cEmail);

    try {
      const result = await pool.query(
        `SELECT * FROM "Users" WHERE LOWER(email) = $1 AND user_type = $2 LIMIT 1`,
        [emailLc, "b2c"]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!user.password) {
        return res.status(400).json({ error: "This account uses Google sign-in. Please continue with Google." });
      }

      const isMatch = await bcrypt.compare(b2cPassword, user.password);

      if (!isMatch) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      return res.json({
        message: "Login successful",
        userId: user.id,
        name: user.name,
        email: user.email,
        userType: user.user_type,
        authProvider: user.auth_provider || "local",
        profileImage: user.profile_image || null
      });
    } catch (err) {
      return res.status(500).json({ error: "Login failed", detail: String(err.message || err) });
    }
  }

  if (!email || !password || !gstNumber) {
    return res.status(400).json({ error: "All fields are required" });
  }

  if (!isValidGstin(gstNumber)) {
    return res.status(422).json({ error: "Invalid GST number" });
  }

  const emailLc = LOWER(email);
  const gstUp = UPPER(gstNumber);

  try {
    const result = await pool.query(
      `SELECT * FROM "Users"
       WHERE LOWER(email) = $1
         AND user_type = 'b2b'
         AND UPPER(gst_number) = $2
       LIMIT 1`,
      [emailLc, gstUp]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.password) {
      return res.status(400).json({ error: "This account uses Google sign-in. Please continue with Google." });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    return res.json({
      message: "Login successful",
      userId: user.id,
      name: user.name,
      email: user.email,
      userType: user.user_type,
      authProvider: user.auth_provider || "local",
      profileImage: user.profile_image || null
    });
  } catch (err) {
    return res.status(500).json({ error: "Login failed", detail: String(err.message || err) });
  }
});

router.post("/google", async (req, res) => {
  const { idToken } = req.body || {};

  if (!idToken) {
    return res.status(400).json({ error: "idToken is required" });
  }

  try {
    const admin = getFirebaseAdmin();

    if (!admin) {
      return res.status(500).json({ error: "Firebase admin is not configured" });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);

    const emailLc = LOWER(decoded.email);
    const firebaseUid = decoded.uid || null;
    const name = decoded.name || "Google User";
    const profileImage = decoded.picture || null;
    const emailVerified = Boolean(decoded.email_verified);

    if (!emailLc) {
      return res.status(400).json({ error: "Google account email not found" });
    }

    const existing = await pool.query(
      `SELECT * FROM "Users" WHERE LOWER(email) = $1 LIMIT 1`,
      [emailLc]
    );

    if (existing.rows[0]) {
      const user = existing.rows[0];

      if (user.user_type === "b2b") {
        return res.status(400).json({ error: "Google sign-in is currently available only for customer accounts" });
      }

      const updated = await pool.query(
        `UPDATE "Users"
         SET firebase_uid = COALESCE(firebase_uid, $2),
             profile_image = COALESCE($3, profile_image),
             email_verified = COALESCE($4, email_verified),
             auth_provider = CASE
               WHEN auth_provider IS NULL OR auth_provider = '' THEN 'google'
               ELSE auth_provider
             END
         WHERE id = $1
         RETURNING id, name, email, user_type, auth_provider, profile_image, email_verified`,
        [user.id, firebaseUid, profileImage, emailVerified]
      );

      return res.json({
        message: "Login successful",
        userId: updated.rows[0].id,
        name: updated.rows[0].name,
        email: updated.rows[0].email,
        userType: updated.rows[0].user_type,
        authProvider: updated.rows[0].auth_provider || "google",
        profileImage: updated.rows[0].profile_image || null,
        emailVerified: updated.rows[0].email_verified === true
      });
    }

    const inserted = await pool.query(
      `INSERT INTO "Users" (
        name,
        email,
        password,
        user_type,
        gst_number,
        gst_verified,
        auth_provider,
        firebase_uid,
        profile_image,
        email_verified
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, email, user_type, auth_provider, profile_image, email_verified`,
      [
        name,
        emailLc,
        null,
        "b2c",
        null,
        false,
        "google",
        firebaseUid,
        profileImage,
        emailVerified
      ]
    );

    return res.status(201).json({
      message: "Login successful",
      userId: inserted.rows[0].id,
      name: inserted.rows[0].name,
      email: inserted.rows[0].email,
      userType: inserted.rows[0].user_type,
      authProvider: inserted.rows[0].auth_provider,
      profileImage: inserted.rows[0].profile_image || null,
      emailVerified: inserted.rows[0].email_verified === true
    });
  } catch (err) {
    return res.status(401).json({ error: "Invalid Google token", detail: String(err.message || err) });
  }
});

router.post("/forgot/request", async (req, res) => {
  const { email } = req.body || {};
  const emailLc = LOWER(email);

  if (!emailLc) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    const q = await pool.query(
      `SELECT id, auth_provider, password FROM "Users" WHERE LOWER(email) = $1`,
      [emailLc]
    );

    const user = q.rows[0];

    if (!user) {
      if (SHOW_404_WHEN_NOT_FOUND) {
        return res.status(404).json({ error: "Email not found" });
      }
      return res.json({ ok: true, emailSent: false });
    }

    if ((user.auth_provider || "").toLowerCase() === "google" && !user.password) {
      return res.status(400).json({ error: "This account uses Google sign-in. Please continue with Google." });
    }

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await pool.query(
      `UPDATE "Users"
       SET reset_otp_hash = $2,
           reset_expires_at = $3,
           reset_attempts = 0,
           reset_in_progress = TRUE
       WHERE id = $1`,
      [user.id, otpHash, expiresAt]
    );

    let emailResult = { emailSent: false };

    try {
      emailResult = await sendOtpEmail({ to: emailLc, otp });
    } catch (e) {
      emailResult = { emailSent: false, error: String(e.message || e) };
    }

    return res.json({ ok: true, emailSent: emailResult.emailSent === true });
  } catch (err) {
    return res.status(500).json({ error: "Could not start reset", detail: String(err.message || err) });
  }
});

router.post("/forgot/verify", async (req, res) => {
  const { email, otp } = req.body || {};
  const emailLc = LOWER(email);

  if (!emailLc || !otp) {
    return res.status(400).json({ error: "email and otp are required" });
  }

  try {
    const q = await pool.query(
      `SELECT id, reset_otp_hash, reset_expires_at, reset_attempts, reset_in_progress
       FROM "Users" WHERE LOWER(email) = $1`,
      [emailLc]
    );

    const row = q.rows[0];

    if (!row) {
      return res.status(400).json({ error: "Invalid request" });
    }

    if (!row.reset_in_progress) {
      return res.status(400).json({ error: "No reset in progress" });
    }

    if (row.reset_attempts >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ error: "Too many attempts" });
    }

    if (!row.reset_expires_at || new Date(row.reset_expires_at) < new Date()) {
      return res.status(400).json({ error: "OTP expired" });
    }

    const ok = await bcrypt.compare(otp, row.reset_otp_hash || "");

    await pool.query(`UPDATE "Users" SET reset_attempts = reset_attempts + 1 WHERE id = $1`, [row.id]);

    if (!ok) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Verification failed", detail: String(err.message || err) });
  }
});

router.post("/forgot/reset", async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  const emailLc = LOWER(email);

  if (!emailLc || !otp || !newPassword) {
    return res.status(400).json({ error: "email, otp and newPassword are required" });
  }

  if (newPassword.length < 6) {
    return res.status(422).json({ error: "Password must be at least 6 characters" });
  }

  try {
    const q = await pool.query(
      `SELECT id, reset_otp_hash, reset_expires_at, reset_attempts, reset_in_progress
       FROM "Users" WHERE LOWER(email) = $1`,
      [emailLc]
    );

    const row = q.rows[0];

    if (!row) {
      return res.status(400).json({ error: "Invalid request" });
    }

    if (!row.reset_in_progress) {
      return res.status(400).json({ error: "No reset in progress" });
    }

    if (row.reset_attempts >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ error: "Too many attempts" });
    }

    if (!row.reset_expires_at || new Date(row.reset_expires_at) < new Date()) {
      return res.status(400).json({ error: "OTP expired" });
    }

    const ok = await bcrypt.compare(otp, row.reset_otp_hash || "");

    if (!ok) {
      await pool.query(`UPDATE "Users" SET reset_attempts = reset_attempts + 1 WHERE id = $1`, [row.id]);
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE "Users"
       SET password = $2,
           auth_provider = CASE
             WHEN auth_provider IS NULL OR auth_provider = '' THEN 'local'
             ELSE auth_provider
           END,
           reset_otp_hash = NULL,
           reset_expires_at = NULL,
           reset_attempts = 0,
           reset_in_progress = FALSE
       WHERE id = $1`,
      [row.id, hashed]
    );

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Reset failed", detail: String(err.message || err) });
  }
});

router.get("/email/test", async (req, res) => {
  try {
    const to = req.query.to || process.env.SMTP_USER;
    const info = smtpConfigured
      ? await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to,
          subject: "Test Email",
          text: "If you see this, your SMTP setup works."
        })
      : { messageId: null };

    res.json({ ok: true, emailSent: !!info.messageId, smtpConfigured });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;