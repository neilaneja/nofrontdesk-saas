// âââââââââââââââââââââââââââââââââââââââââââââ
// Escapia PMS Adapter
// API Docs: https://api-gateway.escapia.com
// Auth: OAuth2 with Base64-encoded credentials
// âââââââââââââââââââââââââââââââââââââââââââââ

const axios = require('axios');
const NodeCache = require('node-cache');
const BasePMSAdapter = require('./base-adapter');

const ESCAPIA_API_BASE = 'https://api-gateway.escapia.com';
const tokenCache = new NodeCache({ stdTTL: 82800 }); // 23 hours

class EscapiaAdapter extends BasePMSAdapter {
  constructor(credentials) {
    super(credentials);
    this.name = 'escapia';
    this.displayName = 'Escapia';
  }

  // âââââââââ Auth âââââââââ
  async authenticate() {
    const cacheKey = `escapia_token_${this.credentials.clientId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;

    const credentials = `${this.credentials.clientId}:${this.credentials.clientSecret}`;
    const base64Credentials = Buffer.from(credentials).toString('base64');

    const response = await this._request({
      method: 'post',
      url: `${ESCAPIA_API_BASE}/token`,
      headers: {
        'Authorization': `Basic ${base64Credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: 'grant_type=client_credentials',
    });

    const token = response.data.access_token;
    tokenCache.set(cacheKey, token);
    return token;
  }

  // âââââââââ Search Reservations âââââââââ
  async searchReservations(lastName) {
    const token = await this.authenticate();
    const nameVariants = EscapiaAdapter.getNameVariants(lastName);

    const now = new Date();
    const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const windowStartIso = windowStart.toISOString().split('T')[0];
    const windowEndIso = windowEnd.toISOString().split('T')[0];

    // Build GraphQL query for reservations filtering by guest last name, status, and date range
    const query = `
      query SearchReservations($lastNames: [String!]!, $startDate: String!, $endDate: String!) {
        reservations(
          filter: {
            guestLastName: { in: $lastNames }
            status: { in: ["confirmed", "checked_in"] }
            checkInDate: { gte: $startDate, lte: $endDate }
          }
        ) {
          edges {
            node {
              id
              confirmationCode
              folioId
              guest {
                firstName
                lastName
              }
              checkInDate
              checkOutDate
              unit {
                name
              }
              status
            }
          }
        }
      }
    `;

    const response = await this._request({
      method: 'post',
      url: `${ESCAPIA_API_BASE}/graphql`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        query,
        variables: {
          lastNames: nameVariants,
          startDate: windowStartIso,
          endDate: windowEndIso,
        },
      },
    });

    const edges = response.data.data?.reservations?.edges || [];
    return edges.map(({ node: r }) => this.normalizeReservation({
      id: r.id,
      confirmationCode: r.confirmationCode || r.folioId || '',
      guestFirstName: r.guest?.firstName || '',
      guestLastName: r.guest?.lastName || '',
      checkIn: r.checkInDate,
      checkOut: r.checkOutDate,
      listingName: r.unit?.name || '',
      status: r.status,
      _raw: r,
    }));
  }

  // âââââââââ Check-In URL âââââââââ
  buildCheckInUrl(reservation, propertyConfig) {
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
      { key: 'clientId', label: 'Client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
    ];
  }
}

module.exports = EscapiaAdapter;
