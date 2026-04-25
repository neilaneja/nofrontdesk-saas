// âââââââââââââââââââââââââââââââââââââââââââââââââ
// Hospitable PMS Adapter
// API Docs: https://api.hospitable.com
// Auth: Personal Access Token (Bearer token)
// Check-in: stay.hospitable.com (unique 32-digit URL per reservation)
// âââââââââââââââââââââââââââââââââââââââââââââââââ
const axios = require('axios');
const NodeCache = require('node-cache');
const BasePMSAdapter = require('./base-adapter');

const HOSPITABLE_API_BASE = 'https://api.hospitable.com/v2';
const tokenCache = new NodeCache({ stdTTL: 82800 }); // 23 hours

class HospitableAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'hospitable';
    this.displayName = 'Hospitable';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    const cacheKey = `hospitable_token_${this.credentials.accessToken}`;
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;

    const token = this.credentials.accessToken;
    tokenCache.set(cacheKey, token);
    return token;
  }

  // âââââââââ Search Reservations âââââââââ
  async searchReservations(lastName) {
    const token = await this.authenticate();

    const now = new Date();
    const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const params = {
      include: 'guest,listing',
      limit: 100,
    };

    const response = await this._request({
      method: 'get',
      url: `${HOSPITABLE_API_BASE}/reservations`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params,
    });

    const results = response.data.data || [];

    const filtered = results.filter(r => {
      const guestLastName = r.guest?.last_name || '';
      const matches = BasePMSAdapter.namesMatch(lastName, guestLastName);
      const withinWindow = BasePMSAdapter.isWithinCheckInWindow(r.check_in, r.check_out);
      return matches && withinWindow;
    });

    return filtered.map(r => this.normalizeReservation({
      id: r.id,
      confirmationCode: r.confirmation_code || '',
      guestFirstName: r.guest?.first_name || '',
      guestLastName: r.guest?.last_name || '',
      guestFullName: `${r.guest?.first_name || ''} ${r.guest?.last_name || ''}`.trim(),
      checkIn: r.check_in,
      checkOut: r.check_out,
      listingName: r.listing?.name || '',
      listingId: r.listing?.id || '',
      status: r.status,
      // Hospitable returns guest_portal_url when the portal is enabled
      checkInFormUrl: r.guest_portal_url || r.portal_url || null,
      _raw: r,
    }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    // 1. Use URL from API response (unique 32-digit URL via stay.hospitable.com)
    if (reservation.checkInFormUrl) return reservation.checkInFormUrl;

    // 2. Check raw reservation data for portal URL
    const raw = reservation.raw;
    if (raw?.guest_portal_url) return raw.guest_portal_url;
    if (raw?.portal_url) return raw.portal_url;

    // 3. Return null â NoFrontDesk built-in form will be used
    return null;
  }

  // âââââââââ HTTP Helper with 429 Retry âââââââââ
  async _request(config, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await axios(config);
      } catch (err) {
        if (err.response?.status === 429 && attempt < retries) {
          const retryAfter = parseInt(err.response.headers['retry-after'], 10) || 10;
          await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 30000)));
        } else {
          throw err;
        }
      }
    }
  }

  // âââââââââ Credential Fields âââââââââ
  static getCredentialFields() {
    return [
      { key: 'accessToken', label: 'Personal Access Token', type: 'password', required: true, help: 'From Hospitable > Settings > API' },
    ];
  }
}

module.exports = HospitableAdapter;
