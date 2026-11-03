const crypto = require('crypto');

const reply = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Cache-Control': 'no-store', ...headers },
  body
});

function makeState(secret) {
  const payload = Buffer.from(JSON.stringify({
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(18).toString('hex')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}

exports.handler = async event => {
  if (process.env.CONTEXT !== 'deploy-preview') {
    return reply(403, 'Google Calendar OAuth setup is currently restricted to the Englishmates preview deployment.');
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const stateSecret = process.env.OAUTH_STATE_SECRET;
  if (!clientId || !redirectUri || !stateSecret) {
    return reply(500, 'OAuth setup is incomplete. Configure GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_REDIRECT_URI and OAUTH_STATE_SECRET in Netlify.');
  }
  try {
    const state = makeState(stateSecret);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.events',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state
    });
    return {
      statusCode: 302,
      headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(), 'Cache-Control': 'no-store' },
      body: ''
    };
  } catch (error) {
    console.error('Google OAuth start error:', error);
    return reply(500, 'Could not start Google authorization.');
  }
};
