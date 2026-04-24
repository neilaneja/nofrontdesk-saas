require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const db = require('./lib/db');

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
  store: new PgSession({ pool: db, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: process.env.NODE_ENV === 'production' ? true : false,
    sameSite: 'lax',
  },
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
// Root route
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.accountId) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

// ─────────────────────────────────────────────
// 404
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not Found</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fc;color:#1a1a2e;text-align:center;padding:20px;}
.msg{max-width:400px;}.msg h1{font-size:72px;margin-bottom:8px;}.msg p{color:#718096;font-size:16px;}</style></head>
<body><div class="msg"><h1>404</h1><p>Page not found.</p><p><a href="/" style="color:#e94560">Go home</a></p></div></body></html>`);
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NoFrontDesk running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
