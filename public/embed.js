// âââââââââââââââââââââââââââââââââââââââââââââ
// NoFrontDesk Embeddable Check-In Widget
// Usage: <script src="https://app.nofrontdesk.com/embed.js"
//          data-account="account-slug"
//          data-property="property-slug"></script>
// âââââââââââââââââââââââââââââââââââââââââââââ
(function () {
  'use strict';

  // Find the script tag to read data attributes
  var scripts = document.querySelectorAll('script[data-account][data-property]');
  var scriptTag = scripts[scripts.length - 1]; // last matching script = current one

  if (!scriptTag) {
    console.error('[NoFrontDesk] Missing data-account and data-property attributes on script tag.');
    return;
  }

  var accountSlug = scriptTag.getAttribute('data-account');
  var propertySlug = scriptTag.getAttribute('data-property');
  var theme = scriptTag.getAttribute('data-theme') || 'auto'; // auto | light | dark
  var width = scriptTag.getAttribute('data-width') || '100%';
  var height = scriptTag.getAttribute('data-height') || '650';
  var baseUrl = scriptTag.getAttribute('data-base-url') || 'https://app.nofrontdesk.com';

  if (!accountSlug || !propertySlug) {
    console.error('[NoFrontDesk] data-account and data-property are required.');
    return;
  }

  // Build the embed URL
  var embedUrl = baseUrl + '/embed/' + encodeURIComponent(accountSlug) + '/' + encodeURIComponent(propertySlug);
  var params = [];
  if (theme !== 'auto') params.push('theme=' + theme);
  if (params.length) embedUrl += '?' + params.join('&');

  // Create container
  var container = document.createElement('div');
  container.id = 'nofrontdesk-checkin-widget';
  container.style.cssText = 'max-width:480px;margin:0 auto;';

  // Create iframe
  var iframe = document.createElement('iframe');
  iframe.src = embedUrl;
  iframe.style.cssText = 'border:none;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08);';
  iframe.width = width;
  iframe.height = height;
  iframe.setAttribute('title', 'Guest Check-In');
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('allow', 'clipboard-write');

  // Allow iframe to resize itself
  window.addEventListener('message', function (event) {
    try {
      var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data.type === 'nofrontdesk-resize' && data.height) {
        iframe.style.height = data.height + 'px';
      }
    } catch (e) {
      // Ignore non-JSON messages
    }
  });

  container.appendChild(iframe);

  // Insert right after the script tag
  if (scriptTag.parentNode) {
    scriptTag.parentNode.insertBefore(container, scriptTag.nextSibling);
  }

  // Expose API for programmatic control
  window.NoFrontDesk = window.NoFrontDesk || {};
  window.NoFrontDesk.widget = {
    iframe: iframe,
    container: container,
    reload: function () {
      iframe.src = embedUrl;
    },
    destroy: function () {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    },
  };
})();
