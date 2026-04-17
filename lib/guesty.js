const axios = require('axios');
const NodeCache = require('node-cache');

const GUESTY_API_BASE = 'https://open-api.guesty.com';

// Cache tokens per account (keyed by account ID)
const tokenCache = new NodeCache({ stdTTL: 82800 }); // 23 hours

// ─────────────────────────────────────────────
// Helper: wait for a given number of milliseconds
// ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// API request with automatic 429 retry
// ─────────────────────────────────────────────
async function apiRequestWithRetry(config) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios(config);
    } catch (err) {
      if (err.response && err.response.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(err.response.headers['retry-after'], 10) || 10;
        const waitMs = Math.min(retryAfter * 1000, 30000);
        console.log(`Rate limited (429). Waiting ${waitMs / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(waitMs);
      } else {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────
// Get OAuth2 token for a specific account's credentials
// ─────────────────────────────────────────────
async function getGuestyToken(accountId, clientId, clientSecret) {
  const cacheKey = `token_${accountId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const response = await apiRequestWithRetry({
    method: 'post',
    url: `${GUESTY_API_BASE}/oauth2/token`,
    data: {
      grant_type: 'client_credentials',
      scope: 'open-api',
      client_id: clientId,
      client_secret: clientSecret,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const token = response.data.access_token;
  tokenCache.set(cacheKey, token);
  return token;
}

// ─────────────────────────────────────────────
// Normalize a last name to proper case
// ─────────────────────────────────────────────
function normalizeName(name) {
  return name
    .toLowerCase()
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

// ─────────────────────────────────────────────
// Search for reservations by guest last name
// ─────────────────────────────────────────────
async function searchReservations(token, lastName) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  const normalizedName = normalizeName(lastName);

  const filters = [
    { operator: '$eq', field: 'guest.lastName', value: normalizedName },
    { operator: '$in', field: 'status', value: ['confirmed', 'checked_in'] },
    { operator: '$lte', field: 'checkIn', value: windowEnd.toISOString() },
    { operator: '$gte', field: 'checkOut', value: windowStart.toISOString() },
  ];

  const params = {
    filters: JSON.stringify(filters),
    fields: [
      '_id', 'guest.firstName', 'guest.lastName', 'guest.fullName',
      'checkIn', 'checkOut', 'checkInDateLocalized', 'checkOutDateLocalized',
      'listing.title', 'listing._id', 'status', 'guestAppUrl',
    ].join(' '),
    limit: 10,
    sort: 'checkIn',
  };

  const response = await apiRequestWithRetry({
    method: 'get',
    url: `${GUESTY_API_BASE}/v1/reservations`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    params,
  });

  return response.data.results || [];
}

// ─────────────────────────────────────────────
// Build Guesty Guest App check-in form URL
// ─────────────────────────────────────────────
function buildCheckInFormUrl(reservation, guestyGuestAppName) {
  if (reservation.guestAppUrl) {
    return reservation.guestAppUrl;
  }
  const appName = guestyGuestAppName || 'default';
  const tokenPayload = `{{guest_app::${appName}}}`;
  const base64Token = Buffer.from(tokenPayload).toString('base64');
  return `https://guest-app.guesty.com/r/${reservation._id}/${base64Token}`;
}

module.exports = { getGuestyToken, searchReservations, buildCheckInFormUrl, normalizeName };
