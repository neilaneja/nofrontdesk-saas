const express = require('express');
const db = require('../lib/db');
const { requireLogin } = require('../lib/auth');
const router = express.Router();

// âââââââââââââââââââââââââââââââââââââââââââââ
// Helper: escape HTML
// âââââââââââââââââââââââââââââââââââââââââââââ
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Helper: get Stripe instance
// âââââââââââââââââââââââââââââââââââââââââââââ
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Helper: format currency
// âââââââââââââââââââââââââââââââââââââââââââââ
function formatCents(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function formatDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// âââââââââââââââââââââââââââââââââââââââââââââ
// STRIPE CONNECT -- One-click onboarding
// âââââââââââââââââââââââââââââââââââââââââââââ

// GET /dashboard/payments/connect -- Start Stripe Connect onboarding
router.get('/dashboard/payments/connect', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.redirect('/dashboard/payments?error=Stripe+not+configured');

  const accountRes = await db.query('SELECT * FROM accounts WHERE id = $1', [req.session.accountId]);
  const account = accountRes.rows[0];

  try {
    let connectId = account.stripe_connect_id;

    // Create a Connect account if we don't have one
    if (!connectId) {
      const connectAccount = await stripe.accounts.create({
        type: 'standard',
        email: account.email,
        metadata: { accountId: account.id.toString() },
      });
      connectId = connectAccount.id;
      await db.query('UPDATE accounts SET stripe_connect_id = $1 WHERE id = $2', [connectId, account.id]);
    }

    // Create an account link for onboarding
    const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
    const accountLink = await stripe.accountLinks.create({
      account: connectId,
      refresh_url: `${baseUrl}/dashboard/payments/connect`,
      return_url: `${baseUrl}/dashboard/payments/connect/callback`,
      type: 'account_onboarding',
    });

    res.redirect(accountLink.url);
  } catch (err) {
    console.error('Stripe Connect error:', err);
    res.redirect('/dashboard/payments?error=Could+not+start+Stripe+onboarding');
  }
});

// GET /dashboard/payments/connect/callback -- After Stripe onboarding
router.get('/dashboard/payments/connect/callback', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.redirect('/dashboard/payments');

  const accountRes = await db.query('SELECT stripe_connect_id FROM accounts WHERE id = $1', [req.session.accountId]);
  const connectId = accountRes.rows[0]?.stripe_connect_id;

  if (!connectId) return res.redirect('/dashboard/payments?error=No+connect+account');

  try {
    // Check if onboarding is complete
    const connectAccount = await stripe.accounts.retrieve(connectId);
    const onboarded = connectAccount.charges_enabled && connectAccount.payouts_enabled;

    await db.query('UPDATE accounts SET stripe_connect_onboarded = $1 WHERE id = $2', [onboarded, req.session.accountId]);

    if (onboarded) {
      res.redirect('/dashboard/payments?success=Stripe+connected+successfully');
    } else {
      res.redirect('/dashboard/payments?error=Stripe+onboarding+incomplete.+Click+Connect+to+resume.');
    }
  } catch (err) {
    console.error('Connect callback error:', err);
    res.redirect('/dashboard/payments?error=Something+went+wrong');
  }
});

// POST /dashboard/payments/disconnect -- Disconnect Stripe
router.post('/dashboard/payments/disconnect', requireLogin, async (req, res) => {
  await db.query('UPDATE accounts SET stripe_connect_id = NULL, stripe_connect_onboarded = FALSE WHERE id = $1', [req.session.accountId]);
  res.redirect('/dashboard/payments?success=Stripe+disconnected');
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// PAYMENT SETTINGS -- Per-property deposit config
// âââââââââââââââââââââââââââââââââââââââââââââ

// POST /dashboard/payments/settings/:propertyId -- Update deposit settings
router.post('/dashboard/payments/settings/:propertyId', requireLogin, async (req, res) => {
  const { depositEnabled, depositAmount, paymentDescription } = req.body;
  const amountCents = Math.round(parseFloat(depositAmount || 0) * 100);

  await db.query(
    `UPDATE properties SET deposit_enabled = $1, deposit_amount_cents = $2, payment_description = $3, updated_at = NOW()
     WHERE id = $4 AND account_id = $5`,
    [depositEnabled === 'on', amountCents, paymentDescription || 'Security Deposit', req.params.propertyId, req.session.accountId]
  );

  res.redirect('/dashboard/payments?success=Settings+saved');
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// CHARGE GUEST -- Create a one-time charge
// âââââââââââââââââââââââââââââââââââââââââââââ

router.post('/dashboard/payments/charge', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.redirect('/dashboard/payments?error=Stripe+not+configured');

  const { propertyId, guestName, guestEmail, amount, description } = req.body;
  const amountCents = Math.round(parseFloat(amount) * 100);

  if (!amountCents || amountCents < 50) {
    return res.redirect('/dashboard/payments?error=Minimum+charge+is+$0.50');
  }

  const accountRes = await db.query('SELECT stripe_connect_id, stripe_connect_onboarded FROM accounts WHERE id = $1', [req.session.accountId]);
  const account = accountRes.rows[0];

  if (!account.stripe_connect_id || !account.stripe_connect_onboarded) {
    return res.redirect('/dashboard/payments?error=Connect+your+Stripe+account+first');
  }

  try {
    // Create a PaymentIntent on the connected account
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      description: description || 'Guest charge',
      metadata: {
        accountId: req.session.accountId.toString(),
        propertyId: propertyId || '',
        guestName: guestName || '',
        guestEmail: guestEmail || '',
      },
    }, {
      stripeAccount: account.stripe_connect_id,
    });

    // Save to our DB
    await db.query(
      `INSERT INTO guest_payments (account_id, property_id, guest_name, guest_email, type, status, amount_cents, description, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, 'charge', 'pending', $5, $6, $7)`,
      [req.session.accountId, propertyId || null, guestName, guestEmail, amountCents, description || 'Guest charge', paymentIntent.id]
    );

    // Return the client secret for the embedded payment form
    res.redirect(`/dashboard/payments/collect?pi=${paymentIntent.id}&cs=${paymentIntent.client_secret}&name=${encodeURIComponent(guestName || '')}&amount=${amountCents}`);
  } catch (err) {
    console.error('Charge creation error:', err);
    res.redirect('/dashboard/payments?error=' + encodeURIComponent(err.message));
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// PRE-AUTH HOLD -- Place a hold on a card
// âââââââââââââââââââââââââââââââââââââââââââââ

router.post('/dashboard/payments/hold', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.redirect('/dashboard/payments?error=Stripe+not+configured');

  const { propertyId, guestName, guestEmail, amount, description } = req.body;
  const amountCents = Math.round(parseFloat(amount) * 100);

  if (!amountCents || amountCents < 50) {
    return res.redirect('/dashboard/payments?error=Minimum+hold+is+$0.50');
  }

  const accountRes = await db.query('SELECT stripe_connect_id, stripe_connect_onboarded FROM accounts WHERE id = $1', [req.session.accountId]);
  const account = accountRes.rows[0];

  if (!account.stripe_connect_id || !account.stripe_connect_onboarded) {
    return res.redirect('/dashboard/payments?error=Connect+your+Stripe+account+first');
  }

  try {
    // Create a PaymentIntent with manual capture (hold)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      capture_method: 'manual',  // THIS makes it a hold, not a charge
      description: description || 'Pre-authorization hold',
      metadata: {
        accountId: req.session.accountId.toString(),
        propertyId: propertyId || '',
        guestName: guestName || '',
        guestEmail: guestEmail || '',
        type: 'hold',
      },
    }, {
      stripeAccount: account.stripe_connect_id,
    });

    await db.query(
      `INSERT INTO guest_payments (account_id, property_id, guest_name, guest_email, type, status, amount_cents, description, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, 'hold', 'pending', $5, $6, $7)`,
      [req.session.accountId, propertyId || null, guestName, guestEmail, amountCents, description || 'Pre-authorization hold', paymentIntent.id]
    );

    res.redirect(`/dashboard/payments/collect?pi=${paymentIntent.id}&cs=${paymentIntent.client_secret}&name=${encodeURIComponent(guestName || '')}&amount=${amountCents}&hold=1`);
  } catch (err) {
    console.error('Hold creation error:', err);
    res.redirect('/dashboard/payments?error=' + encodeURIComponent(err.message));
  }
});

// POST /dashboard/payments/capture/:id -- Capture a held payment
router.post('/dashboard/payments/capture/:id', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.redirect('/dashboard/payments');

  const paymentRes = await db.query(
    'SELECT gp.*, a.stripe_connect_id FROM guest_payments gp JOIN accounts a ON gp.account_id = a.id WHERE gp.id = $1 AND gp.account_id = $2',
    [req.params.id, req.session.accountId]
  );
  const payment = paymentRes.rows[0];
  if (!payment) return res.redirect('/dashboard/payments');

  try {
    const captureAmount = req.body.captureAmount ? Math.round(parseFloat(req.body.captureAmount) * 100) : undefined;

    await stripe.paymentIntents.capture(
      payment.stripe_payment_intent_id,
      captureAmount ? { amount_to_capture: captureAmount } : {},
      { stripeAccount: payment.stripe_connect_id }
    );

    await db.query(
      "UPDATE guest_payments SET status = 'captured', updated_at = NOW() WHERE id = $1",
      [payment.id]
    );

    res.redirect('/dashboard/payments?success=Payment+captured');
  } catch (err) {
    console.error('Capture error:', err);
    res.redirect('/dashboard/payments?error=' + encodeURIComponent(err.message));
  }
});

// POST /dashboard/payments/release/:id -- Release (cancel) a hold
router.post('/dashboard/payments/release/:id', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.redirect('/dashboard/payments');

  const paymentRes = await db.query(
    'SELECT gp.*, a.stripe_connect_id FROM guest_payments gp JOIN accounts a ON gp.account_id = a.id WHERE gp.id = $1 AND gp.account_id = $2',
    [req.params.id, req.session.accountId]
  );
  const payment = paymentRes.rows[0];
  if (!payment) return res.redirect('/dashboard/payments');

  try {
    await stripe.paymentIntents.cancel(
      payment.stripe_payment_intent_id,
      { stripeAccount: payment.stripe_connect_id }
    );

    await db.query(
      "UPDATE guest_payments SET status = 'released', updated_at = NOW() WHERE id = $1",
      [payment.id]
    );

    res.redirect('/dashboard/payments?success=Hold+released');
  } catch (err) {
    console.error('Release error:', err);
    res.redirect('/dashboard/payments?error=' + encodeURIComponent(err.message));
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// REFUND -- Refund a completed charge or deposit
// âââââââââââââââââââââââââââââââââââââââââââââ

router.post('/dashboard/payments/refund/:id', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.redirect('/dashboard/payments');

  const paymentRes = await db.query(
    'SELECT gp.*, a.stripe_connect_id FROM guest_payments gp JOIN accounts a ON gp.account_id = a.id WHERE gp.id = $1 AND gp.account_id = $2',
    [req.params.id, req.session.accountId]
  );
  const payment = paymentRes.rows[0];
  if (!payment) return res.redirect('/dashboard/payments');

  try {
    const refund = await stripe.refunds.create({
      payment_intent: payment.stripe_payment_intent_id,
    }, {
      stripeAccount: payment.stripe_connect_id,
    });

    await db.query(
      "UPDATE guest_payments SET status = 'refunded', stripe_refund_id = $1, updated_at = NOW() WHERE id = $2",
      [refund.id, payment.id]
    );

    res.redirect('/dashboard/payments?success=Payment+refunded');
  } catch (err) {
    console.error('Refund error:', err);
    res.redirect('/dashboard/payments?error=' + encodeURIComponent(err.message));
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// GUEST-FACING: Payment collection page (Stripe Elements)
// âââââââââââââââââââââââââââââââââââââââââââââ

router.get('/dashboard/payments/collect', requireLogin, async (req, res) => {
  const { pi, cs, name, amount, hold } = req.query;

  const accountRes = await db.query('SELECT stripe_connect_id FROM accounts WHERE id = $1', [req.session.accountId]);
  const connectId = accountRes.rows[0]?.stripe_connect_id;

  res.send(paymentCollectPage(pi, cs, name, amount, hold === '1', connectId));
});

// Public guest payment page (for links sent to guests)
router.get('/pay/:token', async (req, res) => {
  const paymentRes = await db.query(
    `SELECT gp.*, a.stripe_connect_id, p.name as property_name, a.company_name
     FROM guest_payments gp
     JOIN accounts a ON gp.account_id = a.id
     LEFT JOIN properties p ON gp.property_id = p.id
     WHERE gp.id = $1 AND gp.status = 'pending'`,
    [req.params.token]
  );

  if (paymentRes.rows.length === 0) {
    return res.status(404).send('Payment not found or already completed.');
  }

  const payment = paymentRes.rows[0];
  res.send(guestPaymentPage(payment));
});

// API: Confirm payment status (called by Stripe Elements JS)
router.post('/api/payments/confirm', express.json(), async (req, res) => {
  const { paymentIntentId, status } = req.body;

  if (status === 'succeeded') {
    await db.query(
      "UPDATE guest_payments SET status = 'succeeded', updated_at = NOW() WHERE stripe_payment_intent_id = $1",
      [paymentIntentId]
    );
  } else if (status === 'requires_capture') {
    await db.query(
      "UPDATE guest_payments SET status = 'held', updated_at = NOW() WHERE stripe_payment_intent_id = $1",
      [paymentIntentId]
    );
  }

  res.json({ ok: true });
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// DEPOSIT -- Auto-charge during check-in
// âââââââââââââââââââââââââââââââââââââââââââââ

// API endpoint called during check-in flow to create a deposit hold
router.post('/api/payments/deposit', express.json(), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const { propertyId, guestName, guestEmail, reservationId } = req.body;

  try {
    // Look up property and account
    const propRes = await db.query(
      `SELECT p.*, a.stripe_connect_id, a.stripe_connect_onboarded, a.id as account_id
       FROM properties p JOIN accounts a ON p.account_id = a.id
       WHERE p.id = $1 AND p.deposit_enabled = true`,
      [propertyId]
    );

    if (propRes.rows.length === 0) {
      return res.json({ deposit_required: false });
    }

    const prop = propRes.rows[0];

    if (!prop.stripe_connect_id || !prop.stripe_connect_onboarded) {
      return res.json({ deposit_required: false, reason: 'Stripe not connected' });
    }

    if (!prop.deposit_amount_cents || prop.deposit_amount_cents < 50) {
      return res.json({ deposit_required: false });
    }

    // Create a hold (manual capture) for the deposit
    const paymentIntent = await stripe.paymentIntents.create({
      amount: prop.deposit_amount_cents,
      currency: 'usd',
      capture_method: 'manual',
      description: prop.payment_description || 'Security Deposit',
      metadata: {
        accountId: prop.account_id.toString(),
        propertyId: propertyId.toString(),
        guestName: guestName || '',
        reservationId: reservationId || '',
        type: 'deposit',
      },
    }, {
      stripeAccount: prop.stripe_connect_id,
    });

    // Record in DB
    await db.query(
      `INSERT INTO guest_payments (account_id, property_id, guest_name, guest_email, reservation_id, type, status, amount_cents, description, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, 'deposit', 'pending', $6, $7, $8)`,
      [prop.account_id, propertyId, guestName, guestEmail, reservationId, prop.deposit_amount_cents, prop.payment_description || 'Security Deposit', paymentIntent.id]
    );

    res.json({
      deposit_required: true,
      client_secret: paymentIntent.client_secret,
      amount: prop.deposit_amount_cents,
      description: prop.payment_description,
      connect_account_id: prop.stripe_connect_id,
    });
  } catch (err) {
    console.error('Deposit creation error:', err);
    res.status(500).json({ error: err.message });
  }
});
// âââââââââââââââââââââââââââââââââââââââââââââ
// DASHBOARD â Payments management page
// âââââââââââââââââââââââââââââââââââââââââââââ

router.get('/dashboard/payments', requireLogin, async (req, res) => {
  const accountRes = await db.query('SELECT * FROM accounts WHERE id = $1', [req.session.accountId]);
  const account = accountRes.rows[0];

  const propertiesRes = await db.query('SELECT * FROM properties WHERE account_id = $1 ORDER BY name', [req.session.accountId]);
  const properties = propertiesRes.rows;

  const paymentsRes = await db.query(
    `SELECT gp.*, p.name as property_name
     FROM guest_payments gp
     LEFT JOIN properties p ON gp.property_id = p.id
     WHERE gp.account_id = $1
     ORDER BY gp.created_at DESC
     LIMIT 50`,
    [req.session.accountId]
  );
  const payments = paymentsRes.rows;

  const connected = account.stripe_connect_id && account.stripe_connect_onboarded;
  const stripe = getStripe();
  const stripeConfigured = !!stripe;

  res.send(paymentsPage(account, properties, payments, connected, stripeConfigured));
});
// âââââââââââââââââââââââââââââââââââââââââââââ
// PAGE TEMPLATES
// âââââââââââââââââââââââââââââââââââââââââââââ

function paymentsPage(account, properties, payments, connected, stripeConfigured) {
  const successMsg = '';
  const errorMsg = '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payments â NoFrontDesk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; color: #1a1a2e; }
    .topnav { background: #1a1a2e; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
    .topnav .logo { color: white; font-size: 20px; font-weight: 800; text-decoration: none; }
    .topnav .logo span { color: #e94560; }
    .topnav-right { display: flex; align-items: center; gap: 20px; }
    .topnav-right a { color: #a0aec0; text-decoration: none; font-size: 14px; }
    .topnav-right a:hover { color: white; }
    .topnav-right a.active { color: #e94560; }
    .company-badge { color: #e2e8f0; font-size: 14px; font-weight: 500; }
    .main { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #718096; text-decoration: none; font-size: 14px; }
    .back-link:hover { color: #1a1a2e; }

    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .card h3 { font-size: 18px; margin-bottom: 12px; }
    .card p { color: #718096; font-size: 14px; line-height: 1.6; }

    .connect-status { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .status-dot { width: 12px; height: 12px; border-radius: 50%; }
    .status-dot.green { background: #38a169; }
    .status-dot.red { background: #e53e3e; }
    .status-text { font-size: 15px; font-weight: 600; }

    .btn { display: inline-flex; align-items: center; padding: 10px 20px; background: #e94560; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: background 0.2s; }
    .btn:hover { background: #d63851; }
    .btn-sm { padding: 6px 14px; font-size: 13px; }
    .btn-outline { background: transparent; color: #1a1a2e; border: 2px solid #e2e8f0; }
    .btn-outline:hover { border-color: #1a1a2e; background: transparent; }
    .btn-green { background: #38a169; }
    .btn-green:hover { background: #2f855a; }
    .btn-yellow { background: #d69e2e; }
    .btn-yellow:hover { background: #b7791f; }
    .btn-danger { background: transparent; color: #e53e3e; border: 1px solid #e53e3e; }
    .btn-danger:hover { background: #fff5f5; }

    .tabs { display: flex; gap: 0; margin-bottom: 24px; border-bottom: 2px solid #e2e8f0; }
    .tab { padding: 10px 20px; font-size: 14px; font-weight: 600; color: #718096; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; text-decoration: none; }
    .tab:hover { color: #1a1a2e; }
    .tab.active { color: #e94560; border-bottom-color: #e94560; }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 14px; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
    .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px 14px; font-size: 15px; border: 2px solid #e2e8f0; border-radius: 8px; outline: none; font-family: inherit; }
    .form-group input:focus, .form-group select:focus { border-color: #e94560; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .hint { font-size: 12px; color: #a0aec0; margin-top: 4px; }

    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 10px 12px; color: #718096; font-weight: 600; border-bottom: 2px solid #e2e8f0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 12px; border-bottom: 1px solid #f0f0f0; }
    tr:hover { background: #fafbfc; }

    .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
    .badge-pending { background: #fefcbf; color: #d69e2e; }
    .badge-succeeded { background: #c6f6d5; color: #38a169; }
    .badge-held { background: #bee3f8; color: #3182ce; }
    .badge-captured { background: #c6f6d5; color: #38a169; }
    .badge-released { background: #e2e8f0; color: #718096; }
    .badge-refunded { background: #fed7d7; color: #e53e3e; }
    .badge-failed { background: #fed7d7; color: #e53e3e; }

    .success-msg { background: #f0fff4; color: #38a169; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #c6f6d5; }
    .error-msg { background: #fff5f5; color: #e53e3e; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #fed7d7; }

    .empty-state { text-align: center; padding: 40px 20px; color: #718096; }

    .property-settings { border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 12px; }
    .property-settings h4 { font-size: 15px; margin-bottom: 10px; }

    .action-btns { display: flex; gap: 6px; }

    @media (max-width: 640px) {
      .form-row { grid-template-columns: 1fr; }
      .tabs { overflow-x: auto; }
      table { font-size: 13px; }
    }
  </style>
</head>
<body>
  <nav class="topnav">
    <a href="/dashboard" class="logo">No<span>FrontDesk</span></a>
    <div class="topnav-right">
      <span class="company-badge">${esc(account.company_name)}</span>
      <a href="/dashboard">Dashboard</a>
      <a href="/dashboard/payments" class="active">Payments</a>
      <a href="/dashboard/billing">Billing</a>
      <a href="/logout">Log out</a>
    </div>
  </nav>

  <div class="main">
    <a href="/dashboard" class="back-link">&larr; Back to Dashboard</a>
    <h1 style="font-size:28px;margin-bottom:24px;">Guest Payments</h1>

    <script>
      const params = new URLSearchParams(window.location.search);
      if (params.get('success')) document.write('<div class="success-msg">' + decodeURIComponent(params.get('success')) + '</div>');
      if (params.get('error')) document.write('<div class="error-msg">' + decodeURIComponent(params.get('error')) + '</div>');
    </script>


    <!-- Stripe Connect Status -->
    <div class="card">
      <h3>Stripe Connection</h3>
      <div class="connect-status">
        <div class="status-dot ${connected ? 'green' : 'red'}"></div>
        <span class="status-text">${connected ? 'Connected' : 'Not Connected'}</span>
      </div>
      <p>${connected
        ? 'Your Stripe account is connected. Guest payments will go directly to your Stripe account.'
        : 'Connect your Stripe account to start accepting guest payments, security deposits, and pre-authorization holds.'
      }</p>
      <div style="margin-top:16px;">
        ${connected
          ? `<form method="POST" action="/dashboard/payments/disconnect" style="display:inline;">
               <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Disconnect Stripe? You won\\'t be able to process guest payments.')">Disconnect</button>
             </form>`
          : stripeConfigured
            ? `<a href="/dashboard/payments/connect" class="btn">Connect Stripe Account</a>`
            : `<button class="btn" disabled style="opacity:0.5;cursor:default;">Stripe Not Configured</button>`
        }
      </div>
    </div>

    ${connected ? `
    <!-- Tabs -->
    <div class="tabs">
      <a class="tab active" onclick="showTab('actions')">New Payment</a>
      <a class="tab" onclick="showTab('deposits')">Deposit Settings</a>
      <a class="tab" onclick="showTab('history')">Payment History</a>
    </div>

    <!-- TAB: New Payment -->
    <div class="tab-content active" id="tab-actions">
      <div class="card">
        <h3>Charge a Guest</h3>
        <p style="margin-bottom:16px;">Create a one-time charge. The guest will enter their card details on a secure payment page.</p>
        <form method="POST" action="/dashboard/payments/charge">
          <div class="form-row">
            <div class="form-group">
              <label>Guest Name</label>
              <input type="text" name="guestName" placeholder="John Smith" required>
            </div>
            <div class="form-group">
              <label>Guest Email</label>
              <input type="email" name="guestEmail" placeholder="guest@email.com">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Amount ($)</label>
              <input type="number" name="amount" step="0.01" min="0.50" placeholder="100.00" required>
            </div>
            <div class="form-group">
              <label>Property</label>
              <select name="propertyId">
                <option value="">â Select â</option>
                ${properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Description</label>
            <input type="text" name="description" placeholder="e.g. Late checkout fee, extra cleaning">
          </div>
          <button type="submit" class="btn">Create Charge</button>
        </form>
      </div>

      <div class="card">
        <h3>Pre-Authorization Hold</h3>
        <p style="margin-bottom:16px;">Place a hold on a guest's card without charging. You can capture or release the hold later (holds expire after 7 days).</p>
        <form method="POST" action="/dashboard/payments/hold">
          <div class="form-row">
            <div class="form-group">
              <label>Guest Name</label>
              <input type="text" name="guestName" placeholder="John Smith" required>
            </div>
            <div class="form-group">
              <label>Guest Email</label>
              <input type="email" name="guestEmail" placeholder="guest@email.com">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Hold Amount ($)</label>
              <input type="number" name="amount" step="0.01" min="0.50" placeholder="500.00" required>
            </div>
            <div class="form-group">
              <label>Property</label>
              <select name="propertyId">
                <option value="">â Select â</option>
                ${properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Description</label>
            <input type="text" name="description" placeholder="e.g. Damage deposit hold">
          </div>
          <button type="submit" class="btn btn-yellow">Place Hold</button>
        </form>
      </div>
    </div>

    <!-- TAB: Deposit Settings -->
    <div class="tab-content" id="tab-deposits">
      <div class="card">
        <h3>Automatic Security Deposits</h3>
        <p style="margin-bottom:16px;">When enabled, guests will be asked to provide a card for a security deposit hold during check-in. The hold is placed automatically and you can capture or release it from the Payment History tab.</p>

        ${properties.length === 0 ? `
          <div class="empty-state">No properties yet. Add a property first.</div>
        ` : properties.map(p => `
          <form method="POST" action="/dashboard/payments/settings/${p.id}" class="property-settings">
            <h4>${esc(p.name)}</h4>
            <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;">
              <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;">
                <input type="checkbox" name="depositEnabled" ${p.deposit_enabled ? 'checked' : ''} style="width:18px;height:18px;accent-color:#e94560;">
                Enable deposit
              </label>
              <div class="form-group" style="margin-bottom:0;flex:0 0 160px;">
                <label style="font-size:13px;">Amount ($)</label>
                <input type="number" name="depositAmount" step="0.01" min="0" value="${(p.deposit_amount_cents / 100).toFixed(2)}" style="padding:8px 12px;font-size:14px;">
              </div>
              <div class="form-group" style="margin-bottom:0;flex:1;min-width:200px;">
                <label style="font-size:13px;">Description</label>
                <input type="text" name="paymentDescription" value="${esc(p.payment_description || 'Security Deposit')}" style="padding:8px 12px;font-size:14px;">
              </div>
              <button type="submit" class="btn btn-sm btn-outline">Save</button>
            </div>
          </form>
        `).join('')}
      </div>
    </div>

    <!-- TAB: Payment History -->
    <div class="tab-content" id="tab-history">
      <div class="card" style="overflow-x:auto;">
        <h3>Recent Payments</h3>
        ${payments.length === 0 ? `
          <div class="empty-state">No payments yet.</div>
        ` : `
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Guest</th>
                <th>Property</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${payments.map(p => `
                <tr>
                  <td>${formatDate(p.created_at)}</td>
                  <td>${esc(p.guest_name || 'â')}</td>
                  <td>${esc(p.property_name || 'â')}</td>
                  <td>${p.type}</td>
                  <td><strong>${formatCents(p.amount_cents)}</strong></td>
                  <td><span class="badge badge-${p.status}">${p.status}</span></td>
                  <td>
                    <div class="action-btns">
                      ${p.status === 'held' ? `
                        <form method="POST" action="/dashboard/payments/capture/${p.id}" style="display:inline;">
                          <button type="submit" class="btn btn-sm btn-green" onclick="return confirm('Capture this ${formatCents(p.amount_cents)} hold?')">Capture</button>
                        </form>
                        <form method="POST" action="/dashboard/payments/release/${p.id}" style="display:inline;">
                          <button type="submit" class="btn btn-sm btn-outline" onclick="return confirm('Release this hold? The guest will not be charged.')">Release</button>
                        </form>
                      ` : ''}
                      ${(p.status === 'succeeded' || p.status === 'captured') ? `
                        <form method="POST" action="/dashboard/payments/refund/${p.id}" style="display:inline;">
                          <button type="submit" class="btn btn-sm btn-danger" onclick="return confirm('Refund ${formatCents(p.amount_cents)} to the guest?')">Refund</button>
                        </form>
                      ` : ''}
                      ${p.status === 'pending' ? `<span style="color:#a0aec0;font-size:13px;">Awaiting payment</span>` : ''}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>

    ` : `
    <div class="card">
      <div class="empty-state">
        <p style="font-size:16px;margin-bottom:12px;">Connect your Stripe account above to start managing guest payments.</p>
        <p>You'll be able to charge guests, place pre-authorization holds, and set up automatic security deposits.</p>
      </div>
    </div>
    `}
  </div>

  <script>
    function showTab(name) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
      event.target.classList.add('active');
    }
  </script>
</body>
</html>`;
}
function paymentCollectPage(pi, cs, name, amount, isHold, connectId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collect Payment â NoFrontDesk</title>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
    .payment-card { background: white; border-radius: 16px; padding: 36px; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .payment-card h2 { font-size: 22px; margin-bottom: 6px; }
    .payment-card .subtitle { color: #718096; font-size: 15px; margin-bottom: 24px; }
    .amount { font-size: 36px; font-weight: 800; margin-bottom: 4px; }
    .hold-badge { display: inline-block; background: #bee3f8; color: #3182ce; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 10px; margin-bottom: 16px; }
    #card-element { padding: 14px; border: 2px solid #e2e8f0; border-radius: 10px; margin-bottom: 20px; background: white; }
    #card-element.StripeElement--focus { border-color: #e94560; }
    #card-errors { color: #e53e3e; font-size: 14px; margin-bottom: 16px; min-height: 20px; }
    .pay-btn { width: 100%; padding: 14px; background: #e94560; color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s; }
    .pay-btn:hover { background: #d63851; }
    .pay-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .success-state { text-align: center; }
    .success-icon { font-size: 48px; margin-bottom: 12px; }
    .success-state h2 { color: #38a169; }
    .copy-link { margin-top: 20px; padding: 12px; background: #f7fafc; border-radius: 8px; font-size: 13px; word-break: break-all; }
    .copy-link button { margin-top: 8px; padding: 6px 14px; background: #e2e8f0; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="payment-card" id="payment-form-container">
    <h2>${isHold ? 'Pre-Authorization Hold' : 'Payment'}</h2>
    <p class="subtitle">for ${esc(decodeURIComponent(name || 'Guest'))}</p>
    <div class="amount">${formatCents(parseInt(amount || 0))}</div>
    ${isHold ? '<span class="hold-badge">Hold only â not charged yet</span>' : ''}

    <form id="payment-form" style="margin-top:20px;">
      <div id="card-element"></div>
      <div id="card-errors" role="alert"></div>
      <button type="submit" class="pay-btn" id="submit-btn">
        ${isHold ? 'Authorize Hold' : 'Pay Now'}
      </button>
    </form>

    <div class="copy-link">
      <strong>Guest payment link:</strong><br>
      <span id="payLink"></span>
      <button onclick="navigator.clipboard.writeText(document.getElementById('payLink').textContent).then(() => this.textContent = 'Copied!')">Copy Link</button>
    </div>
  </div>

  <div class="payment-card success-state" id="success-container" style="display:none;">
    <div class="success-icon">${'&#10003;'}</div>
    <h2>${isHold ? 'Hold Authorized' : 'Payment Successful'}</h2>
    <p class="subtitle" style="margin-top:8px;">
      ${isHold
        ? 'The hold has been placed. You can capture or release it from your dashboard.'
        : 'The payment has been processed successfully.'}
    </p>
    <a href="/dashboard/payments" class="pay-btn" style="display:inline-block;text-decoration:none;text-align:center;margin-top:20px;">Back to Dashboard</a>
  </div>

  <script>
    const stripe = Stripe('${process.env.STRIPE_PUBLISHABLE_KEY || ''}', {
      stripeAccount: '${connectId || ''}'
    });
    const elements = stripe.elements();
    const card = elements.create('card', {
      style: {
        base: { fontSize: '16px', color: '#1a1a2e', '::placeholder': { color: '#a0aec0' } },
        invalid: { color: '#e53e3e' }
      }
    });
    card.mount('#card-element');

    card.on('change', function(event) {
      document.getElementById('card-errors').textContent = event.error ? event.error.message : '';
    };

    // Set the guest payment link
    const payId = new URLSearchParams(window.location.search).get('pi');
    // We'll use the payment record ID for the guest link - for now show placeholder
    document.getElementById('payLink').textContent = window.location.origin + '/pay/' + (payId || '');

    const form = document.getElementById('payment-form');
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Processing...';

      const clientSecret = '${cs || ''}';
      const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card: card }
      });

      if (error) {
        document.getElementById('card-errors').textContent = error.message;
        btn.disabled = false;
        btn.textContent = '${isHold ? 'Authorize Hold' : 'Pay Now'}';
      } else {
        // Update our DB
        await fetch('/api/payments/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId: paymentIntent.id, status: paymentIntent.status })
        });

        document.getElementById('payment-form-container').style.display = 'none';
        document.getElementById('success-container').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}
function guestPaymentPage(payment) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment â ${esc(payment.company_name || 'NoFrontDesk')}</title>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fc; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
    .payment-card { background: white; border-radius: 16px; padding: 36px; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.1); text-align: center; }
    .company-name { font-size: 14px; color: #718096; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .payment-card h2 { font-size: 22px; margin-bottom: 6px; }
    .amount { font-size: 42px; font-weight: 800; margin: 16px 0; }
    .description { color: #718096; font-size: 15px; margin-bottom: 24px; }
    .hold-note { display: inline-block; background: #bee3f8; color: #3182ce; font-size: 13px; padding: 6px 14px; border-radius: 8px; margin-bottom: 20px; }
    #card-element { padding: 14px; border: 2px solid #e2e8f0; border-radius: 10px; margin-bottom: 20px; background: white; text-align: left; }
    #card-element.StripeElement--focus { border-color: #e94560; }
    #card-errors { color: #e53e3e; font-size: 14px; margin-bottom: 16px; min-height: 20px; }
    .pay-btn { width: 100%; padding: 14px; background: #e94560; color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; }
    .pay-btn:hover { background: #d63851; }
    .pay-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .success-icon { font-size: 56px; margin-bottom: 12px; }
    .powered-by { margin-top: 24px; font-size: 12px; color: #cbd5e0; }
    .powered-by a { color: #a0aec0; text-decoration: none; }
  </style>
</head>
<body>
  <div class="payment-card" id="payment-form-container">
    <div class="company-name">${esc(payment.company_name)}</div>
    ${payment.property_name ? `<h2>${esc(payment.property_name)}</h2>` : ''}
    <div class="amount">${formatCents(payment.amount_cents)}</div>
    <div class="description">${esc(payment.description)}</div>
    ${payment.type === 'hold' || payment.type === 'deposit' ? '<div class="hold-note">This is a hold â your card will not be charged immediately</div>' : ''}

    <form id="payment-form">
      <div id="card-element"></div>
      <div id="card-errors" role="alert"></div>
      <button type="submit" class="pay-btn" id="submit-btn">
        ${payment.type === 'hold' || payment.type === 'deposit' ? 'Authorize Hold' : 'Pay ' + formatCents(payment.amount_cents)}
      </button>
    </form>

    <div class="powered-by">Secured by Stripe &bull; <a href="https://nofrontdesk.com">NoFrontDesk</a></div>
  </div>

  <div class="payment-card" id="success-container" style="display:none;">
    <div class="success-icon">${'&#10003;'}</div>
    <h2 style="color:#38a169;">
      ${payment.type === 'hold' || payment.type === 'deposit' ? 'Hold Authorized' : 'Payment Complete'}
    </h2>
    <p style="color:#718096;margin-top:8px;">
      ${payment.type === 'deposit'
        ? 'Your security deposit hold has been placed. It will be released after checkout if there is no damage.'
        : payment.type === 'hold'
          ? 'The authorization hold has been placed on your card.'
          : 'Thank you for your payment!'}
    </p>
    <div class="powered-by" style="margin-top:32px;">Secured by Stripe &bull; <a href="https://nofrontdesk.com">NoFrontDesk</a></div>
  </div>

  <script>
    const stripe = Stripe('${process.env.STRIPE_PUBLISHABLE_KEY || ''}', {
      stripeAccount: '${payment.stripe_connect_id || ''}'
    });
    const elements = stripe.elements();
    const card = elements.create('card', {
      style: {
        base: { fontSize: '16px', color: '#1a1a2e', '::placeholder': { color: '#a0aec0' } },
        invalid: { color: '#e53e3e' }
      }
    });
    card.mount('#card-element');

    card.on('change', function(event) {
      document.getElementById('card-errors').textContent = event.error ? event.error.message : '';
    };

    const form = document.getElementById('payment-form');
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Processing...';

      // We need to create a PaymentIntent client secret for this guest payment
      // First, create the PI via our API
      const createRes = await fetch('/api/payments/guest-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: ${payment.id} })
      });
      const { client_secret } = await createRes.json();

      const { error, paymentIntent } = await stripe.confirmCardPayment(client_secret, {
        payment_method: { card: card }
      });

      if (error) {
        document.getElementById('card-errors').textContent = error.message;
        btn.disabled = false;
        btn.textContent = '${payment.type === 'hold' || payment.type === 'deposit' ? 'Authorize Hold' : 'Pay ' + formatCents(payment.amount_cents)}';
      } else {
        await fetch('/api/payments/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId: paymentIntent.id, status: paymentIntent.status })
        });
        document.getElementById('payment-form-container').style.display = 'none';
        document.getElementById('success-container').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

// API: Create client secret for guest payment page
router.post('/api/payments/guest-confirm', express.json(), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const { paymentId } = req.body;

  const paymentRes = await db.query(
    `SELECT gp.*, a.stripe_connect_id
     FROM guest_payments gp
     JOIN accounts a ON gp.account_id = a.id
     WHERE gp.id = $1 AND gp.status = 'pending'`,
    [paymentId]
  );

  if (paymentRes.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  const payment = paymentRes.rows[0];

  // If we already have a PI, return its client secret
  if (payment.stripe_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(
        payment.stripe_payment_intent_id,
        { stripeAccount: payment.stripe_connect_id }
      );
      return res.json({ client_secret: pi.client_secret });
    } catch (err) {
      console.error('PI retrieve error:', err);
    }
  }

  // Create a new PaymentIntent
  try {
    const captureMethod = (payment.type === 'hold' || payment.type === 'deposit') ? 'manual' : 'automatic';

    const pi = await stripe.paymentIntents.create({
      amount: payment.amount_cents,
      currency: payment.currency || 'usd',
      capture_method: captureMethod,
      description: payment.description,
      metadata: {
        paymentId: payment.id.toString(),
        guestName: payment.guest_name || '',
        type: payment.type,
      },
    }, {
      stripeAccount: payment.stripe_connect_id,
    });

    await db.query(
      'UPDATE guest_payments SET stripe_payment_intent_id = $1 WHERE id = $2',
      [pi.id, payment.id]
    );

    res.json({ client_secret: pi.client_secret });
  } catch (err) {
    console.error('Guest confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
