// âââââââââââââââââââââââââââââââââââââââââââââââââ
// OwnerRez PMS Adapter
// API Docs: https://api.ownerrez.com
// Auth: HTTP Basic Auth (email + Personal Access Token)
// Check-in: OwnerRez has Guest Forms (legal agreements, custom fields)
//           but no dedicated guest portal yet (planned feature)
// âââââââââââââââââââââââââââââââââââââââââââââââââ
const axios = require('axios');
const NodeCache = require('node-cache');
const BasePMSAdapter = require('./base-adapter');

const OWNERREZ_API_BASE = 'https://api.ownerrez.com/v2';
const tokenCache = new NodeCache({ stdTTL: 82800 }); // 23 hours

class OwnerRezAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'ownerrez';
    this.displayName = 'OwnerRez';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    const cacheKey = `ownerrez_token_${this.credentials.email}`;
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;

    const credentials = `${this.credentials.email}:${this.credentials.accessToken}`;
    const base64Credentials = Buffer.from(credentials).toString('base64');
    const token = `Basic ${base64Credentials}`;
    tokenCache.set(cacheKey, token);
    return token;
  }

  // âââââââââ Search Reservations âââââââââ
  async searchReservations(lastName) {
    const token = await this.authenticate();

    const now = new Date();
    const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const params = { limit: 100 };

    const response = await this._request({
      method: 'get',
      url: `${OWNERREZ_API_BASE}/bookings`,
      headers: { Authorization: token, Accept: 'application/json' },
      params,
    });

    const results = response.data.data || [];

    const filtered = results.filter(r => {
      const guestLastName = r.guest?.last_name || '';
      const matches = BasePMSAdapter.namesMatch(lastName, guestLastName);
      const withinWindow = BasePMSAdapter.isWithinCheckInWindow(r.arrival, r.departure);
      return matches && withinWindow;
    });

    return filtered.map(r => this.normalizeReservation({
      id: r.id,
      confirmationCode: r.confirmation_code || r.booking_number || '',
      guestFirstName: r.guest?.first_name || '',
      guestLastName: r.guest?.last_name || '',
      guestFullName: `${r.guest?.first_name || ''} ${r.guest?.last_name || ''}`.trim(),
      checkIn: r.arrival,
      checkOut: r.departure,
      listingName: r.property?.name || '',
      listingId: r.property?.id || '',
      status: r.status,
      // OwnerRez may return form URLs for guest-facing forms
      checkInFormUrl: r.guest_form_url || null,
      _raw: r,
    }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    // 1. Use URL from API response (OwnerRez guest forms)
    if (reservation.checkInFormUrl) return reservation.checkInFormUrl;

    // 2. Check raw data
    const raw = reservation.raw;
    if (raw?.guest_form_url) return raw.guest_form_url;

    // 3. Return null â NoFrontDesk built-in form will be used
    //    OwnerRez guest portal is a planned feature (no ETA)
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
      { key: 'email', label: 'OwnerRez Email', type: 'text', required: true, help: 'Your OwnerRez account email' },
      { key: 'accessToken', label: 'Personal Access Token', type: 'password', required: true, help: 'From OwnerRez > Settings > API > Personal Access Tokens' },
    ];
  }
}

module.exports = OwnerRezAdapter;
