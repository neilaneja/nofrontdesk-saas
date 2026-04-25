const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../lib/db');
const { createAdapter } = require('../lib/pms');

const router = express.Router();

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// File upload configuration (for ID photos, selfies)
// âââââââââââââââââââââââââââââââââââââââââââââââââ
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /c/:accountSlug/:propertySlug â Guest check-in page
// This is the public-facing URL that guests access via QR code
// âââââââââââââââââââââââââââââââââââââââââââââââââ
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
  res.sendFile(path.join(__dirname, '..', 'public', 'checkin.html'));
});

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /checkin-form â NoFrontDesk built-in check-in form
// Guests are redirected here when no PMS native form exists
// âââââââââââââââââââââââââââââââââââââââââââââââââ
router.get('/checkin-form', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'checkin-form.html'));
});

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /api/property/:accountSlug/:propertySlug â Property config (public)
// Returns branding info + check-in form configuration
// âââââââââââââââââââââââââââââââââââââââââââââââââ
router.get('/api/property/:accountSlug/:propertySlug', async (req, res) => {
  const { accountSlug, propertySlug } = req.params;

  const result = await db.query(
    `SELECT p.name, p.welcome_message, p.require_confirmation_code,
            p.logo_url, p.brand_color, p.accent_color, p.fallback_phone,
            p.checkin_form_mode, p.custom_checkin_url, p.checkin_form_config
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
    checkinFormMode: p.checkin_form_mode || 'auto',
    customCheckinUrl: p.custom_checkin_url || '',
    checkinFormConfig: p.checkin_form_config || null,
  });
});

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /api/lookup â Reservation lookup (public)
// Uses the PMS adapter pattern to support multiple PMS platforms
// Now uses resolveCheckInUrl() to respect checkinFormMode setting
// âââââââââââââââââââââââââââââââââââââââââââââââââ
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
    const pmsCredentials = { ...credentials, accountId: property.account_id };
    const adapter = createAdapter(pms_type, pmsCredentials);

    // Search reservations via the PMS adapter
    let results = await adapter.searchReservations(lastName);

    // Log the check-in attempt
    const logResult = results.length > 0
      ? (results.length === 1 ? 'found' : 'multiple')
      : 'not_found';

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

    // Build property config for URL resolution
    const propertyConfig = {
      guestyGuestAppName: property.guesty_guest_app_name || '',
      pmsType: pms_type,
      checkinFormMode: property.checkin_form_mode || 'auto',
      customCheckinUrl: property.custom_checkin_url || '',
    };

    // Build check-in URLs using resolveCheckInUrl (respects checkinFormMode)
    const buildUrl = (r) => {
      const url = adapter.resolveCheckInUrl(r, propertyConfig);
      // If null, the frontend will redirect to the NoFrontDesk built-in form
      return url || '';
    };

    if (results.length === 1) {
      const r = results[0];
      return res.json({
        status: 'found',
        reservation: {
          id: r.id,
          guestFirstName: r.guest.firstName,
          guestLastName: r.guest.lastName,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          listingName: r.listingName,
          checkInFormUrl: buildUrl(r),
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
        checkInFormUrl: buildUrl(r),
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

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /api/checkin/submit â Submit check-in form (public)
// Handles the NoFrontDesk built-in check-in form submission
// âââââââââââââââââââââââââââââââââââââââââââââââââ
router.post('/api/checkin/submit',
  upload.fields([
    { name: 'id_front', maxCount: 1 },
    { name: 'id_back', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { accountSlug, propertySlug, reservationId } = req.body;

      if (!accountSlug || !propertySlug) {
        return res.status(400).json({ error: 'Missing required fields.' });
      }

      // Get property and account
      const propResult = await db.query(
        `SELECT p.id, p.account_id, a.slug as account_slug
         FROM properties p
         JOIN accounts a ON p.account_id = a.id
         WHERE a.slug = $1 AND p.slug = $2`,
        [accountSlug, propertySlug]
      );

      if (propResult.rows.length === 0) {
        return res.status(404).json({ error: 'Property not found.' });
      }

      const property = propResult.rows[0];

      // Get PMS type
      const credResult = await db.query(
        `SELECT pms_type FROM api_credentials WHERE account_id = $1`,
        [property.account_id]
      );
      const pmsType = credResult.rows[0]?.pms_type || 'unknown';

      // Parse full name
      const fullName = req.body.full_name || '';
      const nameParts = fullName.trim().split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      // File URLs
      const idFrontUrl = req.files?.id_front?.[0]
        ? `/uploads/${req.files.id_front[0].filename}` : null;
      const idBackUrl = req.files?.id_back?.[0]
        ? `/uploads/${req.files.id_back[0].filename}` : null;
      const selfieUrl = req.files?.selfie?.[0]
        ? `/uploads/${req.files.selfie[0].filename}` : null;

      // Parse custom answers
      let customAnswers = {};
      try {
        customAnswers = JSON.parse(req.body.custom_answers || '{}');
      } catch (e) { /* ignore */ }

      // Insert submission
      const insertResult = await db.query(
        `INSERT INTO checkin_submissions (
          property_id, account_id, reservation_id, pms_type,
          guest_first_name, guest_last_name, guest_email, guest_phone,
          guest_address, num_guests, arrival_eta, flight_info,
          special_requests, vehicle_make_model, vehicle_license_plate,
          vehicle_color, house_rules_accepted, rental_agreement_signed,
          signature_data, custom_answers,
          id_front_url, id_back_url, selfie_url
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15,
          $16, $17, $18,
          $19, $20,
          $21, $22, $23
        ) RETURNING id`,
        [
          property.id, property.account_id, reservationId, pmsType,
          firstName, lastName, req.body.email || '', req.body.phone || '',
          req.body.address || '', parseInt(req.body.num_guests) || null,
          req.body.arrival_eta || '', req.body.flight_info || '',
          req.body.special_requests || '', req.body.vehicle_make_model || '',
          req.body.vehicle_license_plate || '',
          req.body.vehicle_color || '',
          req.body.house_rules_accepted === 'true',
          req.body.rental_agreement_signed === 'true',
          req.body.signature || null,
          customAnswers,
          idFrontUrl, idBackUrl, selfieUrl,
        ]
      );

      // Store file records
      const submissionId = insertResult.rows[0].id;
      const files = [];
      if (req.files?.id_front?.[0]) {
        files.push({ submissionId, type: 'id_front', file: req.files.id_front[0] });
      }
      if (req.files?.id_back?.[0]) {
        files.push({ submissionId, type: 'id_back', file: req.files.id_back[0] });
      }
      if (req.files?.selfie?.[0]) {
        files.push({ submissionId, type: 'selfie', file: req.files.selfie[0] });
      }

      for (const f of files) {
        await db.query(
          `INSERT INTO checkin_uploads (submission_id, file_type, file_name, file_url, file_size, mime_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [f.submissionId, f.type, f.file.originalname, `/uploads/${f.file.filename}`,
           f.file.size, f.file.mimetype]
        );
      }

      // Log the successful check-in
      db.query(
        'INSERT INTO checkin_logs (property_id, account_id, guest_last_name, result) VALUES ($1, $2, $3, $4)',
        [property.id, property.account_id, lastName, 'checkin_submitted']
      ).catch(err => console.error('Log error:', err));

      return res.json({
        status: 'success',
        submissionId: submissionId,
        message: 'Check-in submitted successfully.',
      });

    } catch (err) {
      console.error('Check-in submission error:', err);
      return res.status(500).json({
        error: 'submission_error',
        message: 'Failed to submit check-in. Please try again.',
      });
    }
  }
);

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /api/pms-types â List supported PMS platforms (public)
// Used by dashboard to show PMS selection
// âââââââââââââââââââââââââââââââââââââââââââââââââ
router.get('/api/pms-types', (req, res) => {
  const { getPMSList } = require('../lib/pms');
  res.json(getPMSList());
});

// âââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /embed/:accountSlug/:propertySlug â Embeddable check-in widget
// âââââââââââââââââââââââââââââââââââââââââââââââââ
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

  res.sendFile(path.join(__dirname, '..', 'public', 'checkin.html'));
});

function notFoundPage() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not Found</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fc;color:#1a1a2e;text-align:center;padding:20px;}
.msg{max-width:400px;}.msg h1{font-size:72px;margin-bottom:8px;}.msg p{color:#718096;font-size:16px;}</style></head>
<body><div class="msg"><h1>404</h1><p>Property not found. Please check the URL or scan the QR code again.</p></div></body></html>`;
}

module.exports = router;
