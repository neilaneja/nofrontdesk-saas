// âââââââââââââââââââââââââââââââââââââââââââââ
// Lodgify PMS Adapter
// API Docs: https://developer.lodgify.com
// Auth: API key passed as X-ApiKey header
// âââââââââââââââââââââââââââââââââââââââââââââ

const axios = require('axios');
const BasePMSAdapter = require('./base-adapter');

const LODGIFY_API_BASE = 'https://api.lodgify.com/v2';

class LodgifyAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'lodgify';
    this.displayName = 'Lodgify';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    // Lodgify uses API key authentication (no token exchange needed)
    // Just validate that the API key is present
    if (!this.credentials.apiKey) {
      throw new Error('Lodgify: API key is required');
    }
    return this.credentials.apiKey;
  }

  // âââââââââ Search Reservations âââââââââ
  async searchReservations(lastName) {
    const apiKey = await this.authenticate();

    const now = new Date();
    const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const params = {
      stayFilter: 'Current',
    };

    const response = await this._request({
      method: 'get',
      url: `${LODGIFY_API_BASE}/reservations/bookings`,
      headers: {
        'X-ApiKey': apiKey,
        Accept: 'application/json',
      },
      params,
    });

    const results = response.data.results || response.data || [];
    const reservations = Array.isArray(results) ? results : [];

    return reservations
      .filter(r => {
        // Client-side filter by guest last name (case-insensitive)
        const guestName = r.guest?.name || '';
        const lastNameFromGuest = guestName.split(' ').pop().toLowerCase();
        const searchLastName = lastName.toLowerCase();
        return lastNameFromGuest === searchLastName;
      })
      .filter(r => {
        // Client-side filter by check-in window
        const arrivalDate = r.arrival || '';
        const departureDate = r.departure || '';
        return BasePMSAdapter.isWithinCheckInWindow(arrivalDate, departureDate);
      })
      .map(r => {
        // Parse guest.name into firstName and lastName
        const guestName = r.guest?.name || '';
        const nameParts = guestName.trim().split(' ');
        const guestFirstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : '';
        const guestLastName = nameParts.length > 0 ? nameParts[nameParts.length - 1] : '';

        return this.normalizeReservation({
          id: r.id,
          confirmationCode: r.confirmation_code || r.booking_id || '',
          guestFirstName: guestFirstName,
          guestLastName: guestLastName,
          checkIn: r.arrival,
          checkOut: r.departure,
          listingName: r.property_name || '',
          status: r.status || '',
          checkInFormUrl: null,
          _raw: r,
        });
      });
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    // Lodgify does not have a built-in guest check-in app
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
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, help: 'From Lodgify > Settings > API' },
    ];
  }
}

module.exports = LodgifyAdapter;
