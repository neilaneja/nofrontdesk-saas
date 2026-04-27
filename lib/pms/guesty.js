// âââââââââââââââââââââââââââââââââââââââââââââ
// Guesty PMS Adapter
// API Docs: https://open-api.guesty.com
// Auth: OAuth2 client_credentials
// âââââââââââââââââââââââââââââââââââââââââââââ

const axios = require('axios');
const NodeCache = require('node-cache');
const BasePMSAdapter = require('./base-adapter');

const GUESTY_API_BASE = 'https://open-api.guesty.com';
const tokenCache = new NodeCache({ stdTTL: 82800 }); // 23 hours

class GuestyAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'guesty';
    this.displayName = 'Guesty';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    const cacheKey = `guesty_token_${this.credentials.accountId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;

    const response = await this._request({
      method: 'post',
      url: `${GUESTY_API_BASE}/oauth2/token`,
      data: {
        grant_type: 'client_credentials',
        scope: 'open-api',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const token = response.data.access_token;
    tokenCache.set(cacheKey, token);
    return token;
  }

  // âââââââââ Search Reservations âââââââââ
  async searchReservations(lastName) {
    const token = await this.authenticate();
    const nameVariants = GuestyAdapter.getNameVariants(lastName);

    const now = new Date();
    const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const filters = [
      { operator: '$in', field: 'guest.lastName', value: nameVariants },
      { operator: '$in', field: 'status', value: ['confirmed', 'checked_in'] },
      { operator: '$lte', field: 'checkIn', value: windowEnd.toISOString() },
      { operator: '$gte', field: 'checkOut', value: windowStart.toISOString() },
    ];

    const params = {
      filters: JSON.stringify(filters),
      fields: [
        '_id', 'confirmationCode', 'guest.firstName', 'guest.lastName', 'guest.fullName',
        'checkIn', 'checkOut', 'checkInDateLocalized', 'checkOutDateLocalized',
        'listing.title', 'listing._id', 'status', 'guestAppUrl',
      ].join(' '),
      limit: 10,
      sort: 'checkIn',
    };

    const response = await this._request({
      method: 'get',
      url: `${GUESTY_API_BASE}/v1/reservations`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params,
    });

    const results = response.data.results || [];
    return results.map(r => this.normalizeReservation({
      id: r._id,
      confirmationCode: r.confirmationCode || '',
      guestFirstName: r.guest?.firstName || '',
      guestLastName: r.guest?.lastName || '',
      guestFullName: r.guest?.fullName || '',
      checkIn: r.checkInDateLocalized || r.checkIn,
      checkOut: r.checkOutDateLocalized || r.checkOut,
      listingName: r.listing?.title || '',
      listingId: r.listing?._id || '',
      status: r.status,
      checkInFormUrl: r.guestAppUrl || null,
      _raw: r,
    }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    if (reservation.checkInFormUrl) return reservation.checkInFormUrl;

    const guestAppNames = propertyConfig.guestyGuestAppName || '';
    let appName = 'default';
    if (guestAppNames) {
      const names = guestAppNames.split(',').map(n => n.trim()).filter(Boolean);
      if (names.length > 0) appName = names[0];
    }

    const tokenPayload = `{{guest_app::${appName}}}`;
    const base64Token = Buffer.from(tokenPayload).toString('base64');
    return `https://guest-app.guesty.com/r/${reservation.id}/${base64Token}`;
  }

  // âââââââââ Name Variants âââââââââ
  static getNameVariants(name) {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const variants = new Set();

    const normalize = (n) => n.toLowerCase().split('-')
      .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-');

    variants.add(normalize(trimmed));
    variants.add(trimmed);

    const oMatch = trimmed.match(/^o['\u2019\s]?(\w+)$/i);
    if (oMatch) {
      const rest = oMatch[1].charAt(0).toUpperCase() + oMatch[1].slice(1).toLowerCase();
      variants.add(`O'${rest}`);
      variants.add(`O${rest}`);
    }

    const mcMatch = trimmed.match(/^mc(\w+)$/i);
    if (mcMatch) {
      const rest = mcMatch[1].charAt(0).toUpperCase() + mcMatch[1].slice(1).toLowerCase();
      variants.add(`Mc${rest}`);
    }

    const macMatch = trimmed.match(/^mac(\w+)$/i);
    if (macMatch) {
      const rest = macMatch[1].charAt(0).toUpperCase() + macMatch[1].slice(1).toLowerCase();
      variants.add(`Mac${rest}`);
    }

    if (trimmed.includes("'") || trimmed.includes('\u2019')) {
      variants.add(normalize(trimmed.replace(/['\u2019]/g, '')));
    }

    return Array.from(variants);
  }

  // âââââââââ HTTP Helper with 429 Retry âââââââââ
  async _request(config, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await axios({ ...config, timeout: 15000 });
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
      { key: 'clientId', label: 'Client ID', type: 'text', required: true, help: 'From Guesty Dashboard > Marketplace > API' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, help: 'From Guesty Dashboard > Marketplace > API' },
      { key: 'guestyGuestAppName', label: 'Guest App Name(s)', type: 'text', required: false, help: 'Comma-separated app names (e.g. west_end_flats). Found in Guesty Guest App settings.' },
    ];
  }
}

module.exports = GuestyAdapter;
