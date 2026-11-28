'use strict';
const crypto = require('crypto');
const {
  admin, COLLECTIONS, authenticatedUser, clean, httpError, ownProfile, reply,
  requireCommunityLearner, requireEligible, requireSpeechConsent, store
} = require('../lib/calling');
const cors = require('../lib/cors');

const FREE_SECONDS = 600;
const FLAG_RETENTION_DAYS = 30;
let cachedAccessToken = '';
let cachedTokenExpiry = 0;
function now() { return Date.now(); }
function safeId(value, label) {
  const text = clean(value, 160);
  if (!text || text.includes('/') || !/^[a-zA-Z0-9_-]+$/.test(text)) throw httpError(400, 'Choose a valid ' + label + '.');
  return text;
}
function millis(value) { return value && typeof value.toMillis === 'function' ? value.toMillis() : Number(value || 0); }
function istDay() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const data = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return data.year + '-' + data.month + '-' + data.day;
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function b64url(value) { return Buffer.from(value).toString('base64url'); }
async function googleAccessToken() {
  if (cachedAccessToken && cachedTokenExpiry > now() + 60000) return cachedAccessToken;
  let account;
  try { account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}'); } catch (_) { throw httpError(503, 'Speech moderation service credentials are not configured.'); }
  if (!account.client_email || !account.private_key) throw httpError(503, 'Speech moderation service credentials are not configured.');
  const issuedAt = Math.floor(now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: issuedAt, exp: issuedAt + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = unsigned + '.' + signer.sign(account.private_key, 'base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw httpError(503, 'Google Speech-to-Text authorization failed.');
  cachedAccessToken = data.access_token;
  cachedTokenExpiry = now() + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}
async function transcribe(audioBase64) {
  const project = process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1';
  const response = await fetch('https://speech.googleapis.com/v2/projects/' + encodeURIComponent(project) + '/locations/asia-southeast1/recognizers/_:recognize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await googleAccessToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { autoDecodingConfig: {}, languageCodes: ['en-IN', 'hi-IN'], model: 'chirp_2', features: { enableAutomaticPunctuation: true } },
      content: audioBase64
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Speech API response:', response.status, data.error?.status || data.error?.message || 'unknown');
    throw httpError(503, 'Live language moderation is unavailable. Audio was stopped for now.');
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const language = results.map(item => item.languageCode || '').find(Boolean) || '';
  const transcript = results.map(item => item.alternatives?.[0]?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
  return { language, transcript: transcript.slice(0, 500) };
}
async function contextMembership(db, uid, profile, kind, contextId) {
  if (kind === 'session') {
    if (profile.activeSessionId !== contextId || profile.activeRoomId) throw httpError(403, 'This audio call is no longer active.');
    const ref = db.collection(COLLECTIONS.sessions).doc(contextId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().status !== 'active' || !(snap.data().participants || []).includes(uid)) throw httpError(403, 'This audio call is no longer active.');
    return { ref, data: snap.data() };
  }
  if (profile.activeRoomId !== contextId) throw httpError(403, 'This audio room is no longer active.');
  const ref = db.collection(COLLECTIONS.rooms).doc(contextId);
  const snap = await ref.get();
  const data = snap.data();
  if (!snap.exists || !data || data.status !== 'live' || !(data.members || []).some(member => member.uid === uid)) throw httpError(403, 'This audio room is no longer active.');
  return { ref, data };
}
async function endContextForSuspension(db, uid, kind, contextId) {
  if (kind === 'session') {
    const ref = db.collection(COLLECTIONS.sessions).doc(contextId);
    await db.runTransaction(async tx => {
      const session = await tx.get(ref);
      if (!session.exists || session.data().status !== 'active') return;
      const participants = session.data().participants || [];
      const others = participants.filter(id => id !== uid).map(id => db.collection(COLLECTIONS.profiles).doc(id));
      const snaps = await Promise.all(others.map(item => tx.get(item)));
      tx.update(ref, { status: 'blocked', endReason: 'language-moderation', endedAt: admin.firestore.FieldValue.serverTimestamp(), callCompleted: false });
      snaps.forEach((snap, index) => { if (snap.exists) tx.update(others[index], { activeSessionId: admin.firestore.FieldValue.delete(), availability: 'offline', updatedAt: admin.firestore.FieldValue.serverTimestamp() }); });
    });
    return;
  }
  const ref = db.collection(COLLECTIONS.rooms).doc(contextId);
  await db.runTransaction(async tx => {
    const roomSnap = await tx.get(ref);
    if (!roomSnap.exists || roomSnap.data().status !== 'live') return;
    const room = roomSnap.data();
    const members = room.members || [];
    const remaining = members.filter(member => member.uid !== uid);
    const close = room.hostUid === uid || remaining.length < 2;
    const toClear = close ? members : members.filter(member => member.uid === uid);
    const profiles = toClear.filter(member => member.uid !== uid).map(member => db.collection(COLLECTIONS.profiles).doc(member.uid));
    const profileSnaps = await Promise.all(profiles.map(item => tx.get(item)));
    tx.update(ref, close
      ? { status: 'ended', endReason: 'language-moderation', endedAt: admin.firestore.FieldValue.serverTimestamp(), members: [] }
      : { members: remaining, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    profileSnaps.forEach((snap, index) => { if (snap.exists) tx.update(profiles[index], { activeRoomId: admin.firestore.FieldValue.delete(), availability: 'offline', updatedAt: admin.firestore.FieldValue.serverTimestamp() }); });
  });
}
exports.handler = async event => {
  try {
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const db = store();
    const user = await authenticatedUser(event);
    requireCommunityLearner(user);
    const body = JSON.parse(event.body || '{}');
    const kind = body.sessionId ? 'session' : body.roomId ? 'room' : '';
    if (!kind || (body.sessionId && body.roomId)) throw httpError(400, 'Choose the active call or room.');
    const contextId = safeId(kind === 'session' ? body.sessionId : body.roomId, 'audio context');
    const sequence = Number(body.sequence);
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 1000000) throw httpError(400, 'Invalid audio segment.');
    const audioBase64 = String(body.audioBase64 || '');
    if (audioBase64.length < 100 || audioBase64.length > 1800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) throw httpError(400, 'Audio segment is invalid or too large.');
    if (body.mimeType && !/^audio\/webm(?:;|$)/i.test(String(body.mimeType))) throw httpError(415, 'Use a browser that supports short WebM/Opus audio segments.');
    const own = await ownProfile(db, user);
    requireEligible(own.data);
    requireSpeechConsent(own.data);
    await contextMembership(db, user.uid, own.data, kind, contextId);

    const day = istDay();
    const usageRef = db.collection(COLLECTIONS.dailyUsage).doc(user.uid + '_' + day);
    const claimRef = db.collection(COLLECTIONS.audioChunkClaims).doc(hash(user.uid + '|' + kind + '|' + contextId + '|' + sequence));
    const moderationRef = db.collection(COLLECTIONS.languageModeration).doc(hash(user.uid));
    const reservation = await db.runTransaction(async tx => {
      const [claimSnap, usageSnap, profileSnap] = await Promise.all([tx.get(claimRef), tx.get(usageRef), tx.get(own.ref)]);
      if (claimSnap.exists) return { duplicate: true, remaining: Math.max(0, FREE_SECONDS - Number(usageSnap.data()?.seconds || 0)), paid: millis(profileSnap.data()?.subscriptionEndsAt) > now() };
      const profile = profileSnap.data();
      const paid = millis(profile.subscriptionEndsAt) > now();
      const used = Number(usageSnap.data()?.seconds || 0);
      if (!paid && used >= FREE_SECONDS) throw httpError(402, 'Your 10 free audio minutes for today are used.');
      const reservedSeconds = paid ? 0 : Math.min(8, FREE_SECONDS - used);
      tx.create(claimRef, { uid: user.uid, contextType: kind, contextId, sequence, seconds: reservedSeconds || 8, createdAt: admin.firestore.FieldValue.serverTimestamp(), deleteAt: admin.firestore.Timestamp.fromMillis(now() + 30 * 24 * 60 * 60 * 1000) });
      if (!paid) tx.set(usageRef, {
        uid: user.uid, day, seconds: used + reservedSeconds,
        deleteAt: admin.firestore.Timestamp.fromMillis(now() + 90 * 24 * 60 * 60 * 1000),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { duplicate: false, paid, remaining: paid ? FREE_SECONDS : Math.max(0, FREE_SECONDS - used - reservedSeconds) };
    });
    if (reservation.duplicate) return reply(200, { ok: true, duplicate: true, paidActive: reservation.paid, remainingSeconds: reservation.remaining });
    const detected = await transcribe(audioBase64);
    const isHindi = /^hi(?:-|$)/i.test(detected.language) && detected.transcript.length >= 2;
    if (!isHindi) return reply(200, { ok: true, language: detected.language || null, paidActive: reservation.paid, remainingSeconds: reservation.remaining });
    const flaggedAt = now();
    const flaggedUntil = admin.firestore.Timestamp.fromMillis(flaggedAt + FLAG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let strikes = 0;
    await db.runTransaction(async tx => {
      const [moderationSnap, profileSnap] = await Promise.all([tx.get(moderationRef), tx.get(own.ref)]);
      strikes = Number(moderationSnap.data()?.strikes || 0) + 1;
      tx.set(moderationRef, {
        uid: user.uid, contextType: kind, contextId, strikes, lastFlaggedAt: admin.firestore.Timestamp.fromMillis(flaggedAt),
        deleteAt: flaggedUntil, updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (strikes >= 3 && profileSnap.exists) {
        tx.update(own.ref, {
          status: 'suspended', moderationStatus: 'suspended', availability: 'offline',
          activeSessionId: admin.firestore.FieldValue.delete(), activeRoomId: admin.firestore.FieldValue.delete(),
          suspendedReason: 'Repeated Hindi speech detected during an English practice call.',
          suspendedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
    await db.collection(COLLECTIONS.languageEvents).add({
      uid: user.uid, contextType: kind, contextId, detectedLanguage: detected.language,
      excerpt: detected.transcript.slice(0, 350), strike: strikes,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), deleteAt: flaggedUntil
    });
    if (strikes >= 3) {
      await endContextForSuspension(db, user.uid, kind, contextId);
      return reply(200, { ok: true, blocked: true, strikes, paidActive: reservation.paid, remainingSeconds: reservation.remaining, message: 'Hindi was detected three times. Audio has ended and your account is suspended pending admin review.' });
    }
    return reply(200, { ok: true, warning: true, strikes, paidActive: reservation.paid, remainingSeconds: reservation.remaining, message: 'Hindi was detected. Please continue in English. This is warning ' + strikes + ' of 2; a third detection will suspend audio access.' });
  } catch (error) {
    console.error('Calling transcription:', error.message);
    const status = error.status || 500;
    return reply(status, { ok: false, error: error.message || 'Live language moderation failed.' });
  }
};
const handler = exports.handler;
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return cors.options(event);
  const response = await handler(event);
  return { ...response, headers: { ...(response.headers || {}), ...cors.headers(event) } };
};
