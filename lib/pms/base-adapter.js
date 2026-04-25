// âââââââââââââââââââââââââââââââââââââââââââââ
// Base PMS Adapter â All PMS integrations extend this class
// Each adapter normalizes PMS-specific data into our standard format
// âââââââââââââââââââââââââââââââââââââââââââââ

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

  /**
   * Build the check-in URL for a reservation.
   * Returns:
   *   - A URL string to the PMS's native check-in form (if available)
   *   - null if no native form exists (NoFrontDesk built-in form will be used)
   */
  buildCheckInUrl(reservation, propertyConfig) {
    return null;
  }

  /**
   * Resolve the final check-in URL based on property configuration.
   * This method respects the checkinFormMode setting:
   *   - 'auto': Use PMS native URL if available, otherwise NoFrontDesk form
   *   - 'pms_native': Always try PMS native URL, fall back to NoFrontDesk
   *   - 'nofrontdesk': Always use NoFrontDesk built-in form
   *   - 'custom_url': Use a custom URL provided by the host
   */
  resolveCheckInUrl(reservation, propertyConfig) {
    const mode = propertyConfig.checkinFormMode || 'auto';

    switch (mode) {
      case 'nofrontdesk':
        // Always use the built-in form
        return null;

      case 'custom_url':
        // Use the custom URL, with reservation ID substitution
        const customUrl = propertyConfig.customCheckinUrl || '';
        if (customUrl) {
          return customUrl
            .replace('{reservation_id}', reservation.id || '')
            .replace('{confirmation_code}', reservation.confirmationCode || '')
            .replace('{guest_name}', encodeURIComponent(
              `${reservation.guest?.firstName || ''} ${reservation.guest?.lastName || ''}`.trim()
            ));
        }
        return null;

      case 'pms_native':
      case 'auto':
      default:
        // Try PMS native URL, fall back to null (NoFrontDesk form)
        return this.buildCheckInUrl(reservation, propertyConfig);
    }
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
