const express = require('express');
const db = require('../lib/db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();

// All dashboard routes require login
router.use(requireLogin);

// ─────────────────────────────────────────────
// Helper: slugify a property name
// ─────────────────────────────────────────────
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 80);
}

// ─────────────────────────────────────────────
// Helper: escape HTML to prevent XSS
// ─────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// GET /dashboard — Main dashboard
// ─────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const accountId = req.session.accountId;

  const [accountRes, propertiesRes, credRes, statsRes] = await Promise.all([
    db.query('SELECT * FROM accounts WHERE id = $1', [accountId]),
    db.query('SELECT * FROM properties WHERE account_id = $1 ORDER BY created_at', [accountId]),
    db.query('SELECT id FROM api_credentials WHERE account_id = $1', [accountId]),
    db.query(`SELECT COUNT(*) as total,
              COUNT(CASE WHEN result = 'found' THEN 1 END) as successful,
              COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as last_7_days
              FROM checkin_logs WHERE account_id = $1`, [accountId]),
  ]);

  const account = accountRes.rows[0];
  const properties = propertiesRes.rows;
  const hasCredentials = credRes.rows.length > 0;
  const stats = statsRes.rows[0];
  const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;

  res.send(dashboardLayout(account, `
    <!-- Setup checklist -->
    ${!hasCredentials || properties.length === 0 ? `
    <div class="setup-banner">
      <h3>Get Started</h3>
      <div class="setup-steps">
        <div class="setup-step ${hasCredentials ? 'done' : ''}">
          <span class="step-num">${hasCredentials ? '&#10003;' : '1'}</span>
          <a href="/dashboard/credentials">${hasCredentials ? 'Guesty connected' : 'Connect your Guesty account'}</a>
        </div>
        <div class="setup-step ${properties.length > 0 ? 'done' : ''}">
          <span class="step-num">${properties.length > 0 ? '&#10003;' : '2'}</span>
          <a href="/dashboard/properties/add">${properties.length > 0 ? 'Property added' : 'Add your first property'}</a>
        </div>
        <div class="setup-step">
          <span class="step-num">3</span>
          <span>Print QR code signs and place at your properties</span>
        </div>
      </div>
    </div>` : ''}

    <!-- Stats -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-num">${properties.length}</div>
        <div class="stat-label">Properties</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${stats.last_7_days || 0}</div>
        <div class="stat-label">Check-ins (7 days)</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${stats.total || 0}</div>
        <div class="stat-label">Total Check-ins</div>
      </div>
    </div>

    <!-- Properties -->
    <div class="section-header">
      <h2>Your Properties</h2>
      <a href="/dashboard/properties/add" class="btn btn-sm">+ Add Property</a>
    </div>

    ${properties.length === 0 ? `
      <div class="empty-state">
        <p>No properties yet. <a href="/dashboard/properties/add">Add your first property</a> to get started.</p>
      </div>
    ` : properties.map(p => `
      <div class="property-card">
        <div class="property-info">
          <div class="property-color" style="background:${esc(p.brand_color)}"></div>
          <div>
            <div class="property-name">${esc(p.name)}</div>
            <div class="property-url">${esc(baseUrl)}/c/${esc(account.slug)}/${esc(p.slug)}</div>
          </div>
        </div>
        <div class="property-actions">
          <a href="/c/${esc(account.slug)}/${esc(p.slug)}" target="_blank" class="action-link">Preview</a>
          <a href="/dashboard/signage/${p.id}" target="_blank" class="action-link">QR Sign</a>
          <a href="/dashboard/properties/${p.id}/edit" class="action-link">Edit</a>
        </div>
      </div>
    `).join('')}
  `));
});

// ─────────────────────────────────────────────
// GET /dashboard/credentials — Guesty API setup
// ─────────────────────────────────────────────
router.get('/dashboard/credentials', async (req, res) => {
  const cred = await db.query('SELECT guesty_client_id FROM api_credentials WHERE account_id = $1', [req.session.accountId]);
  const existing = cred.rows[0];

  res.send(dashboardLayout({ company_name: req.session.companyName }, `
    <h2>Guesty API Credentials</h2>
    <p class="section-desc">Connect your Guesty account so NoFrontDesk can look up guest reservations. You can find these in your Guesty Dashboard under Marketplace → Open API.</p>

    ${existing ? `<div class="success-msg">Connected — Client ID: ${esc(existing.guesty_client_id.substring(0, 8))}...</div>` : ''}

    <form method="POST" action="/dashboard/credentials" class="form-card">
      <div class="form-group">
        <label>Guesty Client ID</label>
        <input type="text" name="clientId" placeholder="e.g. 0oau2xzv9sWPd9Evh5d7" value="${existing ? esc(existing.guesty_client_id) : ''}" required>
      </div>
      <div class="form-group">
        <label>Guesty Client Secret</label>
        <input type="password" name="clientSecret" placeholder="${existing ? '••••••••••• (leave blank to keep current)' : 'Paste your client secret'}" ${existing ? '' : 'required'}>
      </div>
      <button type="submit" class="btn">${existing ? 'Update Credentials' : 'Connect Guesty'}</button>
    </form>

    <div class="help-text">
      <strong>Where to find these:</strong><br>
      1. Log into your <a href="https://app.guesty.com" target="_blank">Guesty Dashboard</a><br>
      2. Go to Marketplace → Open API<br>
      3. Create or copy your Client ID and Client Secret
    </div>
  `));
});

// ─────────────────────────────────────────────
// POST /dashboard/credentials — Save Guesty creds
// ─────────────────────────────────────────────
router.post('/dashboard/credentials', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  const accountId = req.session.accountId;

  if (!clientId) {
    return res.redirect('/dashboard/credentials');
  }

  try {
    const existing = await db.query('SELECT id FROM api_credentials WHERE account_id = $1', [accountId]);

    if (existing.rows.length > 0) {
      if (clientSecret) {
        await db.query(
          'UPDATE api_credentials SET guesty_client_id = $1, guesty_client_secret = $2, updated_at = NOW() WHERE account_id = $3',
          [clientId.trim(), clientSecret.trim(), accountId]
        );
      } else {
        await db.query(
          'UPDATE api_credentials SET guesty_client_id = $1, updated_at = NOW() WHERE account_id = $2',
          [clientId.trim(), accountId]
        );
      }
    } else {
      if (!clientSecret) {
        return res.redirect('/dashboard/credentials');
      }
      await db.query(
        'INSERT INTO api_credentials (account_id, guesty_client_id, guesty_client_secret) VALUES ($1, $2, $3)',
        [accountId, clientId.trim(), clientSecret.trim()]
      );
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Credentials save error:', err);
    res.redirect('/dashboard/credentials');
  }
});

// ─────────────────────────────────────────────
// GET /dashboard/properties/add — Add property form
// ─────────────────────────────────────────────
router.get('/dashboard/properties/add', (req, res) => {
  res.send(dashboardLayout({ company_name: req.session.companyName }, propertyForm('Add Property', '/dashboard/properties/add', {})));
});

// ─────────────────────────────────────────────
// POST /dashboard/properties/add — Create property
// ─────────────────────────────────────────────
router.post('/dashboard/properties/add', async (req, res) => {
  const { name, welcomeMessage, brandColor, accentColor, fallbackPhone, guestyGuestAppName } = req.body;
  const accountId = req.session.accountId;

  if (!name) {
    return res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Add Property', '/dashboard/properties/add', req.body, 'Property name is required.')));
  }

  try {
    let slug = slugify(name);
    const slugCheck = await db.query(
      'SELECT id FROM properties WHERE account_id = $1 AND slug = $2',
      [accountId, slug]
    );
    if (slugCheck.rows.length > 0) {
      slug = slug + '-' + Date.now().toString(36);
    }

    await db.query(
      `INSERT INTO properties (account_id, name, slug, welcome_message, brand_color, accent_color, fallback_phone, guesty_guest_app_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [accountId, name.trim(), slug, welcomeMessage || 'Welcome!', brandColor || '#2C3E50', accentColor || '#E67E22', fallbackPhone || '', guestyGuestAppName || '']
    );

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Property create error:', err);
    res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Add Property', '/dashboard/properties/add', req.body, 'Something went wrong.')));
  }
});

// ─────────────────────────────────────────────
// GET /dashboard/properties/:id/edit — Edit property
// ─────────────────────────────────────────────
router.get('/dashboard/properties/:id/edit', async (req, res) => {
  const prop = await db.query('SELECT * FROM properties WHERE id = $1 AND account_id = $2', [req.params.id, req.session.accountId]);
  if (prop.rows.length === 0) return res.redirect('/dashboard');

  const p = prop.rows[0];
  res.send(dashboardLayout({ company_name: req.session.companyName },
    propertyForm('Edit Property', `/dashboard/properties/${p.id}/edit`, {
      name: p.name,
      welcomeMessage: p.welcome_message,
      brandColor: p.brand_color,
      accentColor: p.accent_color,
      fallbackPhone: p.fallback_phone,
      guestyGuestAppName: p.guesty_guest_app_name,
    })
  ));
});

// ─────────────────────────────────────────────
// POST /dashboard/properties/:id/edit — Update property
// ─────────────────────────────────────────────
router.post('/dashboard/properties/:id/edit', async (req, res) => {
  const { name, welcomeMessage, brandColor, accentColor, fallbackPhone, guestyGuestAppName } = req.body;
  const accountId = req.session.accountId;

  if (!name) {
    return res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Edit Property', `/dashboard/properties/${req.params.id}/edit`, req.body, 'Property name is required.')));
  }

  try {
    await db.query(
      `UPDATE properties SET name = $1, welcome_message = $2, brand_color = $3, accent_color = $4, fallback_phone = $5, guesty_guest_app_name = $6, updated_at = NOW()
       WHERE id = $7 AND account_id = $8`,
      [name.trim(), welcomeMessage || 'Welcome!', brandColor || '#2C3E50', accentColor || '#E67E22', fallbackPhone || '', guestyGuestAppName || '', req.params.id, accountId]
    );
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Property update error:', err);
    res.redirect('/dashboard');
  }
});

// ─────────────────────────────────────────────
// GET /dashboard/signage/:id — QR code sign
// ─────────────────────────────────────────────
router.get('/dashboard/signage/:id', async (req, res) => {
  const propRes = await db.query('SELECT p.*, a.slug as account_slug FROM properties p JOIN accounts a ON p.account_id = a.id WHERE p.id = $1 AND p.account_id = $2', [req.params.id, req.session.accountId]);
  if (propRes.rows.length === 0) return res.redirect('/dashboard');

  const p = propRes.rows[0];
  const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
  const checkinUrl = `${baseUrl}/c/${p.account_slug}/${p.slug}`;

  res.send(signagePage(p, checkinUrl));
});

// ─────────────────────────────────────────────
// Page Templates
// ─────────────────────────────────────────────
function dashboardLayout(account, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard — NoFrontDesk</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; color: #1a1a2e; }

  /* Nav */
  .topnav { background: #1a1a2e; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
  .topnav .logo { color: white; font-size: 20px; font-weight: 800; text-decoration: none; }
  .topnav .logo span { color: #e94560; }
  .topnav-right { display: flex; align-items: center; gap: 20px; }
  .topnav-right a { color: #a0aec0; text-decoration: none; font-size: 14px; }
  .topnav-right a:hover { color: white; }
  .company-badge { color: #e2e8f0; font-size: 14px; font-weight: 500; }

  /* Layout */
  .main { max-width: 900px; margin: 0 auto; padding: 32px 24px; }

  /* Setup banner */
  .setup-banner { background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-left: 4px solid #e94560; }
  .setup-banner h3 { font-size: 18px; margin-bottom: 16px; }
  .setup-steps { display: flex; flex-direction: column; gap: 10px; }
  .setup-step { display: flex; align-items: center; gap: 12px; font-size: 15px; }
  .setup-step.done { color: #38a169; }
  .setup-step a { color: #e94560; text-decoration: none; font-weight: 600; }
  .step-num { width: 28px; height: 28px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
  .setup-step.done .step-num { background: #c6f6d5; color: #38a169; }

  /* Stats */
  .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .stat-num { font-size: 32px; font-weight: 800; color: #1a1a2e; }
  .stat-label { font-size: 13px; color: #718096; margin-top: 4px; font-weight: 500; }

  /* Section header */
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .section-header h2 { font-size: 20px; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; padding: 10px 20px; background: #e94560; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: background 0.2s; }
  .btn:hover { background: #d63851; }
  .btn-sm { padding: 8px 16px; font-size: 13px; }
  .btn-outline { background: transparent; color: #1a1a2e; border: 2px solid #e2e8f0; }
  .btn-outline:hover { border-color: #1a1a2e; }

  /* Property cards */
  .property-card { background: white; border-radius: 12px; padding: 18px 20px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); display: flex; align-items: center; justify-content: space-between; }
  .property-info { display: flex; align-items: center; gap: 14px; }
  .property-color { width: 12px; height: 40px; border-radius: 6px; flex-shrink: 0; }
  .property-name { font-size: 16px; font-weight: 600; }
  .property-url { font-size: 13px; color: #718096; margin-top: 2px; word-break: break-all; }
  .property-actions { display: flex; gap: 12px; }
  .action-link { font-size: 13px; color: #e94560; text-decoration: none; font-weight: 600; white-space: nowrap; }

  /* Empty state */
  .empty-state { background: white; border-radius: 12px; padding: 40px; text-align: center; color: #718096; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .empty-state a { color: #e94560; text-decoration: none; font-weight: 600; }

  /* Forms */
  .form-card { background: white; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); margin-top: 16px; }
  .form-group { margin-bottom: 18px; }
  .form-group label { display: block; font-size: 14px; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
  .form-group input, .form-group textarea { width: 100%; padding: 10px 14px; font-size: 15px; border: 2px solid #e2e8f0; border-radius: 8px; outline: none; font-family: inherit; }
  .form-group input:focus, .form-group textarea:focus { border-color: #e94560; }
  .form-group .hint { font-size: 12px; color: #a0aec0; margin-top: 4px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .color-preview { display: inline-block; width: 24px; height: 24px; border-radius: 6px; vertical-align: middle; margin-left: 8px; border: 1px solid #e2e8f0; }

  /* Messages */
  .error-msg { background: #fff5f5; color: #e53e3e; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #fed7d7; }
  .success-msg { background: #f0fff4; color: #38a169; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #c6f6d5; }
  .section-desc { color: #718096; font-size: 15px; margin-bottom: 16px; line-height: 1.6; }
  .help-text { margin-top: 20px; padding: 16px; background: #f7fafc; border-radius: 8px; font-size: 14px; line-height: 1.7; color: #4a5568; }
  .help-text a { color: #e94560; }

  @media (max-width: 640px) {
    .stats-row { grid-template-columns: 1fr; }
    .property-card { flex-direction: column; align-items: flex-start; gap: 12px; }
    .form-row { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<nav class="topnav">
  <a href="/dashboard" class="logo">No<span>FrontDesk</span></a>
  <div class="topnav-right">
    <span class="company-badge">${esc(account.company_name)}</span>
    <a href="/dashboard/credentials">Guesty API</a>
    <a href="/logout">Log out</a>
  </div>
</nav>
<div class="main">
  ${content}
</div>
</body>
</html>`;
}

function propertyForm(title, action, data, error = '') {
  return `
    <h2>${title}</h2>
    ${error ? `<div class="error-msg">${error}</div>` : ''}
    <form method="POST" action="${action}" class="form-card">
      <div class="form-group">
        <label>Property Name</label>
        <input type="text" name="name" placeholder="e.g. Sunset Beach Villa" value="${esc(data.name || '')}" required>
      </div>
      <div class="form-group">
        <label>Welcome Message</label>
        <input type="text" name="welcomeMessage" placeholder="e.g. Welcome to Sunset Beach Villa!" value="${esc(data.welcomeMessage || data.welcome_message || '')}">
        <div class="hint">Shown on the check-in page header</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Brand Color <span class="color-preview" id="brandPreview" style="background:${esc(data.brandColor || data.brand_color || '#2C3E50')}"></span></label>
          <input type="color" name="brandColor" value="${esc(data.brandColor || data.brand_color || '#2C3E50')}" onchange="document.getElementById('brandPreview').style.background=this.value">
        </div>
        <div class="form-group">
          <label>Accent Color <span class="color-preview" id="accentPreview" style="background:${esc(data.accentColor || data.accent_color || '#E67E22')}"></span></label>
          <input type="color" name="accentColor" value="${esc(data.accentColor || data.accent_color || '#E67E22')}" onchange="document.getElementById('accentPreview').style.background=this.value">
        </div>
      </div>
      <div class="form-group">
        <label>Fallback Phone Number</label>
        <input type="tel" name="fallbackPhone" placeholder="e.g. (555) 123-4567" value="${esc(data.fallbackPhone || data.fallback_phone || '')}">
        <div class="hint">Shown if check-in system has an error</div>
      </div>
      <div class="form-group">
        <label>Guesty Guest App Name</label>
        <input type="text" name="guestyGuestAppName" placeholder="e.g. west_end_flats" value="${esc(data.guestyGuestAppName || data.guesty_guest_app_name || '')}">
        <div class="hint">The name of your Guesty Guest App (used to build check-in URLs)</div>
      </div>
      <button type="submit" class="btn">${title === 'Add Property' ? 'Add Property' : 'Save Changes'}</button>
      <a href="/dashboard" style="margin-left:16px;color:#718096;text-decoration:none;font-size:14px;">Cancel</a>
    </form>
  `;
}

function signagePage(property, checkinUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QR Sign — ${esc(property.name)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; display: flex; justify-content: center; padding: 40px 20px; }
  .sign { background: white; border-radius: 20px; padding: 48px 40px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
  .sign-title { font-size: 28px; font-weight: 800; color: ${esc(property.brand_color)}; margin-bottom: 8px; }
  .sign-subtitle { font-size: 18px; color: #718096; margin-bottom: 32px; }
  #qrcode { display: flex; justify-content: center; margin-bottom: 24px; }
  .sign-url { font-size: 14px; color: #a0aec0; word-break: break-all; margin-bottom: 24px; }
  .sign-instructions { font-size: 16px; color: #4a5568; line-height: 1.7; margin-bottom: 24px; }
  .sign-phone { font-size: 15px; color: #718096; }
  .sign-phone strong { color: #1a1a2e; }
  .print-btn { display: inline-block; padding: 12px 28px; background: ${esc(property.brand_color)}; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 24px; }
  @media print { .print-btn { display: none; } body { background: white; padding: 0; } .sign { box-shadow: none; border-radius: 0; } }
</style>
</head>
<body>
<div class="sign">
  <div class="sign-title">${esc(property.name)}</div>
  <div class="sign-subtitle">Self Check-In</div>
  <div id="qrcode"></div>
  <div class="sign-url">${esc(checkinUrl)}</div>
  <div class="sign-instructions">
    <strong>To check in:</strong><br>
    1. Scan the QR code with your phone camera<br>
    2. Enter your last name<br>
    3. Follow the instructions on screen
  </div>
  ${property.fallback_phone ? `<div class="sign-phone">Need help? Call <strong>${esc(property.fallback_phone)}</strong></div>` : ''}
  <button class="print-btn" onclick="window.print()">Print Sign</button>
</div>
<script>
  new QRCode(document.getElementById('qrcode'), {
    text: '${checkinUrl}',
    width: 200,
    height: 200,
    colorDark: '${property.brand_color}',
    correctLevel: QRCode.CorrectLevel.M,
  });
</script>
</body>
</html>`;
}

module.exports = router;
