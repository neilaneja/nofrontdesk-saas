const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../lib/db');
const { createAdapter } = require('../lib/pms');

const router = express.Router();

// ---------------------------------------------
// File upload configuration (for ID photos, selfies)
// ---------------------------------------------
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

// ---------------------------------------------
// GET /c/:accountSlug/:propertySlug - Guest check-in page
// ---------------------------------------------
router.get('/c/:accountSlug/:propertySlug', async (req, res) => {
  const { accountSlug, propertySlug } = req.params;

  const result = await db.query(
    `SELECT p.*, a.slug as account_slug FROM properties p
     JOIN accounts a ON p.account_id = a.id
     WHERE a.slug = $1 AND p.slug = $2`,
    [accountSlug, propertySlug]
  );

  if (result.rows.length === 0) {
    return res.status(404).send(notFoundPage());
  }

  res.sendFile(path.join(__dirname, '..', 'public', 'checkin.html'));
});

// ---------------------------------------------
// GET /checkin-form - NoFrontDesk built-in check-in form
// ---------------------------------------------
router.get('/checkin-form', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'checkin-form.html'));
});

// ---------------------------------------------
// GET /api/property/:accountSlug/:propertySlug - Property config (public)
// Returns branding info + check-in form configuration + deposit settings
// ---------------------------------------------
router.get('/api/property/:accountSlug/:propertySlug', async (req, res) => {
  const { accountSlug, propertySlug } = req.params;

  const result = await db.query(
    `SELECT p.name, p.welcome_message, p.require_confirmation_code,
            p.logo_url, p.brand_color, p.accent_color, p.fallback_phone,
            p.checkin_form_mode, p.custom_checkin_url, p.checkin_form_config,
            p.deposit_enabled, p.deposit_amount_cents, p.deposit_type, p.payment_description,
            a.stripe_connect_id, a.stripe_connect_onboarded
     FROM properties p
     JOIN accounts a ON p.account_id = a.id
     WHERE a.slug = $1 AND p.slug = $2`,
    [accountSlug, propertySlug]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Property not found' });
  }

  const p = result.rows[0];

  // Only expose deposit info if Stripe is connected and deposits are enabled
  const depositInfo = (p.deposit_enabled && p.stripe_connect_onboarded) ? {
    depositEnabled: true,
    depositAmountCents: p.deposit_amount_cents,
    depositType: p.deposit_type || 'charge',
    paymentDescription: p.payment_description || 'Security Deposit',
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  } : {
    depositEnabled: false,
  };

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
    ...depositInfo,
  });
});

// ---------------------------------------------
// GET /api/property-by-host - Resolve property by custom domain hostname
// Used by checkin.html when served on a custom domain (no slugs in URL)
router.get('/api/property-by-host', async (req, res) => {
  const host = (req.hostname || req.headers.host || '').split(':')[0].toLowerCase();

  const result = await db.query(
    `SELECT p.name, p.welcome_message, p.require_confirmation_code,
            p.logo_url, p.brand_color, p.accent_color, p.fallback_phone,
            p.checkin_form_mode, p.custom_checkin_url, p.checkin_form_config,
            p.deposit_enabled, p.deposit_amount_cents, p.deposit_type, p.payment_description,
            p.slug as property_slug, a.slug as account_slug,
            a.stripe_connect_id, a.stripe_connect_onboarded
     FROM properties p
     JOIN accounts a ON p.account_id = a.id
     WHERE p.custom_domain = $1 AND p.custom_domain_verified = true`,
    [host]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Property not found for this domain' });
  }

  const p = result.rows[0];
  const depositInfo = (p.deposit_enabled && p.stripe_connect_onboarded) ? {
    depositEnabled: true,
    depositAmountCents: p.deposit_amount_cents,
    depositType: p.deposit_type || 'charge',
    paymentDescription: p.payment_description || 'Security Deposit',
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  } : { depositEnabled: false };

  res.json({
    accountSlug: p.account_slug,
    propertySlug: p.property_slug,
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
    ...depositInfo,
  });
});

// POST /api/checkin/create-payment-intent - Create a payment intent for check-in deposit
// Called by the check-in form when deposit is required
// ---------------------------------------------
router.post('/api/checkin/create-payment-intent', express.json(), async (req, res) => {
  try {
    const { accountSlug, propertySlug, guestName, guestEmail, reservationId } = req.body;

    if (!accountSlug || !propertySlug) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Get property and account
    const propResult = await db.query(
      `SELECT p.*, a.id as account_id, a.stripe_connect_id, a.stripe_connect_onboarded
       FROM properties p
       JOIN accounts a ON p.account_id = a.id
       WHERE a.slug = $1 AND p.slug = $2`,
      [accountSlug, propertySlug]
    );

    if (propResult.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found.' });
    }

    const property = propResult.rows[0];

    if (!property.deposit_enabled || !property.stripe_connect_onboarded || !property.stripe_connect_id) {
      return res.status(400).json({ error: 'Deposits not configured for this property.' });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const amountCents = property.deposit_amount_cents || 5000; // default $50

    if (property.deposit_type === 'hold') {
      // Create a SetupIntent for pre-authorization hold
      // We'll create the actual hold after the card is confirmed
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        capture_method: 'manual', // This creates a hold, not a charge
        description: property.payment_description || 'Security Deposit Hold',
        metadata: {
          property_id: property.id.toString(),
          account_id: property.account_id.toString(),
          guest_name: guestName || '',
          guest_email: guestEmail || '',
          reservation_id: reservationId || '',
          type: 'hold',
        },
      }, {
        stripeAccount: property.stripe_connect_id,
      });

      return res.json({
        clientSecret: paymentIntent.client_secret,
        type: 'hold',
        amount: amountCents,
      });
    } else {
      // Create a PaymentIntent for immediate charge
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        description: property.payment_description || 'Security Deposit',
        metadata: {
          property_id: property.id.toString(),
          account_id: property.account_id.toString(),
          guest_name: guestName || '',
          guest_email: guestEmail || '',
          reservation_id: reservationId || '',
          type: 'charge',
        },
      }, {
        stripeAccount: property.stripe_connect_id,
      });

      return res.json({
        clientSecret: paymentIntent.client_secret,
        type: 'charge',
        amount: amountCents,
      });
    }
  } catch (err) {
    console.error('Create payment intent error:', err);
    return res.status(500).json({ error: 'Failed to initialize payment.' });
  }
});

// ---------------------------------------------
// POST /api/checkin/confirm-deposit - Record a completed deposit payment
// Called after Stripe confirms the payment on the client side
// ---------------------------------------------
router.post('/api/checkin/confirm-deposit', express.json(), async (req, res) => {
  try {
    const { accountSlug, propertySlug, paymentIntentId, guestName, guestEmail, reservationId } = req.body;

    if (!accountSlug || !propertySlug || !paymentIntentId) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const propResult = await db.query(
      `SELECT p.*, a.id as account_id, a.stripe_connect_id
       FROM properties p
       JOIN accounts a ON p.account_id = a.id
       WHERE a.slug = $1 AND p.slug = $2`,
      [accountSlug, propertySlug]
    );

    if (propResult.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found.' });
    }

    const property = propResult.rows[0];

    // Verify the payment intent with Stripe
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      stripeAccount: property.stripe_connect_id,
    });

    const type = paymentIntent.capture_method === 'manual' ? 'hold' : 'charge';
    const status = type === 'hold' ? 'held' : 'paid';

    // Record in guest_payments table
    await db.query(
      `INSERT INTO guest_payments (account_id, property_id, guest_name, guest_email, reservation_id, type, status, amount_cents, stripe_payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [property.account_id, property.id, guestName || '', guestEmail || '',
       reservationId || '', type, status, paymentIntent.amount,
       paymentIntentId, property.payment_description || 'Security Deposit']
    );

    return res.json({ status: 'success', paymentStatus: status });
  } catch (err) {
    console.error('Confirm deposit error:', err);
    return res.status(500).json({ error: 'Failed to confirm payment.' });
  }
});

// ---------------------------------------------
// POST /api/lookup - Reservation lookup (public)
// ---------------------------------------------
router.post('/api/lookup', async (req, res) => {
  const { lastName, accountSlug, propertySlug, confirmationCode } = req.body;

  if (!lastName || !accountSlug || !propertySlug) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
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
    const pmsCredentials = { ...credentials, accountId: property.account_id };
    const adapter = createAdapter(pms_type, pmsCredentials);

    let results = await adapter.searchReservations(lastName);

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

    const propertyConfig = {
      guestyGuestAppName: property.guesty_guest_app_name || '',
      pmsType: pms_type,
      checkinFormMode: property.checkin_form_mode || 'auto',
      customCheckinUrl: property.custom_checkin_url || '',
    };

    const buildUrl = (r) => {
      const url = adapter.resolveCheckInUrl(r, propertyConfig);
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

// ---------------------------------------------
// POST /api/checkin/submit - Submit check-in form (public)
// ---------------------------------------------
router.post('/api/checkin/submit', upload.fields([
  { name: 'id_front', maxCount: 1 },
  { name: 'id_back', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
]), async (req, res) => {
  try {
    const { accountSlug, propertySlug, reservationId } = req.body;

    if (!accountSlug || !propertySlug) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

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

    const credResult = await db.query(
      `SELECT pms_type FROM api_credentials WHERE account_id = $1`,
      [property.account_id]
    );
    const pmsType = credResult.rows[0]?.pms_type || 'unknown';

    const fullName = req.body.full_name || '';
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const idFrontUrl = req.files?.id_front?.[0] ? `/uploads/${req.files.id_front[0].filename}` : null;
    const idBackUrl = req.files?.id_back?.[0] ? `/uploads/${req.files.id_back[0].filename}` : null;
    const selfieUrl = req.files?.selfie?.[0] ? `/uploads/${req.files.selfie[0].filename}` : null;

    let customAnswers = {};
    try { customAnswers = JSON.parse(req.body.custom_answers || '{}'); } catch (e) { /* ignore */ }

    const insertResult = await db.query(
      `INSERT INTO checkin_submissions (
        property_id, account_id, reservation_id, pms_type,
        guest_first_name, guest_last_name, guest_email, guest_phone, guest_address,
        num_guests, arrival_eta, flight_info, special_requests,
        vehicle_make_model, vehicle_license_plate, vehicle_color,
        house_rules_accepted, rental_agreement_signed, signature_data,
        custom_answers, id_front_url, id_back_url, selfie_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
      ) RETURNING id`,
      [
        property.id, property.account_id, reservationId, pmsType,
        firstName, lastName, req.body.email || '', req.body.phone || '',
        req.body.address || '', parseInt(req.body.num_guests) || null,
        req.body.arrival_eta || '', req.body.flight_info || '',
        req.body.special_requests || '', req.body.vehicle_make_model || '',
        req.body.vehicle_license_plate || '', req.body.vehicle_color || '',
        req.body.house_rules_accepted === 'true',
        req.body.rental_agreement_signed === 'true',
        req.body.signature || null, customAnswers,
        idFrontUrl, idBackUrl, selfieUrl,
      ]
    );

    const submissionId = insertResult.rows[0].id;
    const files = [];
    if (req.files?.id_front?.[0]) files.push({ submissionId, type: 'id_front', file: req.files.id_front[0] });
    if (req.files?.id_back?.[0]) files.push({ submissionId, type: 'id_back', file: req.files.id_back[0] });
    if (req.files?.selfie?.[0]) files.push({ submissionId, type: 'selfie', file: req.files.selfie[0] });

    for (const f of files) {
      await db.query(
        `INSERT INTO checkin_uploads (submission_id, file_type, file_name, file_url, file_size, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [f.submissionId, f.type, f.file.originalname, `/uploads/${f.file.filename}`, f.file.size, f.file.mimetype]
      );
    }

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
});

// ---------------------------------------------
// GET /api/pms-types - List supported PMS platforms (public)
// ---------------------------------------------
router.get('/api/pms-types', (req, res) => {
  const { getPMSList } = require('../lib/pms');
  res.json(getPMSList());
});

// ---------------------------------------------
// GET /embed/:accountSlug/:propertySlug - Embeddable check-in widget
// ---------------------------------------------
router.get('/embed/:accountSlug/:propertySlug', async (req, res) => {
  const { accountSlug, propertySlug } = req.params;

  const result = await db.query(
    `SELECT p.*, a.slug as account_slug FROM properties p
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
