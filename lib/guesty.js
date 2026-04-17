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
// Generate all likely variants of a last name
// Handles: O'Donnell, McDonald, MacDonald, etc.
// ─────────────────────────────────────────────
function getNameVariants(name) {
  const trimmed = name.trim();
  if (!trimmed) return [];

  const variants = new Set();

  // Basic title case: "smith" → "Smith"
  variants.add(normalizeName(trimmed));

  // Exact input (preserving original case)
  variants.add(trimmed);

  // O' names: "odonnell" → "O'Donnell", "ODonnell"
  const oMatch = trimmed.match(/^o['\u2019\s]?(\w+)$/i);
  if (oMatch) {
    const rest = oMatch[1].charAt(0).toUpperCase() + oMatch[1].slice(1).toLowerCase();
    variants.add(`O'${rest}`);
    variants.add(`O${rest}`);
    variants.add(`O\u2019${rest}`); // smart apostrophe
  }

  // Mc names: "mcdonald" → "McDonald", "Mcdonald"
  const mcMatch = trimmed.match(/^mc(\w+)$/i);
  if (mcMatch) {
    const rest = mcMatch[1].charAt(0).toUpperCase() + mcMatch[1].slice(1).toLowerCase();
    variants.add(`Mc${rest}`);
    variants.add(`MC${rest}`);
    variants.add(`Mc${mcMatch[1].toLowerCase()}`);
  }

  // Mac names: "macdonald" → "MacDonald", "Macdonald"
  const macMatch = trimmed.match(/^mac(\w+)$/i);
  if (macMatch) {
    const rest = macMatch[1].charAt(0).toUpperCase() + macMatch[1].slice(1).toLowerCase();
    variants.add(`Mac${rest}`);
    variants.add(`Mac${macMatch[1].toLowerCase()}`);
  }

  // If input had an apostrophe, also try without
  if (trimmed.includes("'") || trimmed.includes('\u2019')) {
    const noApostrophe = trimmed.replace(/['\u2019]/g, '');
    variants.add(normalizeName(noApostrophe));
  }

  // If input had NO apostrophe but starts with O + capital, try with apostrophe
  const oCapMatch = trimmed.match(/^O([A-Z]\w+)$/);
  if (oCapMatch) {
    variants.add(`O'${oCapMatch[1]}`);
  }

  return Array.from(variants);
}

// ─────────────────────────────────────────────
// Search for reservations by guest last name
// Tries multiple name variants to handle
// O'Donnell, McDonald, etc.
// ─────────────────────────────────────────────
async function searchReservations(token, lastName) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  // Generate all possible name variants
  const nameVariants = getNameVariants(lastName);
  console.log(`Searching for name variants: ${nameVariants.join(', ')}`);

  const filters = [
    { operator: '$in', field: 'guest.lastName', value: nameVariants },
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
// Supports multiple guest app names (comma-separated)
// Always prefers guestAppUrl from the reservation if available
// ─────────────────────────────────────────────
function buildCheckInFormUrl(reservation, guestyGuestAppNames) {
  // Always prefer the URL Guesty provides on the reservation
  if (reservation.guestAppUrl) {
    return reservation.guestAppUrl;
  }

  // If multiple guest app names provided (comma-separated), use the first one as default
  // Future: could map by listing ID
  let appName = 'default';
  if (guestyGuestAppNames) {
    const names = guestyGuestAppNames.split(',').map(n => n.trim()).filter(Boolean);
    if (names.length > 0) {
      appName = names[0];
    }
  }

  const tokenPayload = `{{guest_app::${appName}}}`;
  const base64Token = Buffer.from(tokenPayload).toString('base64');
  return `https://guest-app.guesty.com/r/${reservation._id}/${base64Token}`;
}

module.exports = { getGuestyToken, searchReservations, buildCheckInFormUrl, normalizeName, getNameVariants };
