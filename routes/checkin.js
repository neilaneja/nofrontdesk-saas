const express = require('express');
const db = require('../lib/db');
const { createAdapter } = require('../lib/pms');

const router = express.Router();

// âââââââââââââââââââââââââââââââââââââââââââââ
// GET /c/:accountSlug/:propertySlug â Guest check-in page
// This is the public-facing URL that guests access via QR code
// âââââââââââââââââââââââââââââââââââââââââââââ
router.get('/c/:accountSlug/:propertySlug', async (req, res) => {
  const { accountSlug, propertySlug } = req.params;

  const result = await db.query(
    `SELECT p.*, a.slug as account_slug
     FROM properties p
     JOIN accounts a ON p.account_id = a.id
     WHERE a.slug = $1 AND p.slug = $2`,
    [accountSlug, propertySlug]
  );

  if (result.rows.length === 0) {
    return res.status(404).send(notFoundPage());
  }

  // Serve the check-in HTML â it will fetch branding from the API
  res.sendFile(require('path').join(__dirname, '..', 'public', 'checkin.html'));
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// GET /api/property/:accountSlug/:propertySlug â Property config (public)
// Returns branding info for the check-in page
// âââââââââââââââââââââââââââââââââââââââââââââ
router.get('/api/property/:accountSlug/:propertySlug', async (req, res) => {
  const { accountSlug, propertySlug } = req.params;

  const result = await db.query(
    `SELECT p.name, p.welcome_message, p.require_confirmation_code, p.logo_url, p.brand_color, p.accent_color, p.fallback_phone
     FROM properties p
     JOIN accounts a ON p.account_id = a.id
     WHERE a.slug = $1 AND p.slug = $2`,
    [accountSlug, propertySlug]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Property not found' });
  }

  const p = result.rows[0];
  res.json({
    name: p.name,
    requireConfirmationCode: p.require_confirmation_code,
    welcomeMessage: p.welcome_message,
    logoUrl: p.logo_url,
    brandColor: p.brand_color,
    accentColor: p.accent_color,
    fallbackPhone: p.fallback_phone,
  });
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// POST /api/lookup â Reservation lookup (public)
// Uses the PMS adapter pattern to support multiple PMS platforms
// âââââââââââââââââââââââââââââââââââââââââââââ
router.post('/api/lookup', async (req, res) => {
  const { lastName, accountSlug, propertySlug, confirmationCode } = req.body;

  if (!lastName || !accountSlug || !propertySlug) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    // Get property and account info
    const propResult = await db.query(
      `SELECT p.*, a.id as account_id, a.slug as account_slug
       FROM properties p
       JOIN accounts a ON p.account_id = a.id
       WHERE a.slug = $1 AND p.slug = $2`,
      [accountSlug, propertySlug]
    );

    if (propResult.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found.' });
    }

    const property = propResult.rows[0];

    // Get PMS credentials for this account
    const credResult = await db.query(
      `SELECT pms_type, credentials FROM api_credentials WHERE account_id = $1`,
      [property.account_id]
    );

    if (credResult.rows.length === 0) {
      return res.status(500).json({
        error: 'system_error',
        message: 'Check-in system is not configured. Please contact the property manager.',
      });
    }

    const { pms_type, credentials } = credResult.rows[0];

    // Create the appropriate PMS adapter
    const pmsCredentials = {
      ...credentials,
      accountId: property.account_id,
    };
    const adapter = createAdapter(pms_type, pmsCredentials);

    // Search reservations via the PMS adapter
    let results = await adapter.searchReservations(lastName);

    // Log the check-in attempt
    const logResult = results.length > 0 ? (results.length === 1 ? 'found' : 'multiple') : 'not_found';
    db.query(
      'INSERT INTO checkin_logs (property_id, account_id, guest_last_name, result) VALUES ($1, $2, $3, $4)',
      [property.id, property.account_id, lastName, logResult]
    ).catch(err => console.error('Log error:', err));

    if (results.length === 0) {
      return res.json({
        status: 'not_found',
        message: 'No reservation found. Please check the spelling of your last name and try again.',
      });
    }

    // Handle confirmation code verification if enabled
    if (property.require_confirmation_code && results.length > 0) {
      if (!confirmationCode) {
        return res.json({
          status: 'needsConfirmation',
          message: 'Please enter your confirmation code to proceed.',
        });
      }

      const confirmationCodeUpper = confirmationCode.toUpperCase();
      const matchingReservations = results.filter(reservation => {
        if (!reservation.confirmationCode) return false;
        const last4 = reservation.confirmationCode.slice(-4).toUpperCase();
        return last4 === confirmationCodeUpper;
      });

      if (matchingReservations.length === 0) {
        return res.json({
          status: 'error',
          message: 'Invalid confirmation code. Please check and try again.',
        });
      }

      results = matchingReservations;
    }

    // Build check-in URLs
    const propertyConfig = {
      guestyGuestAppName: property.guesty_guest_app_name || '',
      pmsType: pms_type,
    };

    if (results.length === 1) {
      const r = results[0];
      return res.json({
        status: 'found',
        reservation: {
          id: r.id,
          guestFirstName: r.guest.firstName,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          listingName: r.listingName,
          checkInFormUrl: adapter.buildCheckInUrl(r, propertyConfig) || '',
        },
      });
    }

    // Multiple matches
    return res.json({
      status: 'multiple',
      message: 'We found multiple reservations. Please select yours.',
      reservations: results.map(r => ({
        id: r.id,
        guestFirstName: r.guest.firstName,
        guestLastName: r.guest.lastName,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        listingName: r.listingName,
        checkInFormUrl: adapter.buildCheckInUrl(r, propertyConfig) || '',
      })),
    });

  } catch (err) {
    console.error('Reservation lookup error:', err.message);

    db.query(
      'INSERT INTO checkin_logs (account_id, guest_last_name, result) VALUES ((SELECT a.id FROM accounts a WHERE a.slug = $1), $2, $3)',
      [accountSlug, lastName, 'error']
    ).catch(() => {});

    return res.status(500).json({
      error: 'system_error',
      message: 'Something went wrong. Please try again or call us for help.',
    });
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// GET /api/pms-types â List supported PMS platforms (public)
// Used by dashboard to show PMS selection
// âââââââââââââââââââââââââââââââââââââââââââââ
router.get('/api/pms-types', (req, res) => {
  const { getPMSList } = require('../lib/pms');
  res.json(getPMSList());
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// GET /embed/:accountSlug/:propertySlug â Embeddable check-in widget
// Serves a lightweight version of the check-in page for iframe embedding
// âââââââââââââââââââââââââââââââââââââââââââââ
router.get('/embed/:accountSlug/:propertySlug', async (req, res) => {
  const { accountSlug, propertySlug } = req.params;

  const result = await db.query(
    `SELECT p.*, a.slug as account_slug
     FROM properties p
     JOIN accounts a ON p.account_id = a.id
     WHERE a.slug = $1 AND p.slug = $2`,
    [accountSlug, propertySlug]
  );

  if (result.rows.length === 0) {
    return res.status(404).send(notFoundPage());
  }

  // Serve the same check-in HTML - it adapts when loaded in an iframe
  res.sendFile(require('path').join(__dirname, '..', 'public', 'checkin.html'));
});

function notFoundPage() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not Found</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fc;color:#1a1a2e;text-align:center;padding:20px;}
.msg{max-width:400px;}.msg h1{font-size:72px;margin-bottom:8px;}.msg p{color:#718096;font-size:16px;}</style></head>
<body><div class="msg"><h1>404</h1><p>Property not found. Please check the URL or scan the QR code again.</p></div></body></html>`;
}

module.exports = router;
