// âââââââââââââââââââââââââââââââââââââââââââââââââ
// Streamline VRS PMS Adapter
// API Docs: https://api.streamlinevrs.com
// Auth: API Key via X-API-Key header
// Check-in: Happy Stays guest app (happystays.streamlinevrs.com)
// âââââââââââââââââââââââââââââââââââââââââââââââââ
const axios = require('axios');
const BasePMSAdapter = require('./base-adapter');

const STREAMLINE_API_BASE = 'https://api.streamlinevrs.com/api/v1';

class StreamlineAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'streamline';
    this.displayName = 'Streamline VRS';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    if (!this.credentials.apiKey) {
      throw new Error('Streamline: API Key is required');
    }
    return this.credentials.apiKey;
  }

  // âââââââââ Search Reservations âââââââââ
  async searchReservations(lastName) {
    await this.authenticate();

    const now = new Date();
    const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const params = { limit: 50 };

    const response = await this._request({
      method: 'get',
      url: `${STREAMLINE_API_BASE}/reservations`,
      headers: { 'X-API-Key': this.credentials.apiKey },
      params,
    });

    const results = response.data.reservations || [];

    return results
      .filter(r => BasePMSAdapter.namesMatch(lastName, r.guest_last_name))
      .filter(r => BasePMSAdapter.isWithinCheckInWindow(r.checkin_date, r.checkout_date))
      .map(r => this.normalizeReservation({
        id: r.id,
        confirmationCode: r.confirmation_number || '',
        guestFirstName: r.guest_first_name || '',
        guestLastName: r.guest_last_name || '',
        checkIn: r.checkin_date,
        checkOut: r.checkout_date,
        listingName: r.unit_name || '',
        listingId: r.id || '',
        status: r.status,
        // Streamline may return a guest_portal_url or happy_stays_url
        checkInFormUrl: r.guest_portal_url || r.happy_stays_url || null,
        _raw: r,
      }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    // 1. Use URL from API response (Happy Stays guest app)
    if (reservation.checkInFormUrl) return reservation.checkInFormUrl;

    // 2. Check raw data
    const raw = reservation.raw;
    if (raw?.guest_portal_url) return raw.guest_portal_url;
    if (raw?.happy_stays_url) return raw.happy_stays_url;

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
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, help: 'From Streamline > Settings > API' },
    ];
  }
}

module.exports = StreamlineAdapter;
