const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const { authenticatedUser, requireCommunityLearner, consumeLimit, httpError, ownProfile, reply, requireEligible, store, COLLECTIONS } = require('../lib/calling');
const cors = require('../lib/cors');

exports.handler = async event => {
  try {
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const db = store();
    const user = await authenticatedUser(event);
    requireCommunityLearner(user);
    const body = JSON.parse(event.body || '{}');
    const roomId = String(body.roomId || '').trim();
    const sessionId = String(body.sessionId || '').trim();
    if (!!roomId === !!sessionId) throw httpError(400, 'Choose one active audio room or call.');
    const profile = await ownProfile(db, user);
    requireEligible(profile.data);
    const appId = process.env.AGORA_APP_ID;
    const certificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !certificate) throw httpError(503, 'Audio is not configured yet.');
    await consumeLimit(db, user.uid, 'audio_token', 30, 60 * 60 * 1000);
    const expiresAt = Math.floor(Date.now() / 1000) + (roomId ? 120 : 300);

    if (roomId) {
      if (roomId.length > 160 || roomId.includes('/') || profile.data.activeRoomId !== roomId) throw httpError(403, 'This topic room is not active for your account.');
      const room = await db.collection(COLLECTIONS.rooms).doc(roomId).get();
      if (!room.exists || room.data().status !== 'live' || Number(room.data().expiresAt?.toMillis?.() || 0) <= Date.now()) throw httpError(410, 'This topic room has ended.');
      const member = (room.data().members || []).find(item => item.uid === user.uid);
      if (!member || !Number.isInteger(Number(member.rtcUid)) || Number(member.rtcUid) <= 0) throw httpError(403, 'Join this topic room before connecting audio.');
      const token = RtcTokenBuilder.buildTokenWithUid(appId, certificate, room.data().channelId, Number(member.rtcUid), RtcRole.PUBLISHER, expiresAt);
      return reply(200, { ok: true, appId, channel: room.data().channelId, token, uid: Number(member.rtcUid), roomId, expiresAt });
    }

    if (profile.data.activeRoomId || sessionId.length > 160 || profile.data.activeSessionId !== sessionId) throw httpError(403, 'This call is not active for your account.');
    const session = await db.collection(COLLECTIONS.sessions).doc(sessionId).get();
    if (!session.exists || session.data().status !== 'active' || !session.data().participants.includes(user.uid)) throw httpError(403, 'Both learners must accept before audio can start.');
    const token = RtcTokenBuilder.buildTokenWithUid(appId, certificate, session.data().channelId, 0, RtcRole.PUBLISHER, expiresAt);
    return reply(200, { ok: true, appId, channel: session.data().channelId, token, uid: 0, sessionId, expiresAt });
  } catch (error) {
    console.error('Calling token:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Request failed.' });
  }
};

const handler = exports.handler;
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return cors.options(event);
  const response = await handler(event);
  return { ...response, headers: { ...(response.headers || {}), ...cors.headers(event) } };
};
