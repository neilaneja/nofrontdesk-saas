// âââââââââââââââââââââââââââââââââââââââââââââââââ
// Beds24 PMS Adapter
// API Docs: https://api.beds24.com/v2
// Auth: Token-based using refreshToken
// Check-in: my-booking.info (guest login portal)
// âââââââââââââââââââââââââââââââââââââââââââââââââ
const axios = require('axios');
const NodeCache = require('node-cache');
const BasePMSAdapter = require('./base-adapter');

const BEDS24_API_BASE = 'https://api.beds24.com/v2';
const tokenCache = new NodeCache({ stdTTL: 82800 }); // 23 hours

class Beds24Adapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'beds24';
    this.displayName = 'Beds24';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    const cacheKey = `beds24_token_${this.credentials.refreshToken}`;
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;

    const response = await this._request({
      method: 'post',
      url: `${BEDS24_API_BASE}/authentication/token`,
      headers: { 'Content-Type': 'application/json' },
      data: { refreshToken: this.credentials.refreshToken },
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

    const windowStartIso = windowStart.toISOString().split('T')[0];
    const windowEndIso = windowEnd.toISOString().split('T')[0];

    const response = await this._request({
      method: 'get',
      url: `${BEDS24_API_BASE}/bookings`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      params: {
        searchString: lastName,
        status: ['active', 'confirmed'].join(','),
        arrival: windowStartIso,
        departure: windowEndIso,
      },
    });

    const bookings = response.data.bookings || [];
    return bookings.map(b => this.normalizeReservation({
      id: b.id,
      confirmationCode: b.apiReference || '',
      guestFirstName: b.guestFirstName || '',
      guestLastName: b.guestLastName || '',
      checkIn: b.arrival,
      checkOut: b.departure,
      listingName: b.propertyName || '',
      status: b.status,
      // Beds24 may return a guestLoginUrl or guestLink
      checkInFormUrl: b.guestLoginUrl || b.guestLink || null,
      _raw: b,
    }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
    // 1. Use URL from API response
    if (reservation.checkInFormUrl) return reservation.checkInFormUrl;

    // 2. Construct Beds24 guest login URL with booking ID
    //    The guest login page at my-booking.info allows guests to access their booking
    const raw = reservation.raw;
    if (raw?.guestLoginUrl) return raw.guestLoginUrl;
    if (raw?.guestLink) return raw.guestLink;

    // 3. Construct URL if we have a booking ID
    //    Beds24 supports direct login via: https://my-booking.info?bookid={ID}
    if (reservation.id) {
      return `https://my-booking.info?bookid=${reservation.id}`;
    }

    // 4. Return null â NoFrontDesk built-in form will be used
    return null;
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
    const oMatch = trimmed.match(/^o['â\s]?(\w+)$/i);
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
    if (trimmed.includes("'") || trimmed.includes('â')) {
      variants.add(normalize(trimmed.replace(/['â]/g, '')));
    }
    return Array.from(variants);
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
      {
        key: 'refreshToken', label: 'API Refresh Token', type: 'password', required: true,
        help: 'From Beds24 > Settings > Account > Account Access > API',
      },
    ];
  }
}

module.exports = Beds24Adapter;
