const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const pool = require('../db');
const getFirebaseAdmin = require('../config/firebaseAdmin');

const router = express.Router();
const OTP_TTL_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5;
const smtpConfigured = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
  auth: smtpConfigured ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
});

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function text(value) {
  return String(value ?? '').trim();
}

function isValidGstin(value) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(upper(value));
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function sendOtpEmail(to, otp) {
  if (!smtpConfigured) return false;
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Your password reset code',
    text: `Your OTP is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial"><p>Use this code to reset your password:</p><p style="font-size:22px;font-weight:700;letter-spacing:2px">${otp}</p><p>This code expires in ${OTP_TTL_MINUTES} minutes.</p></div>`
  });
  return Boolean(info.messageId);
}

function publicUser(user) {
  return {
    id: user.id,
    userId: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || null,
    userType: user.user_type,
    gstNumber: user.gst_number || null,
    gstVerified: user.gst_verified === true,
    authProvider: user.auth_provider || 'local',
    profileImage: user.profile_image || null,
    emailVerified: user.email_verified === true,
    isActive: user.is_active !== false
  };
}

router.post('/signup', async (req, res) => {
  const body = req.body || {};
  const name = text(body.name);
  const email = lower(body.email);
  const password = String(body.password || '');
  const userType = lower(body.userType);
  const gstNumber = upper(body.gstNumber);
  const phone = text(body.phone) || null;

  if (!name || !email || !password || !userType) return res.status(400).json({ error: 'All fields are required' });
  if (!['b2c', 'b2b'].includes(userType)) return res.status(400).json({ error: 'Invalid userType' });
  if (password.length < 6) return res.status(422).json({ error: 'Password must be at least 6 characters' });

  if (userType === 'b2b') {
    if (!gstNumber) return res.status(400).json({ error: 'gstNumber is required for b2b' });
    if (!isValidGstin(gstNumber)) return res.status(422).json({ error: 'Invalid GST number' });
  }

  try {
    const existing = await pool.query(`SELECT id FROM "Users" WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    if (existing.rowCount) return res.status(409).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO "Users" (
         name,
         email,
         phone,
         password,
         user_type,
         gst_number,
         gst_verified,
         auth_provider,
         firebase_uid,
         profile_image,
         email_verified,
         role,
         is_active,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, false, 'local', null, null, false, 'CUSTOMER', true, NOW(), NOW())
       RETURNING *`,
      [name, email, phone, hashedPassword, userType, userType === 'b2b' ? gstNumber : null]
    );

    return res.status(201).json({ message: 'User created', user: publicUser(result.rows[0]) });
  } catch (error) {
    if (String(error.code) === '23505') return res.status(409).json({ error: 'Email already registered' });
    return res.status(500).json({ error: 'Signup failed', detail: String(error.message || error) });
  }
});

router.post('/login', async (req, res) => {
  const body = req.body || {};
  const userType = lower(body.userType);

  if (!['b2c', 'b2b'].includes(userType)) return res.status(400).json({ error: 'Invalid userType' });

  const email = lower(userType === 'b2c' ? body.b2cEmail || body.email : body.email);
  const password = String(userType === 'b2c' ? body.b2cPassword || body.password : body.password || '');
  const gstNumber = upper(body.gstNumber);

  if (!email || !password) return res.status(400).json({ error: 'All fields are required' });
  if (userType === 'b2b' && (!gstNumber || !isValidGstin(gstNumber))) return res.status(422).json({ error: 'A valid GST number is required' });

  try {
    const params = [email, userType];
    let gstSql = '';
    if (userType === 'b2b') {
      params.push(gstNumber);
      gstSql = `AND UPPER(gst_number) = $3`;
    }

    const result = await pool.query(
      `SELECT *
       FROM "Users"
       WHERE LOWER(email) = $1
         AND user_type = $2
         ${gstSql}
       LIMIT 1`,
      params
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_active === false) return res.status(403).json({ error: 'Account is inactive' });
    if (!user.password) return res.status(400).json({ error: 'This account uses Google sign-in. Please continue with Google.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    return res.json({ message: 'Login successful', ...publicUser(user) });
  } catch (error) {
    return res.status(500).json({ error: 'Login failed', detail: String(error.message || error) });
  }
});

router.post('/google', async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken) return res.status(400).json({ error: 'idToken is required' });

  try {
    const firebase = getFirebaseAdmin();
    if (!firebase) return res.status(500).json({ error: 'Firebase admin is not configured' });

    const decoded = await firebase.auth().verifyIdToken(idToken);
    const email = lower(decoded.email);
    if (!email) return res.status(400).json({ error: 'Google account email not found' });

    const existing = await pool.query(`SELECT * FROM "Users" WHERE LOWER(email) = $1 LIMIT 1`, [email]);

    if (existing.rowCount) {
      const user = existing.rows[0];
      if (user.is_active === false) return res.status(403).json({ error: 'Account is inactive' });
      if (user.user_type === 'b2b') return res.status(400).json({ error: 'Google sign-in is available only for B2C accounts' });

      const updated = await pool.query(
        `UPDATE "Users"
         SET firebase_uid = COALESCE(firebase_uid, $2),
             profile_image = COALESCE($3, profile_image),
             email_verified = COALESCE($4, email_verified),
             auth_provider = CASE WHEN auth_provider IS NULL OR auth_provider = '' THEN 'google' ELSE auth_provider END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [user.id, decoded.uid || null, decoded.picture || null, Boolean(decoded.email_verified)]
      );

      return res.json({ message: 'Login successful', ...publicUser(updated.rows[0]) });
    }

    const inserted = await pool.query(
      `INSERT INTO "Users" (
         name,
         email,
         phone,
         password,
         user_type,
         gst_number,
         gst_verified,
         auth_provider,
         firebase_uid,
         profile_image,
         email_verified,
         role,
         is_active,
         created_at,
         updated_at
       ) VALUES ($1, $2, null, null, 'b2c', null, false, 'google', $3, $4, $5, 'CUSTOMER', true, NOW(), NOW())
       RETURNING *`,
      [decoded.name || 'Google User', email, decoded.uid || null, decoded.picture || null, Boolean(decoded.email_verified)]
    );

    return res.status(201).json({ message: 'Login successful', ...publicUser(inserted.rows[0]) });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid Google token', detail: String(error.message || error) });
  }
});

router.get('/me/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM "Users" WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.patch('/me/:id', async (req, res) => {
  try {
    const name = text(req.body?.name) || null;
    const phone = text(req.body?.phone) || null;
    const result = await pool.query(
      `UPDATE "Users"
       SET name = COALESCE($2, name),
           phone = COALESCE($3, phone),
           updated_at = NOW()
       WHERE id = $1 AND is_active = true
       RETURNING *`,
      [req.params.id, name, phone]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.post('/forgot/request', async (req, res) => {
  const email = lower(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const result = await pool.query(`SELECT id, auth_provider, password, is_active FROM "Users" WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Email not found' });
    if (user.is_active === false) return res.status(403).json({ error: 'Account is inactive' });
    if (lower(user.auth_provider) === 'google' && !user.password) return res.status(400).json({ error: 'This account uses Google sign-in. Please continue with Google.' });

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await pool.query(
      `UPDATE "Users"
       SET reset_otp_hash = $2,
           reset_expires_at = $3,
           reset_attempts = 0,
           reset_in_progress = true,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id, otpHash, expiresAt]
    );

    let emailSent = false;
    try {
      emailSent = await sendOtpEmail(email, otp);
    } catch {
      emailSent = false;
    }

    return res.json({ ok: true, emailSent });
  } catch (error) {
    return res.status(500).json({ error: 'Could not start reset', detail: String(error.message || error) });
  }
});

async function verifyReset(email, otp, incrementOnFailure) {
  const result = await pool.query(
    `SELECT id, reset_otp_hash, reset_expires_at, reset_attempts, reset_in_progress
     FROM "Users"
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [email]
  );

  const user = result.rows[0];
  if (!user || !user.reset_in_progress) return { ok: false, status: 400, error: 'No reset in progress' };
  if (Number(user.reset_attempts || 0) >= MAX_VERIFY_ATTEMPTS) return { ok: false, status: 429, error: 'Too many attempts' };
  if (!user.reset_expires_at || new Date(user.reset_expires_at) < new Date()) return { ok: false, status: 400, error: 'OTP expired' };

  const valid = await bcrypt.compare(String(otp), user.reset_otp_hash || '');
  if (!valid && incrementOnFailure) {
    await pool.query(`UPDATE "Users" SET reset_attempts = reset_attempts + 1, updated_at = NOW() WHERE id = $1`, [user.id]);
  }

  return valid ? { ok: true, user } : { ok: false, status: 400, error: 'Invalid OTP' };
}

router.post('/forgot/verify', async (req, res) => {
  const email = lower(req.body?.email);
  const otp = text(req.body?.otp);
  if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });

  try {
    const result = await verifyReset(email, otp, true);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Verification failed', detail: String(error.message || error) });
  }
});

router.post('/forgot/reset', async (req, res) => {
  const email = lower(req.body?.email);
  const otp = text(req.body?.otp);
  const newPassword = String(req.body?.newPassword || '');

  if (!email || !otp || !newPassword) return res.status(400).json({ error: 'email, otp and newPassword are required' });
  if (newPassword.length < 6) return res.status(422).json({ error: 'Password must be at least 6 characters' });

  try {
    const verified = await verifyReset(email, otp, true);
    if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE "Users"
       SET password = $2,
           auth_provider = CASE WHEN auth_provider IS NULL OR auth_provider = '' THEN 'local' ELSE auth_provider END,
           reset_otp_hash = null,
           reset_expires_at = null,
           reset_attempts = 0,
           reset_in_progress = false,
           updated_at = NOW()
       WHERE id = $1`,
      [verified.user.id, hashed]
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Reset failed', detail: String(error.message || error) });
  }
});

router.get('/email/test', async (req, res) => {
  try {
    if (!smtpConfigured) return res.json({ ok: true, emailSent: false, smtpConfigured: false });
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: req.query.to || process.env.SMTP_USER,
      subject: 'Test Email',
      text: 'If you see this, your SMTP setup works.'
    });
    return res.json({ ok: true, emailSent: Boolean(info.messageId), smtpConfigured: true });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

module.exports = router;
