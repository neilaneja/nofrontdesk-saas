const express = require('express');
const db = require('../lib/db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();

// ─────────────────────────────────────────────
// Plan configuration
// ─────────────────────────────────────────────
const PLANS = {
  starter: { name: 'Starter', unitLimit: 5, monthlyPrice: 29 },
  growth:  { name: 'Growth',  unitLimit: 20, monthlyPrice: 59 },
  pro:     { name: 'Pro',     unitLimit: 50, monthlyPrice: 99 },
};

// ─────────────────────────────────────────────
// Helper: escape HTML
// ─────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// Helper: get Stripe instance (lazy-loaded)
// ─────────────────────────────────────────────
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ─────────────────────────────────────────────
// Helper: format date nicely
// ─────────────────────────────────────────────
function formatDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─────────────────────────────────────────────
// GET /dashboard/billing — Billing & Plan page
// ─────────────────────────────────────────────
router.get('/dashboard/billing', requireLogin, async (req, res) => {
  const accountRes = await db.query('SELECT * FROM accounts WHERE id = $1', [req.session.accountId]);
  const account = accountRes.rows[0];
  const propCountRes = await db.query('SELECT COUNT(*) as cnt FROM properties WHERE account_id = $1', [req.session.accountId]);
  const propertyCount = parseInt(propCountRes.rows[0].cnt, 10);

  const isTrialing = account.plan === 'trial';
  const trialExpired = isTrialing && account.trial_ends_at && new Date(account.trial_ends_at) < new Date();
  const trialDaysLeft = isTrialing && account.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(account.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
    : 0;

  const stripe = getStripe();
  const stripeConfigured = !!stripe;

  res.send(billingPage(account, propertyCount, isTrialing, trialExpired, trialDaysLeft, stripeConfigured));
});

// ─────────────────────────────────────────────
// POST /dashboard/billing/checkout — Create Stripe Checkout
// ─────────────────────────────────────────────
router.post('/dashboard/billing/checkout', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.redirect('/dashboard/billing?error=Billing+not+configured');
  }

  const { plan } = req.body;
  if (!PLANS[plan]) {
    return res.redirect('/dashboard/billing?error=Invalid+plan');
  }

  const accountRes = await db.query('SELECT * FROM accounts WHERE id = $1', [req.session.accountId]);
  const account = accountRes.rows[0];
  const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
  const priceId = process.env[`STRIPE_PRICE_${plan.toUpperCase()}`];

  if (!priceId) {
    return res.redirect('/dashboard/billing?error=Price+not+configured+for+this+plan');
  }

  try {
    // Create or retrieve Stripe customer
    let customerId = account.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: account.email,
        metadata: { accountId: account.id.toString(), companyName: account.company_name },
      });
      customerId = customer.id;
      await db.query('UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2', [customerId, account.id]);
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/dashboard/billing?success=1`,
      cancel_url: `${baseUrl}/dashboard/billing?cancelled=1`,
      metadata: { accountId: account.id.toString(), plan },
      subscription_data: {
        metadata: { accountId: account.id.toString(), plan },
      },
    });

    res.redirect(session.url);
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.redirect('/dashboard/billing?error=Something+went+wrong');
  }
});

// ─────────────────────────────────────────────
// POST /dashboard/billing/portal — Open Stripe Billing Portal
// ─────────────────────────────────────────────
router.post('/dashboard/billing/portal', requireLogin, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.redirect('/dashboard/billing');
  }

  const accountRes = await db.query('SELECT stripe_customer_id FROM accounts WHERE id = $1', [req.session.accountId]);
  const account = accountRes.rows[0];

  if (!account.stripe_customer_id) {
    return res.redirect('/dashboard/billing');
  }

  try {
    const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: account.stripe_customer_id,
      return_url: `${baseUrl}/dashboard/billing`,
    });
    res.redirect(portalSession.url);
  } catch (err) {
    console.error('Stripe portal error:', err);
    res.redirect('/dashboard/billing?error=Could+not+open+billing+portal');
  }
});

// ─────────────────────────────────────────────
// POST /webhooks/stripe — Stripe webhook handler
// NOTE: This must be mounted BEFORE body-parser (raw body needed)
// ─────────────────────────────────────────────
async function handleStripeWebhook(req, res) {
  const stripe = getStripe();
  if (!stripe) return res.status(400).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const accountId = session.metadata?.accountId;
        const plan = session.metadata?.plan;
        if (accountId && plan && PLANS[plan]) {
          await db.query(
            `UPDATE accounts SET
              stripe_subscription_id = $1,
              plan = $2,
              plan_unit_limit = $3,
              trial_ends_at = NULL,
              updated_at = NOW()
            WHERE id = $4`,
            [session.subscription, plan, PLANS[plan].unitLimit, parseInt(accountId, 10)]
          );
          console.log(`Account ${accountId} subscribed to ${plan}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const accountId = sub.metadata?.accountId;
        const plan = sub.metadata?.plan;
        if (accountId) {
          if (sub.status === 'active' && plan && PLANS[plan]) {
            await db.query(
              'UPDATE accounts SET plan = $1, plan_unit_limit = $2, updated_at = NOW() WHERE id = $3',
              [plan, PLANS[plan].unitLimit, parseInt(accountId, 10)]
            );
          } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
            console.log(`Account ${accountId} subscription status: ${sub.status}`);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const accountId = sub.metadata?.accountId;
        if (accountId) {
          await db.query(
            `UPDATE accounts SET
              plan = 'cancelled',
              stripe_subscription_id = NULL,
              updated_at = NOW()
            WHERE id = $1`,
            [parseInt(accountId, 10)]
          );
          console.log(`Account ${accountId} subscription cancelled`);
        }
        break;
      }

      default:
        console.log(`Unhandled webhook event: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
}

// ─────────────────────────────────────────────
// Billing Page Template
// ─────────────────────────────────────────────
function billingPage(account, propertyCount, isTrialing, trialExpired, trialDaysLeft, stripeConfigured) {
  const currentPlan = account.plan || 'trial';
  const successMsg = '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Billing — NoFrontDesk</title>
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

  .status-card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .status-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .plan-badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .plan-trial { background: #ebf8ff; color: #3182ce; }
  .plan-active { background: #f0fff4; color: #38a169; }
  .plan-expired { background: #fff5f5; color: #e53e3e; }
  .plan-cancelled { background: #fefcbf; color: #d69e2e; }

  .trial-warning { background: #fff5f5; border: 1px solid #fed7d7; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; color: #c53030; font-size: 14px; }
  .trial-info { background: #ebf8ff; border: 1px solid #bee3f8; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; color: #2b6cb0; font-size: 14px; }

  .plans-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 24px; }
  .plan-card { background: white; border-radius: 12px; padding: 28px 24px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: 2px solid transparent; transition: border-color 0.2s; position: relative; }
  .plan-card:hover { border-color: #e2e8f0; }
  .plan-card.current { border-color: #e94560; }
  .plan-card.featured { border-color: #e94560; }
  .plan-card h3 { font-size: 20px; margin-bottom: 4px; }
  .plan-price { font-size: 36px; font-weight: 800; margin: 12px 0 4px; }
  .plan-price small { font-size: 16px; font-weight: 400; color: #718096; }
  .plan-units { font-size: 14px; color: #718096; margin-bottom: 16px; }
  .plan-features { text-align: left; font-size: 14px; color: #4a5568; line-height: 2; margin-bottom: 20px; padding: 0 8px; }
  .current-tag { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: #e94560; color: white; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .popular-tag { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: #e94560; color: white; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.5px; }

  .btn { display: inline-block; padding: 12px 24px; background: #e94560; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: background 0.2s; width: 100%; }
  .btn:hover { background: #d63851; }
  .btn-outline { background: transparent; color: #1a1a2e; border: 2px solid #e2e8f0; }
  .btn-outline:hover { border-color: #1a1a2e; background: transparent; }
  .btn-disabled { background: #e2e8f0; color: #a0aec0; cursor: default; }
  .btn-disabled:hover { background: #e2e8f0; }

  .manage-section { background: white; border-radius: 12px; padding: 24px; margin-top: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .manage-section h3 { margin-bottom: 12px; }
  .manage-section p { color: #718096; font-size: 14px; margin-bottom: 16px; line-height: 1.6; }

  .success-msg { background: #f0fff4; color: #38a169; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #c6f6d5; }
  .error-msg { background: #fff5f5; color: #e53e3e; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #fed7d7; }

  .back-link { display: inline-block; margin-bottom: 20px; color: #718096; text-decoration: none; font-size: 14px; }
  .back-link:hover { color: #1a1a2e; }

  @media (max-width: 640px) { .plans-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<nav class="topnav">
  <a href="/dashboard" class="logo">No<span>FrontDesk</span></a>
  <div class="topnav-right">
    <span class="company-badge">${esc(account.company_name)}</span>
    <a href="/dashboard">Dashboard</a>
    <a href="/dashboard/credentials">Guesty API</a>
    <a href="/logout">Log out</a>
  </div>
</nav>
<div class="main">
  <a href="/dashboard" class="back-link">&larr; Back to Dashboard</a>
  <h1 style="font-size:28px;margin-bottom:24px;">Billing & Plan</h1>

  <script>
    const params = new URLSearchParams(window.location.search);
    if (params.get('success')) {
      document.write('<div class="success-msg">Payment successful! Your plan has been upgraded.</div>');
    }
    if (params.get('cancelled')) {
      document.write('<div class="error-msg">Checkout was cancelled. No charges were made.</div>');
    }
    if (params.get('error')) {
      document.write('<div class="error-msg">' + params.get('error') + '</div>');
    }
  </script>

  <!-- Current plan status -->
  <div class="status-card">
    <div class="status-header">
      <div>
        <h2 style="font-size:20px;">Current Plan</h2>
        <p style="color:#718096;font-size:14px;margin-top:4px;">${propertyCount} of ${account.plan_unit_limit} properties used</p>
      </div>
      <span class="plan-badge ${trialExpired ? 'plan-expired' : isTrialing ? 'plan-trial' : currentPlan === 'cancelled' ? 'plan-cancelled' : 'plan-active'}">
        ${trialExpired ? 'Trial Expired' : isTrialing ? 'Free Trial' : currentPlan === 'cancelled' ? 'Cancelled' : PLANS[currentPlan]?.name || currentPlan}
      </span>
    </div>

    ${trialExpired ? `
      <div class="trial-warning">
        Your free trial has expired. Subscribe to a plan to continue using NoFrontDesk. Your data is safe and will be here when you subscribe.
      </div>
    ` : isTrialing ? `
      <div class="trial-info">
        You have <strong>${trialDaysLeft} day${trialDaysLeft !== 1 ? 's' : ''}</strong> left on your free trial. Subscribe anytime to keep your check-in pages active.
      </div>
    ` : ''}
  </div>

  <!-- Plan cards -->
  <h2 style="font-size:20px;margin-bottom:4px;">${isTrialing || currentPlan === 'cancelled' ? 'Choose a Plan' : 'Available Plans'}</h2>
  <p style="color:#718096;font-size:14px;margin-bottom:8px;">All plans include Guesty integration, custom branding, and QR code signs.</p>

  <div class="plans-grid">
    ${Object.entries(PLANS).map(([key, plan]) => {
      const isCurrent = currentPlan === key;
      const isPopular = key === 'growth';
      return `
        <div class="plan-card ${isCurrent ? 'current' : ''} ${isPopular && !isCurrent ? 'featured' : ''}">
          ${isCurrent ? '<div class="current-tag">Current Plan</div>' : (isPopular ? '<div class="popular-tag">Most Popular</div>' : '')}
          <h3>${plan.name}</h3>
          <div class="plan-price">$${plan.monthlyPrice}<small>/mo</small></div>
          <div class="plan-units">Up to ${plan.unitLimit} properties</div>
          <div class="plan-features">
            ${key === 'starter' ? 'Custom branding<br>QR code signs<br>Guesty integration<br>Mobile check-in<br>Email support' : ''}
            ${key === 'growth' ? 'Everything in Starter<br>Priority support<br>Custom domain<br>Analytics dashboard<br>Team members' : ''}
            ${key === 'pro' ? 'Everything in Growth<br>White-label option<br>API access<br>Dedicated manager<br>Phone support' : ''}
          </div>
          ${isCurrent ? `
            <button class="btn btn-disabled" disabled>Current Plan</button>
          ` : stripeConfigured ? `
            <form method="POST" action="/dashboard/billing/checkout" style="margin:0;">
              <input type="hidden" name="plan" value="${key}">
              <button type="submit" class="btn ${isPopular ? '' : 'btn-outline'}">${isTrialing || currentPlan === 'cancelled' ? 'Subscribe' : 'Switch Plan'}</button>
            </form>
          ` : `
            <button class="btn btn-disabled" disabled title="Billing setup in progress">Coming Soon</button>
          `}
        </div>
      `;
    }).join('')}
  </div>

  ${!isTrialing && currentPlan !== 'cancelled' && account.stripe_customer_id ? `
  <!-- Manage subscription -->
  <div class="manage-section">
    <h3>Manage Subscription</h3>
    <p>Update your payment method, view invoices, or cancel your subscription through Stripe's billing portal.</p>
    <form method="POST" action="/dashboard/billing/portal">
      <button type="submit" class="btn btn-outline" style="width:auto;">Open Billing Portal</button>
    </form>
  </div>
  ` : ''}

  <p style="margin-top:24px;font-size:13px;color:#a0aec0;">Need 50+ properties? Contact <a href="mailto:hello@nofrontdesk.com" style="color:#e94560;text-decoration:none;">hello@nofrontdesk.com</a> for enterprise pricing.</p>
</div>
</body>
</html>`;
}

module.exports = { router, handleStripeWebhook, PLANS };
