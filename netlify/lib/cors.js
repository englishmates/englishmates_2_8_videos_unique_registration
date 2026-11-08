// GitHub Pages hosts the public UI while Netlify hosts the protected APIs.
// Only explicitly trusted frontend origins receive CORS permission.
const ALLOWED_ORIGINS = new Set([
  'https://englishmates.github.io',
  'https://englishmates-ratangarh.netlify.app'
]);

function headers(event = {}) {
  const requestHeaders = event.headers || {};
  const origin = requestHeaders.origin || requestHeaders.Origin || '';
  const result = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };

  // Never reflect an untrusted origin or use wildcard CORS.
  if (ALLOWED_ORIGINS.has(origin)) {
    result['Access-Control-Allow-Origin'] = origin;
  }

  return result;
}

function options(event) {
  return { statusCode: 204, headers: headers(event), body: '' };
}

module.exports = { headers, options };
