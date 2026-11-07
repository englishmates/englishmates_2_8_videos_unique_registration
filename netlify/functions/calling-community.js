const {
  admin, COLLECTIONS, asArray, areBlocked, audit, authenticatedUser, clean,
  consumeLimit, httpError, iso, ownProfile, publicProfile, reply,
  requireEligible, store
} = require('../lib/calling');
const cors = require('../lib/cors');

const LEVELS = ['Beginner', 'Intermediate', 'Advanced'];
const TOPICS = ['Daily conversation', 'Interview', 'Public speaking', 'Grammar', 'Vocabulary', 'Travel', 'Personality development'];
const LANGUAGES = ['English', 'Hindi + English'];
const LOCATION_PREFERENCES = ['Same city preferred', 'Same state preferred', 'Anywhere in India'];
const QUEUE_MS = 5 * 60 * 1000;
const INVITE_MS = 90 * 1000;
const SESSION_MS = 15 * 60 * 1000;

function now() { return Date.now(); }
function timestampMs(value) { return value?.toMillis?.() || Number(value) || 0; }
function allowed(value, options, label) {
  const result = clean(value, 80);
  if (!options.includes(result)) throw httpError(400, `Choose a valid ${label}.`);
  return result;
}

function profileInput(body) {
  const fullName = clean(body.fullName, 80);
  const alias = clean(body.alias || fullName.split(' ')[0], 32);
  const age = Number(body.age);
  const city = clean(body.city, 80);
  const state = clean(body.state, 80);
  const interests = asArray(body.interests, TOPICS, 7);
  const goals = clean(body.goals, 500);
  if (fullName.length < 2 || alias.length < 2 || !Number.isInteger(age) || age < 18 || age > 100 || city.length < 2 || state.length < 2 || interests.length === 0 || goals.length < 5) {
    throw httpError(400, 'Complete your name, adult age, city, state, interests and learning goals.');
  }
  return {
    fullName, alias, age, city, state, interests, goals,
    level: allowed(body.level, LEVELS, 'English level'),
    preferredLanguage: allowed(body.preferredLanguage, LANGUAGES, 'practice language'),
    locationPreference: allowed(body.locationPreference || 'Anywhere in India', LOCATION_PREFERENCES, 'location preference')
  };
}

function sessionFor(userId, session) {
  if (!session || !Array.isArray(session.participants) || !session.participants.includes(userId)) throw httpError(403, 'This call does not belong to your account.');
}

function partnerId(userId, session) {
  return session.participants.find(uid => uid !== userId);
}

async function activeSession(db, user) {
  const profile = await ownProfile(db, user);
  if (!profile.data.activeSessionId) return { profile, ref: null, data: null };
  const ref = db.collection(COLLECTIONS.sessions).doc(profile.data.activeSessionId);
  const snapshot = await ref.get();
  return { profile, ref, data: snapshot.exists ? snapshot.data() : null };
}

async function closeSession(db, sessionRef, reason, actor) {
  await db.runTransaction(async tx => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) return;
    const session = snap.data();
    if (!['invited', 'accepted', 'active'].includes(session.status)) return;
    const finalStatus = reason === 'blocked' ? 'blocked' : reason === 'expired' ? 'expired' : reason === 'declined' ? 'declined' : 'ended';
    tx.update(sessionRef, {
      status: finalStatus,
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endReason: reason,
      endedBy: actor?.uid || null
    });
    for (const uid of session.participants || []) {
      tx.update(db.collection(COLLECTIONS.profiles).doc(uid), { activeSessionId: admin.firestore.FieldValue.delete(), lastSessionId: finalStatus === 'declined' ? admin.firestore.FieldValue.delete() : sessionRef.id, availability: 'offline', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  });
}

function matchingScore(one, two) {
  const shared = one.interests.filter(topic => two.interests.includes(topic));
  if (!shared.length || Math.abs(LEVELS.indexOf(one.level) - LEVELS.indexOf(two.level)) > 1) return -1;
  let score = shared.length * 10;
  if (one.preferredLanguage === two.preferredLanguage) score += 3;
  if (one.locationPreference === 'Same city preferred' && one.city.toLowerCase() === two.city.toLowerCase()) score += 4;
  else if (one.locationPreference !== 'Anywhere in India' && one.state.toLowerCase() === two.state.toLowerCase()) score += 2;
  return score;
}

async function findMatch(db, user) {
  const own = await ownProfile(db, user);
  requireEligible(own.data);
  const waiting = await db.collection(COLLECTIONS.queues).where('status', '==', 'waiting').limit(60).get();
  const candidates = [];
  for (const queue of waiting.docs) {
    if (queue.id === user.uid || timestampMs(queue.data().expiresAt) <= now()) continue;
    const candidateProfile = await db.collection(COLLECTIONS.profiles).doc(queue.id).get();
    if (!candidateProfile.exists) continue;
    const data = candidateProfile.data();
    if (data.status !== 'approved' || data.countryStatus !== 'approved' || data.moderationStatus === 'suspended') continue;
    const score = matchingScore(own.data, data);
    if (score >= 0 && !(await areBlocked(db, user.uid, queue.id))) candidates.push({ uid: queue.id, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    const result = await db.runTransaction(async tx => {
      const ownRef = db.collection(COLLECTIONS.profiles).doc(user.uid);
      const otherRef = db.collection(COLLECTIONS.profiles).doc(candidate.uid);
      const ownQueueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
      const otherQueueRef = db.collection(COLLECTIONS.queues).doc(candidate.uid);
      const [ownSnap, otherSnap, ownQueue, otherQueue] = await Promise.all([tx.get(ownRef), tx.get(otherRef), tx.get(ownQueueRef), tx.get(otherQueueRef)]);
      if (!ownSnap.exists || !otherSnap.exists || !ownQueue.exists || !otherQueue.exists) return null;
      if (ownSnap.data().activeSessionId || otherSnap.data().activeSessionId || ownQueue.data().status !== 'waiting' || otherQueue.data().status !== 'waiting' || timestampMs(otherQueue.data().expiresAt) <= now()) return null;
      if (matchingScore(ownSnap.data(), otherSnap.data()) < 0) return null;
      const ref = db.collection(COLLECTIONS.sessions).doc();
      const inviteExpiresAt = admin.firestore.Timestamp.fromMillis(now() + INVITE_MS);
      tx.set(ref, { participants: [user.uid, candidate.uid], status: 'invited', acceptedBy: [], createdAt: admin.firestore.FieldValue.serverTimestamp(), inviteExpiresAt, expiresAt: admin.firestore.Timestamp.fromMillis(now() + SESSION_MS), channelId: ref.id });
      tx.delete(ownQueueRef); tx.delete(otherQueueRef);
      tx.update(ownRef, { activeSessionId: ref.id, availability: 'invited', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.update(otherRef, { activeSessionId: ref.id, availability: 'invited', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { id: ref.id, participant: candidate.uid };
    });
    if (result) return result;
  }
  return null;
}

async function dashboard(db, user) {
  const { profile, ref, data: session } = await activeSession(db, user);
  if (session && ((['invited', 'accepted'].includes(session.status) && timestampMs(session.inviteExpiresAt) <= now()) || (session.status === 'active' && timestampMs(session.expiresAt) <= now()))) {
    await closeSession(db, ref, 'expired');
    return dashboard(db, user);
  }
  const queue = await db.collection(COLLECTIONS.queues).doc(user.uid).get();
  const waiting = queue.exists && timestampMs(queue.data().expiresAt) > now() ? queue.data() : null;
  if (queue.exists && !waiting) await queue.ref.delete();
  let partner = null;
  if (session) {
    const partnerSnap = await db.collection(COLLECTIONS.profiles).doc(partnerId(user.uid, session)).get();
    if (partnerSnap.exists) partner = publicProfile(partnerSnap.data());
  }
  let recentSession = null;
  if (!session && profile.data?.lastSessionId) {
    const last = await db.collection(COLLECTIONS.sessions).doc(profile.data.lastSessionId).get();
    if (last.exists && ['ended', 'blocked', 'expired'].includes(last.data().status) && last.data().participants.includes(user.uid)) recentSession = { id: last.id, status: last.data().status };
  }
  let onlineLearners = 0;
  try { onlineLearners = (await db.collection(COLLECTIONS.queues).where('status', '==', 'waiting').count().get()).data().count; } catch (_) { /* Aggregate is optional in local emulators. */ }
  return { ok: true, profile: profile.data ? { fullName: profile.data.fullName, alias: profile.data.alias, email: profile.data.email, emailVerified: true, age: profile.data.age, city: profile.data.city, state: profile.data.state, level: profile.data.level, interests: profile.data.interests, goals: profile.data.goals, preferredLanguage: profile.data.preferredLanguage, locationPreference: profile.data.locationPreference, status: profile.data.status || 'pending', createdAt: iso(profile.data.createdAt), reviewedAt: iso(profile.data.reviewedAt) } : null, queue: waiting ? { expiresAt: iso(waiting.expiresAt) } : null, session: session ? { id: ref.id, status: session.status, acceptedBy: session.acceptedBy || [], inviteExpiresAt: iso(session.inviteExpiresAt), expiresAt: iso(session.expiresAt), partner } : null, recentSession, onlineLearners };
}

exports.handler = async event => {
  try {
    const db = store();
    const user = await authenticatedUser(event);
    if (event.httpMethod === 'GET') return reply(200, await dashboard(db, user));
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');
    const action = clean(body.action, 40);
    if (action === 'register-profile' || action === 'update-profile') {
      const input = profileInput(body.profile || {});
      const own = await ownProfile(db, user, false);
      const isNew = !own.exists;
      const existingStatus = own.data?.status || 'pending';
      const status = existingStatus === 'approved' || existingStatus === 'suspended' ? existingStatus : 'pending';
      await own.ref.set({ ...input, uid: user.uid, email: user.email, emailVerified: true, countryCode: 'IN', countryStatus: status === 'approved' ? 'approved' : 'pending', adultConfirmed: true, status, moderationStatus: status === 'suspended' ? 'suspended' : 'active', availability: 'offline', updatedAt: admin.firestore.FieldValue.serverTimestamp(), ...(isNew ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}) }, { merge: true });
      await audit(db, user, isNew ? 'profile_created' : 'profile_updated', user.uid);
      return reply(200, { ok: true, message: status === 'approved' ? 'Your approved profile was updated.' : 'Profile saved and queued for administrator approval.' });
    }
    const own = await ownProfile(db, user);
    if (action === 'join-queue') {
      requireEligible(own.data); await consumeLimit(db, user.uid, 'queue', 8, 60 * 60 * 1000);
      if (own.data.activeSessionId) throw httpError(409, 'Finish or decline your current call invitation first.');
      await db.collection(COLLECTIONS.queues).doc(user.uid).set({ uid: user.uid, status: 'waiting', createdAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromMillis(now() + QUEUE_MS) });
      await own.ref.update({ availability: 'waiting', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      const match = await findMatch(db, user);
      return reply(200, { ok: true, message: match ? 'A compatible learner was found. Review the invitation.' : 'You are in the matching queue. We will look for a partner for five minutes.' });
    }
    if (action === 'leave-queue') {
      await db.collection(COLLECTIONS.queues).doc(user.uid).delete().catch(() => {});
      if (!own.data.activeSessionId) await own.ref.update({ availability: 'offline', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return reply(200, { ok: true, message: 'You left the matching queue.' });
    }
    const current = await activeSession(db, user);
    if (action === 'submit-feedback' && (!current.ref || !current.data)) {
      const lastId = own.data.lastSessionId;
      if (!lastId) throw httpError(404, 'There is no completed call to rate.');
      const lastRef = db.collection(COLLECTIONS.sessions).doc(lastId); const lastSnap = await lastRef.get();
      if (!lastSnap.exists || !['ended', 'blocked', 'expired'].includes(lastSnap.data().status)) throw httpError(409, 'Feedback becomes available after a call ends.');
      const rating = Number(body.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw httpError(400, 'Give a rating from 1 to 5.');
      await lastRef.collection('feedback').doc(user.uid).set({ rating, note: clean(body.note, 500), createdAt: admin.firestore.FieldValue.serverTimestamp() });
      return reply(200, { ok: true, message: 'Thank you for your feedback.' });
    }
    if (!current.ref || !current.data) throw httpError(404, 'There is no active call invitation.');
    const session = current.data; sessionFor(user.uid, session);
    if (action === 'accept-call') {
      if (!['invited', 'accepted'].includes(session.status) || timestampMs(session.inviteExpiresAt) <= now()) { await closeSession(db, current.ref, 'expired'); throw httpError(410, 'This invitation has expired.'); }
      await db.runTransaction(async tx => {
        const snap = await tx.get(current.ref); if (!snap.exists || !['invited', 'accepted'].includes(snap.data().status)) throw httpError(409, 'This invitation is no longer available.');
        const acceptedBy = [...new Set([...(snap.data().acceptedBy || []), user.uid])];
        const active = acceptedBy.length === 2;
        tx.update(current.ref, { acceptedBy, status: active ? 'active' : 'accepted', acceptedAt: admin.firestore.FieldValue.serverTimestamp(), ...(active ? { startedAt: admin.firestore.FieldValue.serverTimestamp() } : {}) });
        if (active) for (const uid of snap.data().participants) tx.update(db.collection(COLLECTIONS.profiles).doc(uid), { availability: 'in_call', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return reply(200, { ok: true, message: 'Acceptance saved. The call starts when both learners accept.' });
    }
    if (action === 'decline-call' || action === 'end-call') { await closeSession(db, current.ref, action === 'decline-call' ? 'declined' : 'ended', user); return reply(200, { ok: true, message: action === 'decline-call' ? 'Invitation declined.' : 'Call ended.' }); }
    const otherUid = partnerId(user.uid, session);
    if (action === 'block-current-partner') {
      await db.collection(COLLECTIONS.blocks).doc(require('../lib/calling').blockId(user.uid, otherUid)).set({ blockerUid: user.uid, blockedUid: otherUid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      await closeSession(db, current.ref, 'blocked', user); await audit(db, user, 'partner_blocked', otherUid);
      return reply(200, { ok: true, message: 'The learner was blocked and the call was ended.' });
    }
    if (action === 'report-current-partner') {
      const reason = clean(body.reason, 120); const details = clean(body.details, 1000);
      if (reason.length < 3) throw httpError(400, 'Choose or describe a report reason.');
      await consumeLimit(db, user.uid, 'report', 5, 24 * 60 * 60 * 1000);
      await db.collection(COLLECTIONS.reports).add({ reporterUid: user.uid, reportedUid: otherUid, sessionId: current.ref.id, reason, details, status: 'open', createdAt: admin.firestore.FieldValue.serverTimestamp() });
      await audit(db, user, 'partner_reported', otherUid, { sessionId: current.ref.id });
      return reply(200, { ok: true, message: 'Your report was sent to Englishmates for review.' });
    }
    if (action === 'submit-feedback') {
      if (!['ended', 'blocked', 'expired'].includes(session.status)) throw httpError(409, 'Feedback becomes available after the call ends.');
      const rating = Number(body.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw httpError(400, 'Give a rating from 1 to 5.');
      await current.ref.collection('feedback').doc(user.uid).set({ rating, note: clean(body.note, 500), createdAt: admin.firestore.FieldValue.serverTimestamp() });
      return reply(200, { ok: true, message: 'Thank you for your feedback.' });
    }
    throw httpError(400, 'Unknown action.');
  } catch (error) {
    console.error('Calling Community:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Request failed.' });
  }
};

const handler = exports.handler;
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return cors.options(event);
  const response = await handler(event);
  return { ...response, headers: { ...(response.headers || {}), ...cors.headers(event) } };
};
