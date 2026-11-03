const crypto = require('crypto');
const admin = require('firebase-admin');

const HOST_EMAIL = 'bddayma12@gmail.com';

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  body
});
const page = message => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Englishmates Google Calendar</title></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:12vh auto;padding:24px;line-height:1.6"><h2>Englishmates Google Calendar</h2><p>' + message + '</p><p>You can close this window.</p></body></html>';

function parseState(state, secret) {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], 'base64url'); } catch (_) { return null; }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const age = Date.now() - payload.issuedAt;
    if (!Number.isFinite(payload.issuedAt) || age < 0 || age > 10 * 60 * 1000 ||
        typeof payload.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(payload.nonce)) return null;
    return payload;
  } catch (_) { return null; }
}

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Firebase service account is not configured');
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1'
    });
  }
  return admin.firestore();
}

async function consumeState(db, nonce) {
  const ref = db.collection('oauthStates').doc(nonce);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data();
    if (data.purpose !== 'google-calendar-preview' || data.used !== false ||
        !Number.isFinite(data.expiresAt) || data.expiresAt < Date.now()) return false;
    tx.update(ref, { used: true, consumedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
}

exports.handler = async event => {
  if (process.env.CONTEXT !== 'deploy-preview') {
    return reply(403, page('This authorization callback is currently restricted to the Englishmates preview deployment.'));
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const stateSecret = process.env.OAUTH_STATE_SECRET;
  const encryptionKeyHex = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '';
  if (!clientId || !clientSecret || !redirectUri || !stateSecret || !/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) {
    return reply(500, page('OAuth setup is incomplete. Please check the required Netlify environment variables, including the 64-character GOOGLE_TOKEN_ENCRYPTION_KEY.'));
  }
  const params = event.queryStringParameters || {};
  if (params.error) return reply(400, page('Google authorization was not completed.'));
  const state = parseState(params.state, stateSecret);
  if (!params.code || !state) {
    return reply(400, page('The authorization response is missing or expired. Please start the connection again from the preview website.'));
  }
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: params.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error('Google token exchange failed:', tokens.error || tokenResponse.status);
      return reply(502, page('Google could not complete authorization. Please check the OAuth client settings and try again.'));
    }
    if (!tokens.refresh_token || !tokens.id_token) {
      return reply(400, page('Google did not return the required authorization tokens. Please restart the connection and grant consent.'));
    }

    const verifyResponse = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tokens.id_token));
    const identity = await verifyResponse.json();
    if (!verifyResponse.ok || identity.aud !== clientId ||
        String(identity.email || '').toLowerCase() !== HOST_EMAIL ||
        identity.email_verified !== 'true' || identity.nonce !== state.nonce) {
      return reply(403, page('Please connect using the authorized Englishmates host Google account: ' + HOST_EMAIL + '.'));
    }

    const db = getDb();
    if (!(await consumeState(db, state.nonce))) {
      return reply(400, page('This authorization request has already been used or has expired. Please start again.'));
    }

    const key = Buffer.from(encryptionKeyHex, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encryptedToken = Buffer.concat([cipher.update(tokens.refresh_token, 'utf8'), cipher.final()]);
    await db.collection('integrationSecrets').doc('googleCalendarPreview').set({
      provider: 'google',
      service: 'calendar',
      hostEmail: HOST_EMAIL,
      refreshTokenEncrypted: encryptedToken.toString('base64'),
      refreshTokenIv: iv.toString('base64'),
      refreshTokenAuthTag: cipher.getAuthTag().toString('base64'),
      tokenType: tokens.token_type || 'Bearer',
      scope: tokens.scope || 'https://www.googleapis.com/auth/calendar.events',
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      connectedBy: 'preview-oauth'
    }, { merge: true });
    return reply(200, page('Google Calendar authorization was received for the approved Englishmates host account and the refresh token was encrypted and stored for preview. No live website settings were changed.'));
  } catch (error) {
    console.error('Google OAuth callback error:', error.message);
    return reply(500, page('The authorization could not be saved. Please check the preview server configuration.'));
  }
};
