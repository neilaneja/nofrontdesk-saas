// âââââââââââââââââââââââââââââââââââââââââââââ
// Hostfully PMS Adapter
// API Docs: https://dev.hostfully.com/api/v3
// Auth: API Key via X-HOSTFULLY-APIKEY header
// âââââââââââââââââââââââââââââââââââââââââââââ

const axios = require('axios');
const BasePMSAdapter = require('./base-adapter');

const HOSTFULLY_API_BASE = 'https://dev.hostfully.com/api/v3';

class HostfullyAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'hostfully';
    this.displayName = 'Hostfully';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    // API Key authentication - no token exchange needed
    // Just validate that we have the API key
    if (!this.credentials.apiKey) {
      throw new Error('Hostfully: API Key is required');
    }
    return this.credentials.apiKey;
  }

  // âââââââââ Search Reservations âââââââââ
  async searchReservations(lastName) {
    await this.authenticate();

    const now = new Date();
    const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const params = {
      status: 'BOOKED',
      limit: 50,
    };

    const response = await this._request({
      method: 'get',
      url: `${HOSTFULLY_API_BASE}/leads`,
      headers: { 'X-HOSTFULLY-APIKEY': this.credentials.apiKey },
      params,
    });

    const results = response.data.results || response.data || [];
    return results
      .filter(r => BasePMSAdapter.namesMatch(lastName, r.lastName))
      .filter(r => BasePMSAdapter.isWithinCheckInWindow(r.checkInDate, r.checkOutDate))
      .map(r => this.normalizeReservation({
        id: r.uid,
        confirmationCode: r.confirmationCode || '',
        guestFirstName: r.firstName || '',
        guestLastName: r.lastName || '',
        checkIn: r.checkInDate,
        checkOut: r.checkOutDate,
        listingName: r.propertyUid || '',
        listingId: r.propertyUid || '',
        status: r.status,
        checkInFormUrl: null,
        _raw: r,
      }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
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
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, help: 'From Hostfully > Settings > API Keys' },
    ];
  }
}

module.exports = HostfullyAdapter;
