/**
 * NoFrontDesk - Check-in Payment Handler
 * Handles Stripe Elements integration for collecting deposits during guest check-in.
 * This script is loaded by checkin-form.html and hooks into the existing check-in flow.
 */
(function() {
  'use strict';

  let stripe = null;
  let elements = null;
  let cardElement = null;
  let depositConfig = null;
  let paymentIntentSecret = null;
  let currentGuestInfo = {};

  // ── Public API exposed to checkin-form.html ──────────────────────
  window.CheckinPayment = {
    /**
     * Called by checkin-form init() after loading property config.
     * Sets up Stripe if deposits are enabled.
     */
    init: function(config) {
      if (!config || !config.depositEnabled) {
        depositConfig = null;
        return;
      }
      depositConfig = config;
      if (config.stripePublishableKey) {
        stripe = Stripe(config.stripePublishableKey);
      }
    },

    /** Returns true if this property requires a deposit */
    isRequired: function() {
      return !!(depositConfig && depositConfig.depositEnabled && stripe);
    },

    /** Returns deposit amount in dollars */
    getAmount: function() {
      if (!depositConfig) return 0;
      return (depositConfig.depositAmountCents / 100).toFixed(2);
    },

    /** Returns deposit type label */
    getTypeLabel: function() {
      if (!depositConfig) return '';
      return depositConfig.depositType === 'hold' ? 'Pre-Authorization Hold' : 'Security Deposit';
    },

    /**
     * Injects the payment UI into the page and mounts the Stripe card element.
     * Called after the user submits the check-in form, before final confirmation.
     */
    showPaymentStep: function(container, guestInfo) {
      currentGuestInfo = guestInfo || {};
      const amount = this.getAmount();
      const typeLabel = this.getTypeLabel();
      const isHold = depositConfig.depositType === 'hold';

      container.innerHTML = `
        <div class="payment-section" style="margin-top:24px;">
          <div style="background:var(--card);border-radius:var(--radius);padding:24px;border:2px solid var(--border);">
            <h3 style="font-size:18px;font-weight:700;margin-bottom:8px;color:var(--text);">
              ${isHold ? 'Pre-Authorization Required' : 'Security Deposit Required'}
            </h3>
            <p style="font-size:14px;color:var(--text-muted);margin-bottom:20px;line-height:1.5;">
              ${isHold
                ? 'A temporary hold of <strong>$' + amount + '</strong> will be placed on your card. This is not a charge and will be released after your stay.'
                : 'A security deposit of <strong>$' + amount + '</strong> will be charged to your card. This will be refunded after your stay if there is no damage.'}
            </p>
            <div style="margin-bottom:16px;">
              <label style="display:block;font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px;">Card Details</label>
              <div id="stripe-card-element" style="padding:12px 14px;border:2px solid var(--border);border-radius:calc(var(--radius) - 4px);background:white;transition:border-color 0.2s;"></div>
              <div id="card-errors" style="color:var(--error);font-size:13px;margin-top:6px;display:none;"></div>
            </div>
            <button id="pay-deposit-btn" type="button" style="
              width:100%;padding:14px;background:var(--accent);color:white;border:none;border-radius:calc(var(--radius) - 4px);
              font-size:16px;font-weight:700;cursor:pointer;transition:opacity 0.2s;
            ">
              ${isHold ? 'Authorize $' + amount : 'Pay $' + amount + ' Deposit'}
            </button>
            <p style="font-size:12px;color:var(--text-muted);margin-top:10px;text-align:center;">
              Payments processed securely by Stripe
            </p>
          </div>
        </div>
      `;

      // Mount card element
      elements = stripe.elements();
      cardElement = elements.create('card', {
        style: {
          base: {
            fontSize: '16px',
            color: '#1A1A1A',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            '::placeholder': { color: '#6C757D' },
          },
          invalid: { color: '#DC3545' },
        },
      });
      cardElement.mount('#stripe-card-element');

      cardElement.on('change', function(event) {
        const errEl = document.getElementById('card-errors');
        if (event.error) {
          errEl.textContent = event.error.message;
          errEl.style.display = 'block';
        } else {
          errEl.style.display = 'none';
        }
      });

      // Handle payment button
      document.getElementById('pay-deposit-btn').addEventListener('click', function() {
        CheckinPayment.processPayment();
      });
    },

    /**
     * Creates a payment intent on the server and confirms with Stripe.
     */
    processPayment: async function() {
      const btn = document.getElementById('pay-deposit-btn');
      const errEl = document.getElementById('card-errors');
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.textContent = 'Processing...';
      errEl.style.display = 'none';

      try {
        // Step 1: Create payment intent on server
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        const accountSlug = pathParts[1] || pathParts[0];
        const propertySlug = pathParts[2] || pathParts[1];

        const createResp = await fetch('/api/checkin/create-payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountSlug: accountSlug,
            propertySlug: propertySlug,
            guestName: currentGuestInfo.guestName || '',
            guestEmail: currentGuestInfo.guestEmail || '',
            reservationId: currentGuestInfo.reservationId || '',
          }),
        });

        if (!createResp.ok) {
          const err = await createResp.json();
          throw new Error(err.error || 'Failed to initialize payment.');
        }

        const intentData = await createResp.json();
        paymentIntentSecret = intentData.clientSecret;

        // Step 2: Confirm the payment with Stripe
        const { error, paymentIntent } = await stripe.confirmCardPayment(paymentIntentSecret, {
          payment_method: {
            card: cardElement,
            billing_details: {
              name: currentGuestInfo.guestName || '',
              email: currentGuestInfo.guestEmail || '',
            },
          },
        });

        if (error) {
          throw new Error(error.message);
        }

        // Step 3: Record the deposit on our server
        const confirmResp = await fetch('/api/checkin/confirm-deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountSlug: accountSlug,
            propertySlug: propertySlug,
            paymentIntentId: paymentIntent.id,
            guestName: currentGuestInfo.guestName || '',
            guestEmail: currentGuestInfo.guestEmail || '',
            reservationId: currentGuestInfo.reservationId || '',
          }),
        });

        if (!confirmResp.ok) {
          console.error('Failed to confirm deposit on server, but payment was processed.');
        }

        // Step 4: Show success
        const container = document.getElementById('stripe-card-element').closest('.payment-section');
        const isHold = depositConfig.depositType === 'hold';
        container.innerHTML = `
          <div style="background:var(--card);border-radius:var(--radius);padding:24px;border:2px solid var(--success);text-align:center;">
            <div style="font-size:48px;margin-bottom:8px;">&#10003;</div>
            <h3 style="font-size:18px;font-weight:700;color:var(--success);margin-bottom:8px;">
              ${isHold ? 'Hold Authorized' : 'Deposit Paid'}
            </h3>
            <p style="font-size:14px;color:var(--text-muted);">
              ${isHold
                ? 'A hold of $' + CheckinPayment.getAmount() + ' has been placed on your card. This will be released after your stay.'
                : 'Your security deposit of $' + CheckinPayment.getAmount() + ' has been processed.'}
            </p>
          </div>
        `;

        // Dispatch event for the main form to know payment is complete
        document.dispatchEvent(new CustomEvent('depositComplete', {
          detail: { paymentIntentId: paymentIntent.id, type: intentData.type }
        }));

      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.style.opacity = '1';
        const isHold = depositConfig.depositType === 'hold';
        btn.textContent = isHold
          ? 'Authorize $' + CheckinPayment.getAmount()
          : 'Pay $' + CheckinPayment.getAmount() + ' Deposit';
      }
    },
  };
})();
