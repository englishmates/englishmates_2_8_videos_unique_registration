const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const { authenticatedUser, consumeLimit, httpError, ownProfile, reply, requireEligible, store } = require('../lib/calling');

exports.handler = async event => {
  try {
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const db = store(); const user = await authenticatedUser(event);
    const { sessionId } = JSON.parse(event.body || '{}');
    if (!sessionId || String(sessionId).length > 160) throw httpError(400, 'Invalid call session.');
    const profile = await ownProfile(db, user);
    requireEligible(profile.data);
    if (profile.data.activeSessionId !== sessionId) throw httpError(403, 'This call is not active for your account.');
    const session = await db.collection(require('../lib/calling').COLLECTIONS.sessions).doc(String(sessionId)).get();
    if (!session.exists || session.data().status !== 'active' || !session.data().participants.includes(user.uid)) throw httpError(403, 'Both learners must accept before audio can start.');
    const appId = process.env.AGORA_APP_ID; const certificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !certificate) throw httpError(503, 'Audio is not configured yet.');
    await consumeLimit(db, user.uid, 'audio_token', 30, 60 * 60 * 1000);
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const token = RtcTokenBuilder.buildTokenWithUid(appId, certificate, session.data().channelId, 0, RtcRole.PUBLISHER, expiresAt);
    return reply(200, { ok: true, appId, channel: session.data().channelId, token, expiresAt });
  } catch (error) {
    console.error('Calling token:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Request failed.' });
  }
};
