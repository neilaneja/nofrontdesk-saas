const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');

const router = express.Router();

// ─────────────────────────────────────────────
// Helper: escape HTML
// ─────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// Helper: send reset email (using nodemailer if configured,
// otherwise log token for manual reset)
// ─────────────────────────────────────────────
async function sendResetEmail(email, token, baseUrl) {
  const resetLink = `${baseUrl}/reset-password?token=${token}`;

  // If SMTP is configured, send a real email
  if (process.env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'NoFrontDesk <hello@nofrontdesk.com>',
      to: email,
      subject: 'Reset your NoFrontDesk password',
      html: `
        <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#1a1a2e;font-size:22px;">Reset Your Password</h2>
          <p style="color:#4a5568;font-size:15px;line-height:1.6;">
            We received a request to reset your NoFrontDesk password. Click the button below to set a new password. This link expires in 1 hour.
          </p>
          <a href="${resetLink}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#e94560;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
            Reset Password
          </a>
          <p style="color:#a0aec0;font-size:13px;margin-top:24px;">
            If you didn't request this, you can safely ignore this email. Your password won't change.
          </p>
          <hr style="margin-top:32px;border:none;border-top:1px solid #e2e8f0;">
          <p style="color:#a0aec0;font-size:12px;margin-top:16px;">NoFrontDesk — Contactless Check-In for Vacation Rentals</p>
        </div>
      `,
    });
    return true;
  }

  // Fallback: log the token (useful during development)
  console.log(`\n[PASSWORD RESET] Email: ${email}`);
  console.log(`[PASSWORD RESET] Link: ${resetLink}\n`);
  return false;
}

// ─────────────────────────────────────────────
// GET /forgot-password — Show forgot form
// ─────────────────────────────────────────────
router.get('/forgot-password', (req, res) => {
  res.send(forgotPage());
});

// ─────────────────────────────────────────────
// POST /forgot-password — Generate reset token
// ─────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.send(forgotPage('Please enter your email address.'));
  }

  try {
    // Always show success message to prevent email enumeration
    const successMsg = 'If an account with that email exists, we\'ve sent a password reset link. Check your inbox.';

    const accountRes = await db.query('SELECT id FROM accounts WHERE email = $1', [email.toLowerCase().trim()]);
    if (accountRes.rows.length === 0) {
      return res.send(forgotPage('', successMsg));
    }

    const accountId = accountRes.rows[0].id;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store the reset token
    await db.query(
      `INSERT INTO password_resets (account_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET token = $2, expires_at = $3, created_at = NOW()`,
      [accountId, token, expiresAt]
    );

    const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
    const emailSent = await sendResetEmail(email.toLowerCase().trim(), token, baseUrl);

    if (!emailSent) {
      // In development mode without SMTP, show the link directly
      if (process.env.NODE_ENV !== 'production') {
        return res.send(forgotPage('', `Development mode: <a href="/reset-password?token=${token}">Click here to reset</a>`));
      }
    }

    res.send(forgotPage('', successMsg));
  } catch (err) {
    console.error('Forgot password error:', err);
    res.send(forgotPage('Something went wrong. Please try again.'));
  }
});

// ─────────────────────────────────────────────
// GET /reset-password — Show reset form
// ─────────────────────────────────────────────
router.get('/reset-password', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.send(resetPage('', 'Invalid or missing reset link. <a href="/forgot-password">Request a new one.</a>'));
  }

  // Validate token
  const result = await db.query(
    'SELECT account_id FROM password_resets WHERE token = $1 AND expires_at > NOW()',
    [token]
  );

  if (result.rows.length === 0) {
    return res.send(resetPage('', 'This reset link has expired or is invalid. <a href="/forgot-password">Request a new one.</a>'));
  }

  res.send(resetPage(token));
});

// ─────────────────────────────────────────────
// POST /reset-password — Update password
// ─────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password, passwordConfirm } = req.body;

  if (!token) {
    return res.send(resetPage('', 'Invalid reset request.'));
  }

  if (!password || password.length < 8) {
    return res.send(resetPage(token, 'Password must be at least 8 characters.'));
  }

  if (password !== passwordConfirm) {
    return res.send(resetPage(token, 'Passwords do not match.'));
  }

  try {
    const result = await db.query(
      'SELECT account_id FROM password_resets WHERE token = $1 AND expires_at > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.send(resetPage('', 'This reset link has expired. <a href="/forgot-password">Request a new one.</a>'));
    }

    const accountId = result.rows[0].account_id;
    const hash = await bcrypt.hash(password, 12);

    // Update password
    await db.query('UPDATE accounts SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, accountId]);

    // Delete used token
    await db.query('DELETE FROM password_resets WHERE account_id = $1', [accountId]);

    res.send(resetSuccessPage());
  } catch (err) {
    console.error('Reset password error:', err);
    res.send(resetPage(token, 'Something went wrong. Please try again.'));
  }
});

// ─────────────────────────────────────────────
// Page Templates
// ─────────────────────────────────────────────
function authLayout(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — NoFrontDesk</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; color: #1a1a2e; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .auth-card { background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); padding: 40px 36px; width: 100%; max-width: 420px; margin: 20px; }
  .logo { font-size: 24px; font-weight: 800; text-align: center; margin-bottom: 8px; }
  .logo span { color: #e94560; }
  .auth-subtitle { text-align: center; color: #718096; font-size: 15px; margin-bottom: 28px; }
  .form-group { margin-bottom: 18px; }
  .form-group label { display: block; font-size: 14px; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
  .form-group input { width: 100%; padding: 12px 14px; font-size: 15px; border: 2px solid #e2e8f0; border-radius: 10px; outline: none; transition: border-color 0.2s; }
  .form-group input:focus { border-color: #e94560; }
  .btn { display: block; width: 100%; padding: 14px; font-size: 16px; font-weight: 600; color: white; background: #e94560; border: none; border-radius: 10px; cursor: pointer; margin-top: 24px; transition: background 0.2s; }
  .btn:hover { background: #d63851; }
  .error-msg { background: #fff5f5; color: #e53e3e; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #fed7d7; }
  .success-msg { background: #f0fff4; color: #38a169; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #c6f6d5; }
  .success-msg a { color: #38a169; font-weight: 600; }
  .switch { text-align: center; margin-top: 20px; font-size: 14px; color: #718096; }
  .switch a { color: #e94560; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<div class="auth-card">
  ${content}
</div>
</body>
</html>`;
}

function forgotPage(error = '', success = '') {
  return authLayout('Forgot Password', `
    <div class="logo">No<span>FrontDesk</span></div>
    <div class="auth-subtitle">Enter your email and we'll send you a reset link.</div>
    ${error ? `<div class="error-msg">${error}</div>` : ''}
    ${success ? `<div class="success-msg">${success}</div>` : ''}
    <form method="POST" action="/forgot-password">
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="you@company.com" required>
      </div>
      <button type="submit" class="btn">Send Reset Link</button>
    </form>
    <div class="switch"><a href="/login">Back to login</a></div>
  `);
}

function resetPage(token, error = '') {
  return authLayout('Reset Password', `
    <div class="logo">No<span>FrontDesk</span></div>
    <div class="auth-subtitle">Choose a new password for your account.</div>
    ${error ? `<div class="error-msg">${error}</div>` : ''}
    ${token ? `
    <form method="POST" action="/reset-password">
      <input type="hidden" name="token" value="${esc(token)}">
      <div class="form-group">
        <label>New Password</label>
        <input type="password" name="password" placeholder="At least 8 characters" minlength="8" required>
      </div>
      <div class="form-group">
        <label>Confirm Password</label>
        <input type="password" name="passwordConfirm" placeholder="Type it again" minlength="8" required>
      </div>
      <button type="submit" class="btn">Reset Password</button>
    </form>
    ` : ''}
    <div class="switch"><a href="/login">Back to login</a></div>
  `);
}

function resetSuccessPage() {
  return authLayout('Password Reset', `
    <div class="logo">No<span>FrontDesk</span></div>
    <div class="success-msg">Your password has been reset successfully.</div>
    <div class="switch" style="margin-top:12px;"><a href="/login">Log in with your new password</a></div>
  `);
}

module.exports = router;
