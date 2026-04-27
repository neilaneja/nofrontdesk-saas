const express = require('express');
const db = require('../lib/db');
const { requireLogin } = require('../lib/auth');
const { getPMSList } = require('../lib/pms');

const router = express.Router();

// All dashboard routes require login
router.use(requireLogin);

// ---------------------------------------------
// Helper: slugify a property name
// ---------------------------------------------
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 80);
}

// ---------------------------------------------
// Helper: escape HTML to prevent XSS
// ---------------------------------------------
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------
// GET /dashboard - Main dashboard
// ---------------------------------------------
router.get('/dashboard', async (req, res) => {
  const accountId = req.session.accountId;

  const [accountRes, propertiesRes, credRes, statsRes, paymentStatsRes] = await Promise.all([
    db.query('SELECT * FROM accounts WHERE id = $1', [accountId]),
    db.query('SELECT * FROM properties WHERE account_id = $1 ORDER BY created_at', [accountId]),
    db.query('SELECT id, pms_type FROM api_credentials WHERE account_id = $1', [accountId]),
    db.query(`SELECT COUNT(*) as total,
      COUNT(CASE WHEN result = 'found' THEN 1 END) as successful,
      COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as last_7_days
      FROM checkin_logs WHERE account_id = $1`, [accountId]),
    db.query(`SELECT property_id,
      COUNT(*) as total_payments,
      COUNT(CASE WHEN status = 'held' THEN 1 END) as active_holds,
      COUNT(CASE WHEN status IN ('succeeded','captured','paid') THEN 1 END) as completed,
      COUNT(CASE WHEN status IN ('released','refunded') THEN 1 END) as released,
      SUM(CASE WHEN status IN ('held','succeeded','captured','paid') THEN amount_cents ELSE 0 END) as total_amount_cents
      FROM guest_payments WHERE account_id = $1
      GROUP BY property_id`, [accountId]).catch(function() { return { rows: [] }; }),
  ]);

  const account = accountRes.rows[0];
  const properties = propertiesRes.rows;
  const hasCreds = credRes.rows.length > 0;
  const pmsType = hasCreds ? credRes.rows[0].pms_type : null;
  const pmsName = pmsType ? (getPMSList().find(p => p.id === pmsType)?.name || pmsType) : null;
  const stats = statsRes.rows[0];
  // Build payment stats lookup by property_id
  const paymentStatsByProp = {};
  (paymentStatsRes.rows || []).forEach(function(r) { paymentStatsByProp[r.property_id] = r; });
  const baseUrl = process.env.CHECKIN_BASE_URL || process.env.BASE_URL || `https://${req.get('host')}`;

  res.send(dashboardLayout(account, `
    <!-- Setup checklist -->
    ${!hasCreds || properties.length === 0 ? `
    <div class="setup-banner">
      <h3>Get Started</h3>
      <div class="setup-steps">
        <div class="setup-step ${hasCreds ? 'done' : ''}">
          <span class="step-num">${hasCreds ? '&#10003;' : '1'}</span>
          <a href="/dashboard/credentials">${hasCreds ? `${esc(pmsName)} connected` : 'Connect your PMS'}</a>
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
          ${(function() {
            const ps = paymentStatsByProp[p.id];
            if (!ps || ps.total_payments === 0) {
              return p.deposit_enabled ? '<div class="deposit-badge enabled">Deposits enabled</div>' : '';
            }
            const parts = [];
            if (ps.active_holds > 0) parts.push('<span class="badge badge-hold">' + ps.active_holds + ' held</span>');
            if (ps.completed > 0) parts.push('<span class="badge badge-paid">' + ps.completed + ' paid</span>');
            if (ps.released > 0) parts.push('<span class="badge badge-released">' + ps.released + ' released</span>');
            const amt = ps.total_amount_cents ? '
        </div>
      </div>
      <div class="property-actions">
        <a href="/c/${esc(account.slug)}/${esc(p.slug)}" target="_blank" class="action-link">Preview</a>
        <a href="/dashboard/signage/${p.id}" target="_blank" class="action-link">QR Sign</a>
        <a href="/dashboard/embed/${p.id}" class="action-link">Embed</a>
        <a href="/dashboard/properties/${p.id}/edit" class="action-link">Edit</a>
      </div>
    </div>
    `).join('')}
  `));
});

// ---------------------------------------------
// GET /dashboard/credentials - PMS connection setup
// ---------------------------------------------
router.get('/dashboard/credentials', async (req, res) => {
  const cred = await db.query(
    'SELECT pms_type, credentials, guesty_client_id FROM api_credentials WHERE account_id = $1',
    [req.session.accountId]
  );
  const existing = cred.rows[0];
  const pmsList = getPMSList();
  const currentPMS = existing?.pms_type || '';

  res.send(dashboardLayout({ company_name: req.session.companyName }, `
    <h2>PMS Connection</h2>
    <p class="section-desc">Connect your Property Management System so NoFrontDesk can look up guest reservations for contactless check-in.</p>

    ${existing ? `<div class="success-msg">Connected to <strong>${esc(pmsList.find(p => p.id === currentPMS)?.name || currentPMS)}</strong></div>` : ''}

    <form method="POST" action="/dashboard/credentials" class="form-card" id="pmsForm">
      <div class="form-group">
        <label>Select Your PMS</label>
        <div class="pms-grid">
          ${pmsList.map(pms => `
          <label class="pms-option ${currentPMS === pms.id ? 'selected' : ''}">
            <input type="radio" name="pmsType" value="${pms.id}" ${currentPMS === pms.id ? 'checked' : ''} onchange="showPMSFields(this.value)" required>
            <span class="pms-name">${esc(pms.name)}</span>
          </label>
          `).join('')}
        </div>
      </div>

      <!-- Dynamic credential fields per PMS -->
      ${pmsList.map(pms => `
      <div class="pms-fields" id="fields-${pms.id}" style="display:${currentPMS === pms.id ? 'block' : 'none'}">
        ${pms.fields.map(f => `
        <div class="form-group">
          <label>${esc(f.label)}${f.required ? ' *' : ''}</label>
          <input type="${f.type}" name="cred_${pms.id}_${f.key}" placeholder="${existing && currentPMS === pms.id ? '(leave blank to keep current)' : ''}" ${!existing && f.required ? 'required' : ''}>
          ${f.help ? `<div class="hint">${esc(f.help)}</div>` : ''}
        </div>
        `).join('')}
      </div>
      `).join('')}

      <button type="submit" class="btn">${existing ? 'Update Connection' : 'Connect PMS'}</button>
    </form>

    <script>
    function showPMSFields(pmsType) {
      document.querySelectorAll('.pms-fields').forEach(el => el.style.display = 'none');
      document.querySelectorAll('.pms-option').forEach(el => el.classList.remove('selected'));
      const fields = document.getElementById('fields-' + pmsType);
      if (fields) fields.style.display = 'block';
      const selected = document.querySelector('input[value="' + pmsType + '"]');
      if (selected) selected.closest('.pms-option').classList.add('selected');
    }
    </script>
    <style>
      .pms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-top: 8px; }
      .pms-option { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border: 2px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; font-size: 14px; font-weight: 600; }
      .pms-option:hover { border-color: #e94560; }
      .pms-option.selected { border-color: #e94560; background: #fff5f7; }
      .pms-option input[type="radio"] { display: none; }
    </style>
  `));
});

// ---------------------------------------------
// POST /dashboard/credentials - Save PMS credentials
// ---------------------------------------------
router.post('/dashboard/credentials', async (req, res) => {
  const { pmsType } = req.body;
  const accountId = req.session.accountId;

  if (!pmsType) {
    return res.redirect('/dashboard/credentials');
  }

  const pmsList = getPMSList();
  const pmsConfig = pmsList.find(p => p.id === pmsType);
  if (!pmsConfig) {
    return res.redirect('/dashboard/credentials');
  }

  try {
    // Extract credential fields for this PMS type
    const credentials = {};
    let hasNewCreds = false;
    for (const field of pmsConfig.fields) {
      const value = req.body[`cred_${pmsType}_${field.key}`];
      if (value && value.trim()) {
        credentials[field.key] = value.trim();
        hasNewCreds = true;
      }
    }

    const existing = await db.query('SELECT id, credentials FROM api_credentials WHERE account_id = $1', [accountId]);

    if (existing.rows.length > 0) {
      const mergedCreds = hasNewCreds
        ? { ...(existing.rows[0].credentials || {}), ...credentials }
        : existing.rows[0].credentials;

      await db.query(
        'UPDATE api_credentials SET pms_type = $1, credentials = $2, updated_at = NOW() WHERE account_id = $3',
        [pmsType, JSON.stringify(mergedCreds), accountId]
      );
    } else {
      const missingFields = pmsConfig.fields
        .filter(f => f.required && !credentials[f.key])
        .map(f => f.label);

      if (missingFields.length > 0) {
        return res.send(dashboardLayout({ company_name: req.session.companyName }, `
          <h2>PMS Connection</h2>
          <div class="error-msg">Missing required fields: ${missingFields.join(', ')}</div>
          <a href="/dashboard/credentials" class="btn">Go Back</a>
        `));
      }

      await db.query(
        'INSERT INTO api_credentials (account_id, pms_type, credentials) VALUES ($1, $2, $3)',
        [accountId, pmsType, JSON.stringify(credentials)]
      );
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Credentials save error:', err);
    res.redirect('/dashboard/credentials');
  }
});

// ---------------------------------------------
// GET /dashboard/embed/:id - Embed code for a property
// ---------------------------------------------
router.get('/dashboard/embed/:id', async (req, res) => {
  const propRes = await db.query(
    'SELECT p.*, a.slug as account_slug FROM properties p JOIN accounts a ON p.account_id = a.id WHERE p.id = $1 AND p.account_id = $2',
    [req.params.id, req.session.accountId]
  );
  if (propRes.rows.length === 0) return res.redirect('/dashboard');

  const p = propRes.rows[0];
  const baseUrl = process.env.CHECKIN_BASE_URL || process.env.BASE_URL || `https://${req.get('host')}`;
  const checkinUrl = `${baseUrl}/c/${p.account_slug}/${p.slug}`;
  const embedUrl = `${baseUrl}/embed/${p.account_slug}/${p.slug}`;
  const iframeCode = `<iframe src="${embedUrl}" width="100%" height="700" frameborder="0" style="border:none;border-radius:12px;max-width:480px;"></iframe>`;
  const jsSnippet = `<div id="nofrontdesk-checkin"></div>\n<script src="${baseUrl}/embed.js" data-property="${p.account_slug}/${p.slug}"></script>`;

  res.send(dashboardLayout({ company_name: req.session.companyName }, `
    <h2>Embed Check-In - ${esc(p.name)}</h2>
    <p class="section-desc">Add the check-in widget to your own website so guests can check in directly from your site.</p>

    <div class="form-card">
      <h3 style="margin-bottom:12px;">Option 1: iframe Embed</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Copy and paste this code into your website's HTML where you want the check-in form to appear.</p>
      <div class="code-block">
        <code>${esc(iframeCode)}</code>
        <button class="copy-btn" onclick="copyCode(this, '${esc(iframeCode).replace(/'/g, "\\'")}')">Copy</button>
      </div>
    </div>

    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Option 2: JavaScript Widget</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">A lightweight JS snippet that renders the check-in form and handles styling automatically.</p>
      <div class="code-block">
        <code>${esc(jsSnippet)}</code>
        <button class="copy-btn" onclick="copyCode(this, '${esc(jsSnippet).replace(/'/g, "\\'")}')">Copy</button>
      </div>
    </div>

    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Direct Link</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Share this URL directly with guests or link to it from your website.</p>
      <div class="code-block">
        <code>${esc(checkinUrl)}</code>
        <button class="copy-btn" onclick="copyCode(this, '${esc(checkinUrl)}')">Copy</button>
      </div>
    </div>

    ${p.custom_domain ? `
    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Custom Domain</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Your check-in page is also available at:</p>
      <div class="code-block">
        <code>https://${esc(p.custom_domain)}</code>
        <span style="font-size:12px;color:${p.custom_domain_verified ? '#38a169' : '#e94560'};margin-left:12px;">
          ${p.custom_domain_verified ? 'Verified' : 'Pending verification'}
        </span>
      </div>
    </div>` : `
    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Custom Domain</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Want guests to check in at your own domain (e.g. checkin.yourvilla.com)?</p>
      <form method="POST" action="/dashboard/properties/${p.id}/domain" style="display:flex;gap:12px;align-items:flex-end;">
        <div class="form-group" style="flex:1;margin-bottom:0;">
          <label>Custom Domain</label>
          <input type="text" name="customDomain" placeholder="e.g. checkin.mybnb.com">
        </div>
        <button type="submit" class="btn">Set Up Domain</button>
      </form>
      <div class="hint" style="margin-top:8px;">You'll need to create a CNAME record pointing to <strong>checkin.nofrontdesk.com</strong></div>
    </div>`}

    <a href="/dashboard" class="btn btn-outline" style="margin-top:20px;">Back to Dashboard</a>
    <style>
      .code-block { background: #1a1a2e; color: #e2e8f0; padding: 16px; border-radius: 8px; font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 13px; line-height: 1.6; position: relative; word-break: break-all; display: flex; align-items: flex-start; gap: 12px; }
      .code-block code { flex: 1; white-space: pre-wrap; }
      .copy-btn { background: #4a5568; color: white; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }
      .copy-btn:hover { background: #718096; }
    </style>
    <script>
    function copyCode(btn, text) {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
      });
    }
    </script>
  `));
});

// ---------------------------------------------
// POST /dashboard/properties/:id/domain - Set custom domain
// ---------------------------------------------
router.post('/dashboard/properties/:id/domain', async (req, res) => {
  const { customDomain } = req.body;
  const accountId = req.session.accountId;

  if (!customDomain || !customDomain.trim()) {
    return res.redirect(`/dashboard/embed/${req.params.id}`);
  }

  const domain = customDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  try {
    await db.query(
      'UPDATE properties SET custom_domain = $1, custom_domain_verified = false, updated_at = NOW() WHERE id = $2 AND account_id = $3',
      [domain, req.params.id, accountId]
    );
    res.redirect(`/dashboard/embed/${req.params.id}`);
  } catch (err) {
    console.error('Domain setup error:', err);
    res.redirect(`/dashboard/embed/${req.params.id}`);
  }
});

// ---------------------------------------------
// GET /dashboard/properties/add - Add property form
// ---------------------------------------------
router.get('/dashboard/properties/add', async (req, res) => {
  const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [req.session.accountId]);
  const pmsType = credRes.rows[0]?.pms_type || 'guesty';

  // Check if Stripe Connect is set up
  const stripeRes = await db.query('SELECT stripe_connect_onboarded FROM accounts WHERE id = $1', [req.session.accountId]);
  const hasStripe = stripeRes.rows[0]?.stripe_connect_onboarded || false;

  res.send(dashboardLayout({ company_name: req.session.companyName },
    propertyForm('Add Property', '/dashboard/properties/add', {}, '', pmsType, hasStripe)));
});

// ---------------------------------------------
// POST /dashboard/properties/add - Create property
// ---------------------------------------------
router.post('/dashboard/properties/add', async (req, res) => {
  const { name, welcomeMessage, brandColor, accentColor, fallbackPhone, guestyGuestAppName, depositAmount, depositType, paymentDescription } = req.body;
  const accountId = req.session.accountId;
  const requireConfirmationCode = !!req.body.requireConfirmationCode;
  const depositEnabled = !!req.body.depositEnabled;

  if (!name) {
    const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [accountId]);
    const pmsType = credRes.rows[0]?.pms_type || 'guesty';
    const stripeRes = await db.query('SELECT stripe_connect_onboarded FROM accounts WHERE id = $1', [accountId]);
    const hasStripe = stripeRes.rows[0]?.stripe_connect_onboarded || false;
    return res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Add Property', '/dashboard/properties/add', req.body, 'Property name is required.', pmsType, hasStripe)));
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

    const depositAmountCents = Math.round((parseFloat(depositAmount) || 0) * 100);

    await db.query(
      `INSERT INTO properties (account_id, name, slug, welcome_message, brand_color, accent_color, fallback_phone, guesty_guest_app_name, require_confirmation_code, deposit_enabled, deposit_amount_cents, deposit_type, payment_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [accountId, name.trim(), slug, welcomeMessage || 'Welcome!', brandColor || '#2C3E50', accentColor || '#E67E22',
       fallbackPhone || '', guestyGuestAppName || '', requireConfirmationCode,
       depositEnabled, depositAmountCents, depositType || 'charge', paymentDescription || 'Security Deposit']
    );

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Property create error:', err);
    const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [accountId]);
    const pmsType = credRes.rows[0]?.pms_type || 'guesty';
    res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Add Property', '/dashboard/properties/add', req.body, 'Something went wrong.', pmsType, false)));
  }
});

// ---------------------------------------------
// GET /dashboard/properties/:id/edit - Edit property
// ---------------------------------------------
router.get('/dashboard/properties/:id/edit', async (req, res) => {
  const [propRes, credRes, stripeRes] = await Promise.all([
    db.query('SELECT * FROM properties WHERE id = $1 AND account_id = $2', [req.params.id, req.session.accountId]),
    db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [req.session.accountId]),
    db.query('SELECT stripe_connect_onboarded FROM accounts WHERE id = $1', [req.session.accountId]),
  ]);

  if (propRes.rows.length === 0) return res.redirect('/dashboard');
  const p = propRes.rows[0];
  const pmsType = credRes.rows[0]?.pms_type || 'guesty';
  const hasStripe = stripeRes.rows[0]?.stripe_connect_onboarded || false;

  res.send(dashboardLayout({ company_name: req.session.companyName },
    propertyForm('Edit Property', `/dashboard/properties/${p.id}/edit`, {
      name: p.name,
      welcomeMessage: p.welcome_message,
      brandColor: p.brand_color,
      accentColor: p.accent_color,
      fallbackPhone: p.fallback_phone,
      guestyGuestAppName: p.guesty_guest_app_name,
      requireConfirmationCode: p.require_confirmation_code,
      depositEnabled: p.deposit_enabled,
      depositAmount: p.deposit_amount_cents ? (p.deposit_amount_cents / 100).toFixed(2) : '',
      depositType: p.deposit_type || 'charge',
      paymentDescription: p.payment_description || 'Security Deposit',
    }, '', pmsType, hasStripe)
  ));
});

// ---------------------------------------------
// POST /dashboard/properties/:id/edit - Update property
// ---------------------------------------------
router.post('/dashboard/properties/:id/edit', async (req, res) => {
  const { name, welcomeMessage, brandColor, accentColor, fallbackPhone, guestyGuestAppName, depositAmount, depositType, paymentDescription } = req.body;
  const accountId = req.session.accountId;
  const requireConfirmationCode = !!req.body.requireConfirmationCode;
  const depositEnabled = !!req.body.depositEnabled;

  if (!name) {
    const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [accountId]);
    const pmsType = credRes.rows[0]?.pms_type || 'guesty';
    return res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Edit Property', `/dashboard/properties/${req.params.id}/edit`, req.body, 'Property name is required.', pmsType, false)));
  }

  try {
    const depositAmountCents = Math.round((parseFloat(depositAmount) || 0) * 100);

    await db.query(
      `UPDATE properties SET name = $1, welcome_message = $2, brand_color = $3, accent_color = $4,
       fallback_phone = $5, guesty_guest_app_name = $6, require_confirmation_code = $7,
       deposit_enabled = $8, deposit_amount_cents = $9, deposit_type = $10, payment_description = $11,
       updated_at = NOW()
       WHERE id = $12 AND account_id = $13`,
      [name.trim(), welcomeMessage || 'Welcome!', brandColor || '#2C3E50', accentColor || '#E67E22',
       fallbackPhone || '', guestyGuestAppName || '', requireConfirmationCode,
       depositEnabled, depositAmountCents, depositType || 'charge', paymentDescription || 'Security Deposit',
       req.params.id, accountId]
    );

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Property update error:', err);
    res.redirect('/dashboard');
  }
});

// ---------------------------------------------
// GET /dashboard/signage/:id - QR code sign
// ---------------------------------------------
router.get('/dashboard/signage/:id', async (req, res) => {
  const propRes = await db.query('SELECT p.*, a.slug as account_slug FROM properties p JOIN accounts a ON p.account_id = a.id WHERE p.id = $1 AND p.account_id = $2',
    [req.params.id, req.session.accountId]);
  if (propRes.rows.length === 0) return res.redirect('/dashboard');

  const p = propRes.rows[0];
  const baseUrl = process.env.CHECKIN_BASE_URL || process.env.BASE_URL || `https://${req.get('host')}`;
  const checkinUrl = `${baseUrl}/c/${p.account_slug}/${p.slug}`;

  res.send(signagePage(p, checkinUrl));
});

// ---------------------------------------------
// Page Templates
// ---------------------------------------------
function dashboardLayout(account, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - NoFrontDesk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; color: #1a1a2e; }
    .topnav { background: #1a1a2e; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
    .topnav .logo { color: white; font-size: 20px; font-weight: 800; text-decoration: none; }
    .topnav .logo span { color: #e94560; }
    .topnav-right { display: flex; align-items: center; gap: 20px; }
    .topnav-right a { color: #a0aec0; text-decoration: none; font-size: 14px; }
    .topnav-right a:hover { color: white; }
    .company-badge { color: #e2e8f0; font-size: 14px; font-weight: 500; }
    .main { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
    .setup-banner { background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-left: 4px solid #e94560; }
    .setup-banner h3 { font-size: 18px; margin-bottom: 16px; }
    .setup-steps { display: flex; flex-direction: column; gap: 10px; }
    .setup-step { display: flex; align-items: center; gap: 12px; font-size: 15px; }
    .setup-step.done { color: #38a169; }
    .setup-step a { color: #e94560; text-decoration: none; font-weight: 600; }
    .step-num { width: 28px; height: 28px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
    .setup-step.done .step-num { background: #c6f6d5; color: #38a169; }
    .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .stat-num { font-size: 32px; font-weight: 800; color: #1a1a2e; }
    .stat-label { font-size: 13px; color: #718096; margin-top: 4px; font-weight: 500; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .section-header h2 { font-size: 20px; }
    .btn { display: inline-flex; align-items: center; padding: 10px 20px; background: #e94560; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: background 0.2s; }
    .btn:hover { background: #d63851; }
    .btn-sm { padding: 8px 16px; font-size: 13px; }
    .btn-outline { background: transparent; color: #1a1a2e; border: 2px solid #e2e8f0; }
    .btn-outline:hover { border-color: #1a1a2e; }
    .property-card { background: white; border-radius: 12px; padding: 18px 20px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); display: flex; align-items: center; justify-content: space-between; }
    .property-info { display: flex; align-items: center; gap: 14px; }
    .property-color { width: 12px; height: 40px; border-radius: 6px; flex-shrink: 0; }
    .property-name { font-size: 16px; font-weight: 600; }
    .property-url { font-size: 13px; color: #718096; margin-top: 2px; word-break: break-all; }
      .deposit-badge { font-size: 12px; margin-top: 4px; color: #48bb78; }
      .deposit-status { font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
      .badge-hold { background: #fef3c7; color: #92400e; }
      .badge-paid { background: #d1fae5; color: #065f46; }
      .badge-released { background: #e0e7ff; color: #3730a3; }
    .property-actions { display: flex; gap: 12px; }
    .action-link { font-size: 13px; color: #e94560; text-decoration: none; font-weight: 600; white-space: nowrap; }
    .empty-state { background: white; border-radius: 12px; padding: 40px; text-align: center; color: #718096; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .empty-state a { color: #e94560; text-decoration: none; font-weight: 600; }
    .form-card { background: white; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); margin-top: 16px; }
    .form-group { margin-bottom: 18px; }
    .form-group label { display: block; font-size: 14px; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
    .form-group input, .form-group textarea, .form-group select { width: 100%; padding: 10px 14px; font-size: 15px; border: 2px solid #e2e8f0; border-radius: 8px; outline: none; font-family: inherit; }
    .form-group input:focus, .form-group textarea:focus, .form-group select:focus { border-color: #e94560; }
    .form-group .hint { font-size: 12px; color: #a0aec0; margin-top: 4px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .color-preview { display: inline-block; width: 24px; height: 24px; border-radius: 6px; vertical-align: middle; margin-left: 8px; border: 1px solid #e2e8f0; }
    .error-msg { background: #fff5f5; color: #e53e3e; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #fed7d7; }
    .success-msg { background: #f0fff4; color: #38a169; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #c6f6d5; }
    .section-desc { color: #718096; font-size: 15px; margin-bottom: 16px; line-height: 1.6; }
    .help-text { margin-top: 20px; padding: 16px; background: #f7fafc; border-radius: 8px; font-size: 14px; line-height: 1.7; color: #4a5568; }
    .help-text a { color: #e94560; }
    @media (max-width: 640px) {
      .stats-row { grid-template-columns: 1fr; }
      .property-card { flex-direction: column; align-items: flex-start; gap: 12px; }
      .form-row { grid-template-columns: 1fr; }
      .pms-grid { grid-template-columns: repeat(2, 1fr) !important; }
    }
  </style>
</head>
<body>
  <nav class="topnav">
    <a href="/dashboard" class="logo">No<span>FrontDesk</span></a>
    <div class="topnav-right">
      <span class="company-badge">${esc(account.company_name)}</span>
      <a href="/dashboard/payments">Payments</a>
      <a href="/dashboard/billing">Billing</a>
      <a href="/dashboard/credentials">PMS Setup</a>
      <a href="/logout">Log out</a>
    </div>
  </nav>
  <div class="main">
    ${content}
  </div>
</body>
</html>`;
}

function propertyForm(title, action, data, error = '', pmsType = 'guesty', hasStripe = false) {
  const isGuesty = pmsType === 'guesty';
  const depositEnabled = data.depositEnabled || data.deposit_enabled || false;
  const depositAmount = data.depositAmount || (data.deposit_amount_cents ? (data.deposit_amount_cents / 100).toFixed(2) : '') || '';
  const depositType = data.depositType || data.deposit_type || 'charge';
  const paymentDesc = data.paymentDescription || data.payment_description || 'Security Deposit';

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
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
          <input type="checkbox" name="requireConfirmationCode" value="1" ${data.requireConfirmationCode || data.require_confirmation_code ? 'checked' : ''} style="width:20px;height:20px;accent-color:#e94560;">
          <span>Require Confirmation Code</span>
        </label>
        <div class="hint">When enabled, guests must enter the last 4 characters of their confirmation code after their last name is found.</div>
      </div>

      ${isGuesty ? `
      <div class="form-group">
        <label>Guesty Guest App Name</label>
        <input type="text" name="guestyGuestAppName" placeholder="e.g. west_end_flats" value="${esc(data.guestyGuestAppName || data.guesty_guest_app_name || '')}">
        <div class="hint">The name of your Guesty Guest App (just the name, e.g. west_end_flats - not the full template). If you have multiple guest apps, separate with commas.</div>
      </div>` : `
      <input type="hidden" name="guestyGuestAppName" value="${esc(data.guestyGuestAppName || data.guesty_guest_app_name || '')}">
      `}

      <!-- Payment / Deposit Settings -->
      <div style="border-top: 2px solid #e2e8f0; margin-top: 24px; padding-top: 24px;">
        <h3 style="font-size: 17px; margin-bottom: 16px; color: #1a1a2e;">Payment Settings</h3>

        ${!hasStripe ? `
        <div style="background: #fffbeb; border: 1px solid #fbbf24; border-radius: 8px; padding: 14px; margin-bottom: 16px; font-size: 14px; color: #92400e;">
          To collect deposits during check-in, first <a href="/dashboard/payments" style="color:#e94560;font-weight:600;">connect your Stripe account</a>.
        </div>
        ` : ''}

        <div class="form-group">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
            <input type="checkbox" name="depositEnabled" value="1" ${depositEnabled ? 'checked' : ''} ${!hasStripe ? 'disabled' : ''} style="width:20px;height:20px;accent-color:#e94560;" onchange="toggleDepositFields(this.checked)">
            <span>Require Deposit at Check-In</span>
          </label>
          <div class="hint">When enabled, guests will be asked to provide a credit card during check-in.</div>
        </div>

        <div id="depositFields" style="display:${depositEnabled ? 'block' : 'none'};">
          <div class="form-row">
            <div class="form-group">
              <label>Deposit Amount ($)</label>
              <input type="number" name="depositAmount" placeholder="e.g. 250" value="${esc(depositAmount)}" min="1" step="0.01">
              <div class="hint">Amount to charge or hold</div>
            </div>
            <div class="form-group">
              <label>Deposit Type</label>
              <select name="depositType">
                <option value="charge" ${depositType === 'charge' ? 'selected' : ''}>Charge (immediate)</option>
                <option value="hold" ${depositType === 'hold' ? 'selected' : ''}>Hold (pre-authorization)</option>
              </select>
              <div class="hint">Charge takes payment immediately. Hold places a temporary authorization that can be released later.</div>
            </div>
          </div>

          <div class="form-group">
            <label>Payment Description</label>
            <input type="text" name="paymentDescription" placeholder="e.g. Security Deposit" value="${esc(paymentDesc)}">
            <div class="hint">Shown to the guest on their card statement</div>
          </div>
        </div>
      </div>

      <button type="submit" class="btn" style="margin-top: 20px;">${title === 'Add Property' ? 'Add Property' : 'Save Changes'}</button>
      <a href="/dashboard" style="margin-left:16px;color:#718096;text-decoration:none;font-size:14px;">Cancel</a>
    </form>
    <script>
    function toggleDepositFields(checked) {
      document.getElementById('depositFields').style.display = checked ? 'block' : 'none';
    }
    </script>
  `;
}

function signagePage(property, checkinUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Sign - ${esc(property.name)}</title>
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
 + (ps.total_amount_cents / 100).toFixed(0) : '';
            return '<div class="deposit-status">' + parts.join(' ') + (amt ? ' &middot; ' + amt + ' total' : '') + '</div>';
          })()}
        </div>
      </div>
      <div class="property-actions">
        <a href="/c/${esc(account.slug)}/${esc(p.slug)}" target="_blank" class="action-link">Preview</a>
        <a href="/dashboard/signage/${p.id}" target="_blank" class="action-link">QR Sign</a>
        <a href="/dashboard/embed/${p.id}" class="action-link">Embed</a>
        <a href="/dashboard/properties/${p.id}/edit" class="action-link">Edit</a>
      </div>
    </div>
    `).join('')}
  `));
});

// ---------------------------------------------
// GET /dashboard/credentials - PMS connection setup
// ---------------------------------------------
router.get('/dashboard/credentials', async (req, res) => {
  const cred = await db.query(
    'SELECT pms_type, credentials, guesty_client_id FROM api_credentials WHERE account_id = $1',
    [req.session.accountId]
  );
  const existing = cred.rows[0];
  const pmsList = getPMSList();
  const currentPMS = existing?.pms_type || '';

  res.send(dashboardLayout({ company_name: req.session.companyName }, `
    <h2>PMS Connection</h2>
    <p class="section-desc">Connect your Property Management System so NoFrontDesk can look up guest reservations for contactless check-in.</p>

    ${existing ? `<div class="success-msg">Connected to <strong>${esc(pmsList.find(p => p.id === currentPMS)?.name || currentPMS)}</strong></div>` : ''}

    <form method="POST" action="/dashboard/credentials" class="form-card" id="pmsForm">
      <div class="form-group">
        <label>Select Your PMS</label>
        <div class="pms-grid">
          ${pmsList.map(pms => `
          <label class="pms-option ${currentPMS === pms.id ? 'selected' : ''}">
            <input type="radio" name="pmsType" value="${pms.id}" ${currentPMS === pms.id ? 'checked' : ''} onchange="showPMSFields(this.value)" required>
            <span class="pms-name">${esc(pms.name)}</span>
          </label>
          `).join('')}
        </div>
      </div>

      <!-- Dynamic credential fields per PMS -->
      ${pmsList.map(pms => `
      <div class="pms-fields" id="fields-${pms.id}" style="display:${currentPMS === pms.id ? 'block' : 'none'}">
        ${pms.fields.map(f => `
        <div class="form-group">
          <label>${esc(f.label)}${f.required ? ' *' : ''}</label>
          <input type="${f.type}" name="cred_${pms.id}_${f.key}" placeholder="${existing && currentPMS === pms.id ? '(leave blank to keep current)' : ''}" ${!existing && f.required ? 'required' : ''}>
          ${f.help ? `<div class="hint">${esc(f.help)}</div>` : ''}
        </div>
        `).join('')}
      </div>
      `).join('')}

      <button type="submit" class="btn">${existing ? 'Update Connection' : 'Connect PMS'}</button>
    </form>

    <script>
    function showPMSFields(pmsType) {
      document.querySelectorAll('.pms-fields').forEach(el => el.style.display = 'none');
      document.querySelectorAll('.pms-option').forEach(el => el.classList.remove('selected'));
      const fields = document.getElementById('fields-' + pmsType);
      if (fields) fields.style.display = 'block';
      const selected = document.querySelector('input[value="' + pmsType + '"]');
      if (selected) selected.closest('.pms-option').classList.add('selected');
    }
    </script>
    <style>
      .pms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-top: 8px; }
      .pms-option { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border: 2px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; font-size: 14px; font-weight: 600; }
      .pms-option:hover { border-color: #e94560; }
      .pms-option.selected { border-color: #e94560; background: #fff5f7; }
      .pms-option input[type="radio"] { display: none; }
    </style>
  `));
});

// ---------------------------------------------
// POST /dashboard/credentials - Save PMS credentials
// ---------------------------------------------
router.post('/dashboard/credentials', async (req, res) => {
  const { pmsType } = req.body;
  const accountId = req.session.accountId;

  if (!pmsType) {
    return res.redirect('/dashboard/credentials');
  }

  const pmsList = getPMSList();
  const pmsConfig = pmsList.find(p => p.id === pmsType);
  if (!pmsConfig) {
    return res.redirect('/dashboard/credentials');
  }

  try {
    // Extract credential fields for this PMS type
    const credentials = {};
    let hasNewCreds = false;
    for (const field of pmsConfig.fields) {
      const value = req.body[`cred_${pmsType}_${field.key}`];
      if (value && value.trim()) {
        credentials[field.key] = value.trim();
        hasNewCreds = true;
      }
    }

    const existing = await db.query('SELECT id, credentials FROM api_credentials WHERE account_id = $1', [accountId]);

    if (existing.rows.length > 0) {
      const mergedCreds = hasNewCreds
        ? { ...(existing.rows[0].credentials || {}), ...credentials }
        : existing.rows[0].credentials;

      await db.query(
        'UPDATE api_credentials SET pms_type = $1, credentials = $2, updated_at = NOW() WHERE account_id = $3',
        [pmsType, JSON.stringify(mergedCreds), accountId]
      );
    } else {
      const missingFields = pmsConfig.fields
        .filter(f => f.required && !credentials[f.key])
        .map(f => f.label);

      if (missingFields.length > 0) {
        return res.send(dashboardLayout({ company_name: req.session.companyName }, `
          <h2>PMS Connection</h2>
          <div class="error-msg">Missing required fields: ${missingFields.join(', ')}</div>
          <a href="/dashboard/credentials" class="btn">Go Back</a>
        `));
      }

      await db.query(
        'INSERT INTO api_credentials (account_id, pms_type, credentials) VALUES ($1, $2, $3)',
        [accountId, pmsType, JSON.stringify(credentials)]
      );
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Credentials save error:', err);
    res.redirect('/dashboard/credentials');
  }
});

// ---------------------------------------------
// GET /dashboard/embed/:id - Embed code for a property
// ---------------------------------------------
router.get('/dashboard/embed/:id', async (req, res) => {
  const propRes = await db.query(
    'SELECT p.*, a.slug as account_slug FROM properties p JOIN accounts a ON p.account_id = a.id WHERE p.id = $1 AND p.account_id = $2',
    [req.params.id, req.session.accountId]
  );
  if (propRes.rows.length === 0) return res.redirect('/dashboard');

  const p = propRes.rows[0];
  const baseUrl = process.env.CHECKIN_BASE_URL || process.env.BASE_URL || `https://${req.get('host')}`;
  const checkinUrl = `${baseUrl}/c/${p.account_slug}/${p.slug}`;
  const embedUrl = `${baseUrl}/embed/${p.account_slug}/${p.slug}`;
  const iframeCode = `<iframe src="${embedUrl}" width="100%" height="700" frameborder="0" style="border:none;border-radius:12px;max-width:480px;"></iframe>`;
  const jsSnippet = `<div id="nofrontdesk-checkin"></div>\n<script src="${baseUrl}/embed.js" data-property="${p.account_slug}/${p.slug}"></script>`;

  res.send(dashboardLayout({ company_name: req.session.companyName }, `
    <h2>Embed Check-In - ${esc(p.name)}</h2>
    <p class="section-desc">Add the check-in widget to your own website so guests can check in directly from your site.</p>

    <div class="form-card">
      <h3 style="margin-bottom:12px;">Option 1: iframe Embed</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Copy and paste this code into your website's HTML where you want the check-in form to appear.</p>
      <div class="code-block">
        <code>${esc(iframeCode)}</code>
        <button class="copy-btn" onclick="copyCode(this, '${esc(iframeCode).replace(/'/g, "\\'")}')">Copy</button>
      </div>
    </div>

    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Option 2: JavaScript Widget</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">A lightweight JS snippet that renders the check-in form and handles styling automatically.</p>
      <div class="code-block">
        <code>${esc(jsSnippet)}</code>
        <button class="copy-btn" onclick="copyCode(this, '${esc(jsSnippet).replace(/'/g, "\\'")}')">Copy</button>
      </div>
    </div>

    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Direct Link</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Share this URL directly with guests or link to it from your website.</p>
      <div class="code-block">
        <code>${esc(checkinUrl)}</code>
        <button class="copy-btn" onclick="copyCode(this, '${esc(checkinUrl)}')">Copy</button>
      </div>
    </div>

    ${p.custom_domain ? `
    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Custom Domain</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Your check-in page is also available at:</p>
      <div class="code-block">
        <code>https://${esc(p.custom_domain)}</code>
        <span style="font-size:12px;color:${p.custom_domain_verified ? '#38a169' : '#e94560'};margin-left:12px;">
          ${p.custom_domain_verified ? 'Verified' : 'Pending verification'}
        </span>
      </div>
    </div>` : `
    <div class="form-card" style="margin-top:16px;">
      <h3 style="margin-bottom:12px;">Custom Domain</h3>
      <p style="font-size:14px;color:#718096;margin-bottom:12px;">Want guests to check in at your own domain (e.g. checkin.yourvilla.com)?</p>
      <form method="POST" action="/dashboard/properties/${p.id}/domain" style="display:flex;gap:12px;align-items:flex-end;">
        <div class="form-group" style="flex:1;margin-bottom:0;">
          <label>Custom Domain</label>
          <input type="text" name="customDomain" placeholder="e.g. checkin.mybnb.com">
        </div>
        <button type="submit" class="btn">Set Up Domain</button>
      </form>
      <div class="hint" style="margin-top:8px;">You'll need to create a CNAME record pointing to <strong>checkin.nofrontdesk.com</strong></div>
    </div>`}

    <a href="/dashboard" class="btn btn-outline" style="margin-top:20px;">Back to Dashboard</a>
    <style>
      .code-block { background: #1a1a2e; color: #e2e8f0; padding: 16px; border-radius: 8px; font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 13px; line-height: 1.6; position: relative; word-break: break-all; display: flex; align-items: flex-start; gap: 12px; }
      .code-block code { flex: 1; white-space: pre-wrap; }
      .copy-btn { background: #4a5568; color: white; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }
      .copy-btn:hover { background: #718096; }
    </style>
    <script>
    function copyCode(btn, text) {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
      });
    }
    </script>
  `));
});

// ---------------------------------------------
// POST /dashboard/properties/:id/domain - Set custom domain
// ---------------------------------------------
router.post('/dashboard/properties/:id/domain', async (req, res) => {
  const { customDomain } = req.body;
  const accountId = req.session.accountId;

  if (!customDomain || !customDomain.trim()) {
    return res.redirect(`/dashboard/embed/${req.params.id}`);
  }

  const domain = customDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  try {
    await db.query(
      'UPDATE properties SET custom_domain = $1, custom_domain_verified = false, updated_at = NOW() WHERE id = $2 AND account_id = $3',
      [domain, req.params.id, accountId]
    );
    res.redirect(`/dashboard/embed/${req.params.id}`);
  } catch (err) {
    console.error('Domain setup error:', err);
    res.redirect(`/dashboard/embed/${req.params.id}`);
  }
});

// ---------------------------------------------
// GET /dashboard/properties/add - Add property form
// ---------------------------------------------
router.get('/dashboard/properties/add', async (req, res) => {
  const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [req.session.accountId]);
  const pmsType = credRes.rows[0]?.pms_type || 'guesty';

  // Check if Stripe Connect is set up
  const stripeRes = await db.query('SELECT stripe_connect_onboarded FROM accounts WHERE id = $1', [req.session.accountId]);
  const hasStripe = stripeRes.rows[0]?.stripe_connect_onboarded || false;

  res.send(dashboardLayout({ company_name: req.session.companyName },
    propertyForm('Add Property', '/dashboard/properties/add', {}, '', pmsType, hasStripe)));
});

// ---------------------------------------------
// POST /dashboard/properties/add - Create property
// ---------------------------------------------
router.post('/dashboard/properties/add', async (req, res) => {
  const { name, welcomeMessage, brandColor, accentColor, fallbackPhone, guestyGuestAppName, depositAmount, depositType, paymentDescription } = req.body;
  const accountId = req.session.accountId;
  const requireConfirmationCode = !!req.body.requireConfirmationCode;
  const depositEnabled = !!req.body.depositEnabled;

  if (!name) {
    const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [accountId]);
    const pmsType = credRes.rows[0]?.pms_type || 'guesty';
    const stripeRes = await db.query('SELECT stripe_connect_onboarded FROM accounts WHERE id = $1', [accountId]);
    const hasStripe = stripeRes.rows[0]?.stripe_connect_onboarded || false;
    return res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Add Property', '/dashboard/properties/add', req.body, 'Property name is required.', pmsType, hasStripe)));
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

    const depositAmountCents = Math.round((parseFloat(depositAmount) || 0) * 100);

    await db.query(
      `INSERT INTO properties (account_id, name, slug, welcome_message, brand_color, accent_color, fallback_phone, guesty_guest_app_name, require_confirmation_code, deposit_enabled, deposit_amount_cents, deposit_type, payment_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [accountId, name.trim(), slug, welcomeMessage || 'Welcome!', brandColor || '#2C3E50', accentColor || '#E67E22',
       fallbackPhone || '', guestyGuestAppName || '', requireConfirmationCode,
       depositEnabled, depositAmountCents, depositType || 'charge', paymentDescription || 'Security Deposit']
    );

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Property create error:', err);
    const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [accountId]);
    const pmsType = credRes.rows[0]?.pms_type || 'guesty';
    res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Add Property', '/dashboard/properties/add', req.body, 'Something went wrong.', pmsType, false)));
  }
});

// ---------------------------------------------
// GET /dashboard/properties/:id/edit - Edit property
// ---------------------------------------------
router.get('/dashboard/properties/:id/edit', async (req, res) => {
  const [propRes, credRes, stripeRes] = await Promise.all([
    db.query('SELECT * FROM properties WHERE id = $1 AND account_id = $2', [req.params.id, req.session.accountId]),
    db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [req.session.accountId]),
    db.query('SELECT stripe_connect_onboarded FROM accounts WHERE id = $1', [req.session.accountId]),
  ]);

  if (propRes.rows.length === 0) return res.redirect('/dashboard');
  const p = propRes.rows[0];
  const pmsType = credRes.rows[0]?.pms_type || 'guesty';
  const hasStripe = stripeRes.rows[0]?.stripe_connect_onboarded || false;

  res.send(dashboardLayout({ company_name: req.session.companyName },
    propertyForm('Edit Property', `/dashboard/properties/${p.id}/edit`, {
      name: p.name,
      welcomeMessage: p.welcome_message,
      brandColor: p.brand_color,
      accentColor: p.accent_color,
      fallbackPhone: p.fallback_phone,
      guestyGuestAppName: p.guesty_guest_app_name,
      requireConfirmationCode: p.require_confirmation_code,
      depositEnabled: p.deposit_enabled,
      depositAmount: p.deposit_amount_cents ? (p.deposit_amount_cents / 100).toFixed(2) : '',
      depositType: p.deposit_type || 'charge',
      paymentDescription: p.payment_description || 'Security Deposit',
    }, '', pmsType, hasStripe)
  ));
});

// ---------------------------------------------
// POST /dashboard/properties/:id/edit - Update property
// ---------------------------------------------
router.post('/dashboard/properties/:id/edit', async (req, res) => {
  const { name, welcomeMessage, brandColor, accentColor, fallbackPhone, guestyGuestAppName, depositAmount, depositType, paymentDescription } = req.body;
  const accountId = req.session.accountId;
  const requireConfirmationCode = !!req.body.requireConfirmationCode;
  const depositEnabled = !!req.body.depositEnabled;

  if (!name) {
    const credRes = await db.query('SELECT pms_type FROM api_credentials WHERE account_id = $1', [accountId]);
    const pmsType = credRes.rows[0]?.pms_type || 'guesty';
    return res.send(dashboardLayout({ company_name: req.session.companyName },
      propertyForm('Edit Property', `/dashboard/properties/${req.params.id}/edit`, req.body, 'Property name is required.', pmsType, false)));
  }

  try {
    const depositAmountCents = Math.round((parseFloat(depositAmount) || 0) * 100);

    await db.query(
      `UPDATE properties SET name = $1, welcome_message = $2, brand_color = $3, accent_color = $4,
       fallback_phone = $5, guesty_guest_app_name = $6, require_confirmation_code = $7,
       deposit_enabled = $8, deposit_amount_cents = $9, deposit_type = $10, payment_description = $11,
       updated_at = NOW()
       WHERE id = $12 AND account_id = $13`,
      [name.trim(), welcomeMessage || 'Welcome!', brandColor || '#2C3E50', accentColor || '#E67E22',
       fallbackPhone || '', guestyGuestAppName || '', requireConfirmationCode,
       depositEnabled, depositAmountCents, depositType || 'charge', paymentDescription || 'Security Deposit',
       req.params.id, accountId]
    );

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Property update error:', err);
    res.redirect('/dashboard');
  }
});

// ---------------------------------------------
// GET /dashboard/signage/:id - QR code sign
// ---------------------------------------------
router.get('/dashboard/signage/:id', async (req, res) => {
  const propRes = await db.query('SELECT p.*, a.slug as account_slug FROM properties p JOIN accounts a ON p.account_id = a.id WHERE p.id = $1 AND p.account_id = $2',
    [req.params.id, req.session.accountId]);
  if (propRes.rows.length === 0) return res.redirect('/dashboard');

  const p = propRes.rows[0];
  const baseUrl = process.env.CHECKIN_BASE_URL || process.env.BASE_URL || `https://${req.get('host')}`;
  const checkinUrl = `${baseUrl}/c/${p.account_slug}/${p.slug}`;

  res.send(signagePage(p, checkinUrl));
});

// ---------------------------------------------
// Page Templates
// ---------------------------------------------
function dashboardLayout(account, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - NoFrontDesk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; color: #1a1a2e; }
    .topnav { background: #1a1a2e; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
    .topnav .logo { color: white; font-size: 20px; font-weight: 800; text-decoration: none; }
    .topnav .logo span { color: #e94560; }
    .topnav-right { display: flex; align-items: center; gap: 20px; }
    .topnav-right a { color: #a0aec0; text-decoration: none; font-size: 14px; }
    .topnav-right a:hover { color: white; }
    .company-badge { color: #e2e8f0; font-size: 14px; font-weight: 500; }
    .main { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
    .setup-banner { background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-left: 4px solid #e94560; }
    .setup-banner h3 { font-size: 18px; margin-bottom: 16px; }
    .setup-steps { display: flex; flex-direction: column; gap: 10px; }
    .setup-step { display: flex; align-items: center; gap: 12px; font-size: 15px; }
    .setup-step.done { color: #38a169; }
    .setup-step a { color: #e94560; text-decoration: none; font-weight: 600; }
    .step-num { width: 28px; height: 28px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
    .setup-step.done .step-num { background: #c6f6d5; color: #38a169; }
    .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .stat-num { font-size: 32px; font-weight: 800; color: #1a1a2e; }
    .stat-label { font-size: 13px; color: #718096; margin-top: 4px; font-weight: 500; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .section-header h2 { font-size: 20px; }
    .btn { display: inline-flex; align-items: center; padding: 10px 20px; background: #e94560; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: background 0.2s; }
    .btn:hover { background: #d63851; }
    .btn-sm { padding: 8px 16px; font-size: 13px; }
    .btn-outline { background: transparent; color: #1a1a2e; border: 2px solid #e2e8f0; }
    .btn-outline:hover { border-color: #1a1a2e; }
    .property-card { background: white; border-radius: 12px; padding: 18px 20px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); display: flex; align-items: center; justify-content: space-between; }
    .property-info { display: flex; align-items: center; gap: 14px; }
    .property-color { width: 12px; height: 40px; border-radius: 6px; flex-shrink: 0; }
    .property-name { font-size: 16px; font-weight: 600; }
    .property-url { font-size: 13px; color: #718096; margin-top: 2px; word-break: break-all; }
    .property-actions { display: flex; gap: 12px; }
    .action-link { font-size: 13px; color: #e94560; text-decoration: none; font-weight: 600; white-space: nowrap; }
    .empty-state { background: white; border-radius: 12px; padding: 40px; text-align: center; color: #718096; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .empty-state a { color: #e94560; text-decoration: none; font-weight: 600; }
    .form-card { background: white; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); margin-top: 16px; }
    .form-group { margin-bottom: 18px; }
    .form-group label { display: block; font-size: 14px; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
    .form-group input, .form-group textarea, .form-group select { width: 100%; padding: 10px 14px; font-size: 15px; border: 2px solid #e2e8f0; border-radius: 8px; outline: none; font-family: inherit; }
    .form-group input:focus, .form-group textarea:focus, .form-group select:focus { border-color: #e94560; }
    .form-group .hint { font-size: 12px; color: #a0aec0; margin-top: 4px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .color-preview { display: inline-block; width: 24px; height: 24px; border-radius: 6px; vertical-align: middle; margin-left: 8px; border: 1px solid #e2e8f0; }
    .error-msg { background: #fff5f5; color: #e53e3e; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #fed7d7; }
    .success-msg { background: #f0fff4; color: #38a169; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #c6f6d5; }
    .section-desc { color: #718096; font-size: 15px; margin-bottom: 16px; line-height: 1.6; }
    .help-text { margin-top: 20px; padding: 16px; background: #f7fafc; border-radius: 8px; font-size: 14px; line-height: 1.7; color: #4a5568; }
    .help-text a { color: #e94560; }
    @media (max-width: 640px) {
      .stats-row { grid-template-columns: 1fr; }
      .property-card { flex-direction: column; align-items: flex-start; gap: 12px; }
      .form-row { grid-template-columns: 1fr; }
      .pms-grid { grid-template-columns: repeat(2, 1fr) !important; }
    }
  </style>
</head>
<body>
  <nav class="topnav">
    <a href="/dashboard" class="logo">No<span>FrontDesk</span></a>
    <div class="topnav-right">
      <span class="company-badge">${esc(account.company_name)}</span>
      <a href="/dashboard/payments">Payments</a>
      <a href="/dashboard/billing">Billing</a>
      <a href="/dashboard/credentials">PMS Setup</a>
      <a href="/logout">Log out</a>
    </div>
  </nav>
  <div class="main">
    ${content}
  </div>
</body>
</html>`;
}

function propertyForm(title, action, data, error = '', pmsType = 'guesty', hasStripe = false) {
  const isGuesty = pmsType === 'guesty';
  const depositEnabled = data.depositEnabled || data.deposit_enabled || false;
  const depositAmount = data.depositAmount || (data.deposit_amount_cents ? (data.deposit_amount_cents / 100).toFixed(2) : '') || '';
  const depositType = data.depositType || data.deposit_type || 'charge';
  const paymentDesc = data.paymentDescription || data.payment_description || 'Security Deposit';

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
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
          <input type="checkbox" name="requireConfirmationCode" value="1" ${data.requireConfirmationCode || data.require_confirmation_code ? 'checked' : ''} style="width:20px;height:20px;accent-color:#e94560;">
          <span>Require Confirmation Code</span>
        </label>
        <div class="hint">When enabled, guests must enter the last 4 characters of their confirmation code after their last name is found.</div>
      </div>

      ${isGuesty ? `
      <div class="form-group">
        <label>Guesty Guest App Name</label>
        <input type="text" name="guestyGuestAppName" placeholder="e.g. west_end_flats" value="${esc(data.guestyGuestAppName || data.guesty_guest_app_name || '')}">
        <div class="hint">The name of your Guesty Guest App (just the name, e.g. west_end_flats - not the full template). If you have multiple guest apps, separate with commas.</div>
      </div>` : `
      <input type="hidden" name="guestyGuestAppName" value="${esc(data.guestyGuestAppName || data.guesty_guest_app_name || '')}">
      `}

      <!-- Payment / Deposit Settings -->
      <div style="border-top: 2px solid #e2e8f0; margin-top: 24px; padding-top: 24px;">
        <h3 style="font-size: 17px; margin-bottom: 16px; color: #1a1a2e;">Payment Settings</h3>

        ${!hasStripe ? `
        <div style="background: #fffbeb; border: 1px solid #fbbf24; border-radius: 8px; padding: 14px; margin-bottom: 16px; font-size: 14px; color: #92400e;">
          To collect deposits during check-in, first <a href="/dashboard/payments" style="color:#e94560;font-weight:600;">connect your Stripe account</a>.
        </div>
        ` : ''}

        <div class="form-group">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
            <input type="checkbox" name="depositEnabled" value="1" ${depositEnabled ? 'checked' : ''} ${!hasStripe ? 'disabled' : ''} style="width:20px;height:20px;accent-color:#e94560;" onchange="toggleDepositFields(this.checked)">
            <span>Require Deposit at Check-In</span>
          </label>
          <div class="hint">When enabled, guests will be asked to provide a credit card during check-in.</div>
        </div>

        <div id="depositFields" style="display:${depositEnabled ? 'block' : 'none'};">
          <div class="form-row">
            <div class="form-group">
              <label>Deposit Amount ($)</label>
              <input type="number" name="depositAmount" placeholder="e.g. 250" value="${esc(depositAmount)}" min="1" step="0.01">
              <div class="hint">Amount to charge or hold</div>
            </div>
            <div class="form-group">
              <label>Deposit Type</label>
              <select name="depositType">
                <option value="charge" ${depositType === 'charge' ? 'selected' : ''}>Charge (immediate)</option>
                <option value="hold" ${depositType === 'hold' ? 'selected' : ''}>Hold (pre-authorization)</option>
              </select>
              <div class="hint">Charge takes payment immediately. Hold places a temporary authorization that can be released later.</div>
            </div>
          </div>

          <div class="form-group">
            <label>Payment Description</label>
            <input type="text" name="paymentDescription" placeholder="e.g. Security Deposit" value="${esc(paymentDesc)}">
            <div class="hint">Shown to the guest on their card statement</div>
          </div>
        </div>
      </div>

      <button type="submit" class="btn" style="margin-top: 20px;">${title === 'Add Property' ? 'Add Property' : 'Save Changes'}</button>
      <a href="/dashboard" style="margin-left:16px;color:#718096;text-decoration:none;font-size:14px;">Cancel</a>
    </form>
    <script>
    function toggleDepositFields(checked) {
      document.getElementById('depositFields').style.display = checked ? 'block' : 'none';
    }
    </script>
  `;
}

function signagePage(property, checkinUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Sign - ${esc(property.name)}</title>
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
