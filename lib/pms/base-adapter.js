// ─────────────────────────────────────────────
// Base PMS Adapter — All PMS integrations extend this class
// Each adapter normalizes PMS-specific data into our standard format
// ─────────────────────────────────────────────

class BasePMSAdapter {
  constructor(credentials) {
    this.credentials = credentials;
    this.name = 'base';
    this.displayName = 'Base PMS';
  }

  async authenticate() {
    throw new Error(`${this.name}: authenticate() not implemented`);
  }

  async searchReservations(lastName) {
    throw new Error(`${this.name}: searchReservations() not implemented`);
  }

  buildCheckInUrl(reservation, propertyConfig) {
    return null;
  }

  normalizeReservation(raw) {
    return {
      id: raw.id || '',
      confirmationCode: raw.confirmationCode || '',
      guest: {
        firstName: raw.guestFirstName || '',
        lastName: raw.guestLastName || '',
        fullName: raw.guestFullName || '',
        email: raw.guestEmail || '',
      },
      checkIn: raw.checkIn || '',
      checkOut: raw.checkOut || '',
      listingName: raw.listingName || '',
      listingId: raw.listingId || '',
      status: raw.status || '',
      checkInFormUrl: raw.checkInFormUrl || null,
      raw: raw._raw || null,
    };
  }

  static namesMatch(searchName, reservationName) {
    if (!searchName || !reservationName) return false;
    return searchName.trim().toLowerCase() === reservationName.trim().toLowerCase();
  }

  static isWithinCheckInWindow(checkInDate, checkOutDate, windowHours = 48) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    return checkIn <= windowEnd && checkOut >= windowStart;
  }

  static getCredentialFields() {
    return [];
  }
}

module.exports = BasePMSAdapter;
