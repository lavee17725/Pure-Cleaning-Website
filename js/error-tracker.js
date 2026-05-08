/* Pure Cleaning error tracker — loads early in every page */
(function () {
  var API = 'https://purecleaning-api.tylerfumero.workers.dev';
  var isAdmin = location.pathname.indexOf('pure_cleaning_') !== -1 ||
                location.pathname.indexOf('login') !== -1;

  function report(payload) {
    // Admin pages: 100% capture. Customer-facing pages: 10% sample.
    if (!isAdmin && Math.random() > 0.1) return;
    try {
      fetch(API + '/errors/log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://purecleaningpressurecleaning.com',
        },
        body: JSON.stringify(Object.assign({ timestamp: new Date().toISOString() }, payload)),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      // Swallow — error logger must never throw
    }
  }

  window.addEventListener('error', function (ev) {
    report({
      source:    'client',
      page:      location.pathname.split('/').pop() || 'index',
      errorType: (ev.error && ev.error.name) || 'Error',
      message:   (ev.message || 'Unknown error').slice(0, 500),
      stack:     ((ev.error && ev.error.stack) || '').slice(0, 2000),
      url:       location.href,
    });
  });

  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason || {};
    report({
      source:    'client',
      page:      location.pathname.split('/').pop() || 'index',
      errorType: 'UnhandledPromiseRejection',
      message:   ((reason.message || String(reason)) + '').slice(0, 500),
      stack:     (reason.stack || '').slice(0, 2000),
      url:       location.href,
    });
  });
})();
