// âââââââââââââââââââââââââââââââââââââââââââââââââ
// Hostaway PMS Adapter
// API Docs: https://api.hostaway.com/docs
// Auth: POST /accessTokens with accountId + apiKey
// Check-in: guest-portal.hostaway.com (per-reservation URL)
// âââââââââââââââââââââââââââââââââââââââââââââââââ
const axios = require('axios');
const NodeCache = require('node-cache');
const BasePMSAdapter = require('./base-adapter');

const HOSTAWAY_API_BASE = 'https://api.hostaway.com/v1';
const tokenCache = new NodeCache({ stdTTL: 82800 }); // 23 hours

class HostawayAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'hostaway';
    this.displayName = 'Hostaway';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    const cacheKey = `hostaway_token_${this.credentials.accountId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;

    const response = await this._request({
      method: 'post',
      url: `${HOSTAWAY_API_BASE}/accessTokens`,
      data: {
        accountId: this.credentials.accountId,
        apiKey: this.credentials.apiKey,
      },
    });

    const token = response.data.accessToken;
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
      guestLastName: lastName,
      status: 'confirmed,checked_in',
      arrivalStartDate: windowStart.toISOString().split('T')[0],
      arrivalEndDate: windowEnd.toISOString().split('T')[0],
    };

    const response = await this._request({
      method: 'get',
      url: `${HOSTAWAY_API_BASE}/reservations`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params,
    });

    const results = response.data.results || [];
    return results.map(r => this.normalizeReservation({
      id: r.id,
      confirmationCode: r.confirmationCode || r.channelReservationId || '',
      guestFirstName: r.guestFirstName || '',
      guestLastName: r.guestLastName || '',
      checkIn: r.arrivalDate,
      checkOut: r.departureDate,
      listingName: r.listingName || '',
      status: r.status,
      // Hostaway returns guestPortalUrl on reservations when the feature is enabled
      checkInFormUrl: r.guestPortalUrl || r.guestPortal || null,
      _raw: r,
    }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    // 1. Use the URL returned directly from the API (most reliable)
    if (reservation.checkInFormUrl) return reservation.checkInFormUrl;

    // 2. Try to construct the guest portal URL from reservation data
    //    Hostaway guest portal: https://guest-portal.hostaway.com/reservations/{id}
    //    This requires the guest portal feature to be enabled in Hostaway settings
    const raw = reservation.raw;
    if (raw?.guestPortalUrl) return raw.guestPortalUrl;

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
      { key: 'accountId', label: 'Account ID', type: 'text', required: true, help: 'Your Hostaway Account ID' },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, help: 'From Hostaway Dashboard > API Keys' },
    ];
  }
}

module.exports = HostawayAdapter;
