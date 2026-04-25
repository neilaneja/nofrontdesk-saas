// âââââââââââââââââââââââââââââââââââââââââââââââââ
// Avantio PMS Adapter
// API Docs: https://api.avantio.com
// Auth: API Key via Authorization Bearer or X-API-Key header
// Check-in: Avantio has a built-in online check-in that runs within the host's website
// âââââââââââââââââââââââââââââââââââââââââââââââââ
const axios = require('axios');
const BasePMSAdapter = require('./base-adapter');

const AVANTIO_API_BASE = 'https://api.avantio.com/v1';

class AvantioAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'avantio';
    this.displayName = 'Avantio';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    if (!this.credentials.apiKey) {
      throw new Error('Avantio: API Key is required');
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
      url: `${AVANTIO_API_BASE}/bookings`,
      headers: { Authorization: `Bearer ${this.credentials.apiKey}` },
      params,
    });

    const results = response.data.bookings || response.data || [];

    return results
      .filter(r => BasePMSAdapter.namesMatch(lastName, r.guest?.last_name))
      .filter(r => BasePMSAdapter.isWithinCheckInWindow(r.check_in, r.check_out))
      .map(r => this.normalizeReservation({
        id: r.id,
        confirmationCode: r.booking_code || '',
        guestFirstName: r.guest?.first_name || '',
        guestLastName: r.guest?.last_name || '',
        checkIn: r.check_in,
        checkOut: r.check_out,
        listingName: r.accommodation?.name || '',
        listingId: r.accommodation?.id || '',
        status: r.status,
        // Avantio may return an online_checkin_url or guest_area_url
        checkInFormUrl: r.online_checkin_url || r.guest_area_url || null,
        _raw: r,
      }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    // 1. Use URL from API response (Avantio online check-in)
    if (reservation.checkInFormUrl) return reservation.checkInFormUrl;

    // 2. Check raw data
    const raw = reservation.raw;
    if (raw?.online_checkin_url) return raw.online_checkin_url;
    if (raw?.guest_area_url) return raw.guest_area_url;

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
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, help: 'From Avantio > Settings > API Integration' },
    ];
  }
}

module.exports = AvantioAdapter;
