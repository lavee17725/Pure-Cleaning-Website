// Phase 1 (2026-06-11): homepage replaced with static public/index.html.
// The CRA build pipeline still bundles this file, but it is intentionally a no-op:
// the new static homepage does not include <div id="root">, so React must not try
// to mount. Empty entrypoint means an empty bundle — no console errors, no overhead.
//
// To restore the React app, re-add <div id="root"></div> to public/index.html
// and restore the mount logic below:
//   import React from 'react';
//   import ReactDOM from 'react-dom/client';
//   import './index.css';
//   import App from './App';
//   ReactDOM.createRoot(document.getElementById('root')).render(<App />);
