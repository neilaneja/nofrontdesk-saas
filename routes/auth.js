const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { requireGuest } = require('../lib/auth');

const router = express.Router();

// ─────────────────────────────────────────────
// Helper: generate a URL-safe slug from company name
// ─────────────────────────────────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

// ─────────────────────────────────────────────
// GET /register
// ─────────────────────────────────────────────
router.get('/register', requireGuest, (req, res) => {
  res.send(registerPage());
});

// ─────────────────────────────────────────────
// POST /register
// ─────────────────────────────────────────────
router.post('/register', requireGuest, async (req, res) => {
  const { email, password, companyName } = req.body;

  if (!email || !password || !companyName) {
    return res.send(registerPage('All fields are required.'));
  }
  if (password.length < 8) {
    return res.send(registerPage('Password must be at least 8 characters.'));
  }

  try {
    // Check for existing account
    const existing = await db.query('SELECT id FROM accounts WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      return res.send(registerPage('An account with this email already exists.'));
    }

    // Create slug and ensure uniqueness
    let slug = slugify(companyName);
    const slugCheck = await db.query('SELECT id FROM accounts WHERE slug = $1', [slug]);
    if (slugCheck.rows.length > 0) {
      slug = slug + '-' + Date.now().toString(36);
    }

    // Hash password and create account
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO accounts (email, password_hash, company_name, slug)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [email.toLowerCase().trim(), hash, companyName.trim(), slug]
    );

    // Log them in
    req.session.accountId = result.rows[0].id;
    req.session.accountSlug = slug;
    req.session.companyName = companyName.trim();
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Registration error:', err);
    res.send(registerPage('Something went wrong. Please try again.'));
  }
});

// ─────────────────────────────────────────────
// GET /login
// ─────────────────────────────────────────────
router.get('/login', requireGuest, (req, res) => {
  res.send(loginPage());
});

// ─────────────────────────────────────────────
// POST /login
// ─────────────────────────────────────────────
router.post('/login', requireGuest, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.send(loginPage('Email and password are required.'));
  }

  try {
    const result = await db.query(
      'SELECT id, password_hash, company_name, slug FROM accounts WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.send(loginPage('Invalid email or password.'));
    }

    const account = result.rows[0];
    const valid = await bcrypt.compare(password, account.password_hash);
    if (!valid) {
      return res.send(loginPage('Invalid email or password.'));
    }

    req.session.accountId = account.id;
    req.session.accountSlug = account.slug;
    req.session.companyName = account.company_name;
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.send(loginPage('Something went wrong. Please try again.'));
  }
});

// ─────────────────────────────────────────────
// GET /logout
// ─────────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
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

function registerPage(error = '') {
  return authLayout('Sign Up', `
    <div class="logo">No<span>FrontDesk</span></div>
    <div class="auth-subtitle">Create your account and start your 14-day free trial.</div>
    ${error ? `<div class="error-msg">${error}</div>` : ''}
    <form method="POST" action="/register">
      <div class="form-group">
        <label>Company Name</label>
        <input type="text" name="companyName" placeholder="e.g. Sunset Vacation Rentals" required>
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="you@company.com" required>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" name="password" placeholder="At least 8 characters" minlength="8" required>
      </div>
      <button type="submit" class="btn">Start Free Trial</button>
    </form>
    <div class="switch">Already have an account? <a href="/login">Log in</a></div>
  `);
}

function loginPage(error = '') {
  return authLayout('Log In', `
    <div class="logo">No<span>FrontDesk</span></div>
    <div class="auth-subtitle">Log in to manage your properties.</div>
    ${error ? `<div class="error-msg">${error}</div>` : ''}
    <form method="POST" action="/login">
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="you@company.com" required>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" name="password" required>
      </div>
      <button type="submit" class="btn">Log In</button>
    </form>
    <div class="switch">Don't have an account? <a href="/register">Sign up free</a></div>
  `);
}

module.exports = router;
