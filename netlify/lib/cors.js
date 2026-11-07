// GitHub Pages hosts the public UI while Netlify hosts these protected APIs.
// Keep this allow-list deliberately narrow; Firebase ID tokens must never be
// accepted from arbitrary browser origins.
const ALLOWED_ORIGINS = new Set([
  'https://englishmates.github.io',
  'https://englishmates-ratangarh.netlify.app'
]);

function headers(event = {}) {
  const requestHeaders = event.headers || {};
  const origin = requestHeaders.origin || requestHeaders.Origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://englishmates.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function options(event) {
  return { statusCode: 204, headers: headers(event), body: '' };
}

module.exports = { headers, options };
