require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('./lib/db');

const app = express();

// ─────────────────────────────────────────────
// Stripe webhook route (needs raw body — must be before other body parsers)
// ─────────────────────────────────────────────
const { handleStripeWebhook } = require('./routes/billing');
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session (stored in PostgreSQL)
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    secure: process.env.NODE_ENV === 'production' ? true : false,
    sameSite: 'lax'
  }
}));

// Trust Railway's proxy for secure cookies
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const checkinRoutes = require('./routes/checkin');
const { router: billingRoutes } = require('./routes/billing');
const passwordResetRoutes = require('./routes/password-reset');

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/', checkinRoutes);
app.use('/', billingRoutes);
app.use('/', passwordResetRoutes);

// ─────────────────────────────────────────────
// Root route — Landing page or dashboard redirect
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.accountId) {
    return res.redirect('/dashboard');
  }
  res.send(landingPage());
});

// ─────────────────────────────────────────────
// 404
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fc;}
.msg{max-width:400px;}.msg h1{font-size:72px;margin-bottom:8px;}.msg p{color:#718096;font-size:16px;}.msg a{color:#e94560;}</style></head>
<body><div class="msg"><h1>404</h1><p>Page not found.</p><p><a href="/" style="color:#e94560">Go home</a></p></div></body></html>`);
});

// ─────────────────────────────────────────────
// Landing page template
// ─────────────────────────────────────────────
function landingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NoFrontDesk — Automated Guest Check-In for Vacation Rentals</title>
  <meta name="description" content="Automate guest check-in, ID verification, payments, and smart lock access for your vacation rental properties.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fc; color: #1a202c; }

    /* ── Nav ── */
    nav { display: flex; align-items: center; justify-content: space-between; padding: 18px 40px; background: white; border-bottom: 1px solid #e2e8f0; position: sticky; top: 0; z-index: 100; }
    .nav-logo { font-size: 22px; font-weight: 800; text-decoration: none; color: #1a202c; }
    .nav-logo span { color: #e94560; }
    .nav-links { display: flex; align-items: center; gap: 12px; }
    .nav-links a { text-decoration: none; font-size: 15px; font-weight: 600; padding: 10px 20px; border-radius: 8px; transition: all 0.2s; }
    .btn-login { color: #4a5568; background: transparent; }
    .btn-login:hover { background: #f1f5f9; color: #1a202c; }
    .btn-register { color: white; background: #e94560; }
    .btn-register:hover { background: #d63851; }

    /* ── Hero ── */
    .hero { text-align: center; padding: 80px 20px 60px; max-width: 800px; margin: 0 auto; }
    .hero h1 { font-size: 48px; font-weight: 800; line-height: 1.15; margin-bottom: 20px; }
    .hero h1 span { color: #e94560; }
    .hero p { font-size: 19px; color: #718096; line-height: 1.6; margin-bottom: 36px; max-width: 600px; margin-left: auto; margin-right: auto; }
    .hero-cta { display: inline-flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
    .hero-cta a { text-decoration: none; font-size: 16px; font-weight: 600; padding: 14px 32px; border-radius: 10px; transition: all 0.2s; }
    .cta-primary { color: white; background: #e94560; }
    .cta-primary:hover { background: #d63851; transform: translateY(-1px); box-shadow: 0 4px 14px rgba(233,69,96,0.3); }
    .cta-secondary { color: #e94560; background: white; border: 2px solid #e94560; }
    .cta-secondary:hover { background: #fff5f7; }

    /* ── Demo Video ── */
    .demo-video { padding: 20px 40px 80px; max-width: 1100px; margin: 0 auto; text-align: center; }
    .demo-video h2 { font-size: 32px; font-weight: 700; margin-bottom: 12px; }
    .demo-sub { font-size: 17px; color: #718096; margin-bottom: 36px; }
    .demo-container { position: relative; width: 100%; max-width: 960px; margin: 0 auto; aspect-ratio: 16/9; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 40px rgba(0,0,0,0.12); background: #0a0a0a; }
    .demo-container iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }

    /* ── Features ── */
    .features { padding: 60px 40px 80px; max-width: 1100px; margin: 0 auto; }
    .features h2 { text-align: center; font-size: 32px; font-weight: 700; margin-bottom: 48px; }
    .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 28px; }
    .feature-card { background: white; border-radius: 14px; padding: 32px 28px; box-shadow: 0 2px 12px rgba(0,0,0,0.05); transition: transform 0.2s, box-shadow 0.2s; }
    .feature-card:hover { transform: translateY(-3px); box-shadow: 0 6px 24px rgba(0,0,0,0.08); }
    .feature-icon { font-size: 32px; margin-bottom: 14px; }
    .feature-card h3 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    .feature-card p { font-size: 15px; color: #718096; line-height: 1.55; }

    /* ── Footer ── */
    footer { text-align: center; padding: 32px 20px; color: #a0aec0; font-size: 14px; border-top: 1px solid #e2e8f0; }

    @media (max-width: 640px) {
      nav { padding: 14px 20px; }
      .hero h1 { font-size: 32px; }
      .hero p { font-size: 16px; }
      .features { padding: 40px 20px; }
      .demo-video { padding: 20px 20px 60px; }
    }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="nav-logo">No<span>FrontDesk</span></a>
    <div class="nav-links">
      <a href="/login" class="btn-login">Log In</a>
      <a href="/register" class="btn-register">Sign Up Free</a>
    </div>
  </nav>

  <section class="hero">
    <h1>Automate Your Guest<br><span>Check-In Experience</span></h1>
    <p>Collect guest info, verify IDs, send access codes, and process payments — all before your guests arrive. Works with 10+ property management systems.</p>
    <div class="hero-cta">
      <a href="/register" class="cta-primary">Start Free 14-Day Trial</a>
      <a href="/login" class="cta-secondary">Log In</a>
    </div>
  </section>

  <section class="demo-video">
    <h2>See How It Works</h2>
    <p class="demo-sub">Guests scan a QR code, type their last name, and check themselves in — in under 90 seconds.</p>
    <div class="demo-container">
      <iframe src="/explainer.html" allowfullscreen></iframe>
    </div>
  </section>

  <section class="features">
    <h2>Everything You Need to Go Front-Desk Free</h2>
    <div class="feature-grid">
      <div class="feature-card">
        <div class="feature-icon">&#128274;</div>
        <h3>Online Check-In</h3>
        <p>Branded check-in forms that collect guest details, signatures, and house rule acknowledgements before arrival.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128179;</div>
        <h3>ID Verification</h3>
        <p>Collect government ID photos and selfie matches for security and compliance with local regulations.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128176;</div>
        <h3>Payment Automation</h3>
        <p>Security deposits, damage waivers, and balance collection via Stripe — fully automated with retry logic.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128273;</div>
        <h3>Smart Lock Codes</h3>
        <p>Auto-generate and send door codes to guests. Integrates with RemoteLock, August, Yale, and more.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128172;</div>
        <h3>Multi-Channel Messaging</h3>
        <p>Send check-in links and updates via email, SMS, or WhatsApp — automatically at the right time.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#127968;</div>
        <h3>Digital Guidebook</h3>
        <p>Give guests a beautiful portal with WiFi info, house manual, local recommendations, and more.</p>
      </div>
    </div>
  </section>

  <footer>
    &copy; ${new Date().getFullYear()} NoFrontDesk. All rights reserved.
  </footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NoFrontDesk running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
