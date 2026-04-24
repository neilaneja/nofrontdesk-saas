const express = require('express');
const db = require('../lib/db');
const { getGuestyToken, searchReservations, buildCheckInFormUrl } = require('../lib/guesty');

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
// âââââââââââââââââââââââââââââââââââââââââââââ
router.post('/api/lookup', async (req, res) => {
  const { lastName, accountSlug, propertySlug, confirmationCode } = req.body;

  if (!lastName || !accountSlug || !propertySlug) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    // Get property and account credentials
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

    // Get Guesty credentials for this account
    const credResult = await db.query(
      'SELECT guesty_client_id, guesty_client_secret FROM api_credentials WHERE account_id = $1',
      [property.account_id]
    );

    if (credResult.rows.length === 0) {
      return res.status(500).json({
        error: 'system_error',
        message: 'Check-in system is not configured. Please contact the property manager.',
      });
    }

    const creds = credResult.rows[0];

    // Get token and search reservations using this account's credentials
    const token = await getGuestyToken(property.account_id, creds.guesty_client_id, creds.guesty_client_secret);
    let results = await searchReservations(token, lastName);

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
        // Confirmation code is required but not provided - tell frontend to show code input
        return res.json({
          status: 'needsConfirmation',
          message: 'Please enter your confirmation code to proceed.',
        });
      }

      // Verify confirmation code against reservation(s)
      const confirmationCodeUpper = confirmationCode.toUpperCase();
      const matchingReservations = results.filter(reservation => {
        if (!reservation.confirmationCode) {
          return false;
        }
        // Check if last 4 characters of Guesty confirmation code match input
        const last4 = reservation.confirmationCode.slice(-4).toUpperCase();
        return last4 === confirmationCodeUpper;
      });

      if (matchingReservations.length === 0) {
        return res.json({
          status: 'error',
          message: 'Invalid confirmation code. Please check and try again.',
        });
      }

      // Filter results to only matching reservations
      results = matchingReservations;
    }

    if (results.length === 1) {
      return res.json({
        status: 'found',
        reservation: {
          id: results[0]._id,
          guestFirstName: results[0].guest?.firstName || '',
          checkIn: results[0].checkInDateLocalized || results[0].checkIn,
          checkOut: results[0].checkOutDateLocalized || results[0].checkOut,
          listingName: results[0].listing?.title || '',
          checkInFormUrl: buildCheckInFormUrl(results[0], property.guesty_guest_app_name),
        },
      });
    }

    // Multiple matches
    return res.json({
      status: 'multiple',
      message: 'We found multiple reservations. Please select yours.',
      reservations: results.map(r => ({
        id: r._id,
        guestFirstName: r.guest?.firstName || '',
        guestLastName: r.guest?.lastName || '',
        checkIn: r.checkInDateLocalized || r.checkIn,
        checkOut: r.checkOutDateLocalized || r.checkOut,
        listingName: r.listing?.title || '',
        checkInFormUrl: buildCheckInFormUrl(r, property.guesty_guest_app_name),
      })),
    });

  } catch (err) {
    console.error('Reservation lookup error:', err.message);

    // Log the error
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

function notFoundPage() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not Found</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fc;color:#1a1a2e;text-align:center;padding:20px;}
.msg{max-width:400px;}.msg h1{font-size:72px;margin-bottom:8px;}.msg p{color:#718096;font-size:16px;}</style></head>
<body><div class="msg"><h1>404</h1><p>Property not found. Please check the URL or scan the QR code again.</p></div></body></html>`;
}

module.exports = router;
