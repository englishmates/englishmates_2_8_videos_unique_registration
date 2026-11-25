const {
  admin, COLLECTIONS, asArray, areBlocked, audit, authenticatedUser, clean, requireCommunityLearner,
  blockId, consumeLimit, httpError, iso, ownProfile, publicProfile, reply, safeAvatar,
  requireEligible, store
} = require('../lib/calling');
const cors = require('../lib/cors');
const { pairId, isOnline, publicPartner } = require('../lib/partner-community');

const LEVELS = ['Beginner', 'Elementary', 'Intermediate', 'Upper Intermediate', 'Advanced'];
const TOPICS = ['Daily conversation', 'Interview', 'Public speaking', 'Grammar', 'Vocabulary', 'Travel', 'Personality development'];
const LANGUAGES = ['English', 'Hindi + English'];
const LOCATION_PREFERENCES = ['Same city preferred', 'Same state preferred', 'Anywhere in India'];
const QUEUE_MS = 5 * 60 * 1000;
const CHAT_LIMIT = 50;
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
  const intro = clean(body.intro, 180);
  const avatarURL = body.avatarDataUrl ? safeAvatar(body.avatarDataUrl) : null;
  if (body.avatarDataUrl && (!avatarURL || !avatarURL.startsWith('data:image/'))) throw httpError(400, 'Use a small PNG, JPEG, or WebP profile picture.');
  if (containsContactDetails(alias)) throw httpError(400, 'Use a speaking name without an email address or phone number.');
  if (intro && containsContactDetails(intro)) throw httpError(400, 'Do not add an email address or phone number to your public introduction.');
  if (fullName.length < 2 || alias.length < 2 || !Number.isInteger(age) || age < 18 || age > 100 || city.length < 2 || state.length < 2 || interests.length === 0 || goals.length < 5) {
    throw httpError(400, 'Complete your name, adult age, city, state, interests and learning goals.');
  }
  return {
    fullName, alias, age, city, state, interests, goals, intro, ...(avatarURL ? { avatarURL } : {}),
    level: allowed(body.level, LEVELS, 'English level'),
    preferredLanguage: allowed(body.preferredLanguage, LANGUAGES, 'practice language'),
    locationPreference: allowed(body.locationPreference || 'Anywhere in India', LOCATION_PREFERENCES, 'location preference')
  };
}

function containsContactDetails(value) {
  const text = String(value || '');
  const digits = text.replace(/\D/g, '');
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) || /0?[6-9]\d{9}/.test(digits);
}

function sessionFor(userId, session) {
  if (!session || !Array.isArray(session.participants) || !session.participants.includes(userId)) throw httpError(403, 'This call does not belong to your account.');
}

function partnerId(userId, session) {
  return session.participants.find(uid => uid !== userId);
}

async function activeSession(db, user) {
  const profile = await ownProfile(db, user);
  const explicitlyBlocked = ['rejected', 'suspended'].includes(profile.data.status) || profile.data.moderationStatus === 'suspended';
  if (!explicitlyBlocked && (profile.data.status !== 'approved' || profile.data.countryStatus !== 'approved')) {
    await profile.ref.update({ status: 'approved', countryStatus: 'approved', approvalMethod: 'automatic', approvedAt: profile.data.approvedAt || admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    profile.data = { ...profile.data, status: 'approved', countryStatus: 'approved', approvalMethod: 'automatic' };
  }
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
    const startedMs = timestampMs(session.startedAt);
    const durationSeconds = startedMs ? Math.max(0, Math.min(SESSION_MS / 1000, Math.floor((now() - startedMs) / 1000))) : 0;
    const callCompleted = session.status === 'active' && reason !== 'blocked' && durationSeconds >= 60;
    const participants = Array.isArray(session.participants) ? session.participants : [];
    const profileRefs = participants.map(uid => db.collection(COLLECTIONS.profiles).doc(uid));
    const profileSnaps = await Promise.all(profileRefs.map(ref => tx.get(ref)));
    const endedAt = admin.firestore.Timestamp.now();
    tx.update(sessionRef, {
      status: finalStatus,
      endedAt,
      durationSeconds,
      callCompleted,
      endReason: reason,
      endedBy: actor?.uid || null
    });
    for (let index = 0; index < participants.length; index++) {
      const uid = participants[index];
      const updates = { activeSessionId: admin.firestore.FieldValue.delete(), lastSessionId: finalStatus === 'declined' ? admin.firestore.FieldValue.delete() : sessionRef.id, availability: 'offline', updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (callCompleted) {
        updates.completedCallCount = admin.firestore.FieldValue.increment(1);
        updates.speakingSeconds = admin.firestore.FieldValue.increment(durationSeconds);
        const existingHistory = profileSnaps[index].data()?.recentCalls || [];
        const peerProfile = profileSnaps[1 - index]?.data() || {};
        updates.recentCalls = [...existingHistory, { sessionId: sessionRef.id, partnerUid: participants[1 - index], partnerAlias: clean(peerProfile.alias, 32), completedAt: endedAt, durationSeconds }].slice(-20);
      }
      tx.update(profileRefs[index], updates);
    }
  });
}

function matchingScore(one, two) {
  // Level must be within one step. Shared interests are NOT required (they only raise the score),
  // otherwise two learners with different topics could wait forever.
  if (Math.abs(LEVELS.indexOf(one.level) - LEVELS.indexOf(two.level)) > 1) return -1;
  const shared = (one.interests || []).filter(topic => (two.interests || []).includes(topic));
  let score = shared.length * 10;
  if (one.preferredLanguage === two.preferredLanguage) score += 3;
  if (one.locationPreference === 'Same city preferred' && String(one.city).toLowerCase() === String(two.city).toLowerCase()) score += 4;
  else if (one.locationPreference !== 'Anywhere in India' && String(one.state).toLowerCase() === String(two.state).toLowerCase()) score += 2;
  return score;
}

function eligiblePeer(data) {
  return data && data.status === 'approved' && data.countryStatus === 'approved' && data.moderationStatus !== 'suspended'
    && data.availableForRequests !== false && !data.activeSessionId;
}

// Finds a partner for a learner who pressed "Find a partner".
// 1) Learners who are also searching come first. 2) Otherwise any approved learner who is online right now
//    (page open, heartbeat within 5 minutes, not set offline) gets an invitation with this learner's profile.
async function findMatch(db, user) {
  const own = await ownProfile(db, user);
  requireEligible(own.data);
  const candidates = [];
  const seen = new Set([user.uid]);

  const waiting = await db.collection(COLLECTIONS.queues).where('status', '==', 'waiting').limit(40).get();
  const queued = waiting.docs.filter(q => q.id !== user.uid && timestampMs(q.data().expiresAt) > now());
  if (queued.length) {
    const profiles = await db.getAll(...queued.map(q => db.collection(COLLECTIONS.profiles).doc(q.id)));
    for (const snap of profiles) {
      if (!snap.exists || !eligiblePeer(snap.data())) continue;
      const score = matchingScore(own.data, snap.data());
      if (score >= 0 && !(await areBlocked(db, user.uid, snap.id))) { candidates.push({ uid: snap.id, score: score + 1000, viaQueue: true }); seen.add(snap.id); }
    }
  }

  const online = await db.collection(COLLECTIONS.profiles).where('availability', '==', 'available').limit(60).get();
  for (const snap of online.docs) {
    if (seen.has(snap.id) || !eligiblePeer(snap.data()) || !isOnline(snap.data())) continue;
    const score = matchingScore(own.data, snap.data());
    if (score >= 0 && !(await areBlocked(db, user.uid, snap.id))) { candidates.push({ uid: snap.id, score, viaQueue: false }); seen.add(snap.id); }
  }

  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates.slice(0, 8)) {
    const result = await db.runTransaction(async tx => {
      const ownRef = db.collection(COLLECTIONS.profiles).doc(user.uid);
      const otherRef = db.collection(COLLECTIONS.profiles).doc(candidate.uid);
      const ownQueueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
      const otherQueueRef = db.collection(COLLECTIONS.queues).doc(candidate.uid);
      const pair = pairId(user.uid, candidate.uid);
      const ownBlockRef = db.collection(COLLECTIONS.blocks).doc(blockId(user.uid, candidate.uid));
      const otherBlockRef = db.collection(COLLECTIONS.blocks).doc(blockId(candidate.uid, user.uid));
      const connectionRef = db.collection(COLLECTIONS.connections).doc(pair);
      const requestRef = db.collection(COLLECTIONS.partnerRequests).doc(pair);
      const [ownSnap, otherSnap, ownQueue, otherQueue, ownBlock, otherBlock, connection, request] = await Promise.all([tx.get(ownRef), tx.get(otherRef), tx.get(ownQueueRef), tx.get(otherQueueRef), tx.get(ownBlockRef), tx.get(otherBlockRef), tx.get(connectionRef), tx.get(requestRef)]);
      if (!ownSnap.exists || !otherSnap.exists || !ownQueue.exists || ownQueue.data().status !== 'waiting') return null;
      if (ownBlock.exists || otherBlock.exists || ownSnap.data().availableForRequests === false || !eligiblePeer(otherSnap.data())) return null;
      if (ownSnap.data().activeSessionId) return null;
      if (candidate.viaQueue) {
        if (!otherQueue.exists || otherQueue.data().status !== 'waiting' || timestampMs(otherQueue.data().expiresAt) <= now()) return null;
      } else if (!isOnline(otherSnap.data())) return null;
      if (matchingScore(ownSnap.data(), otherSnap.data()) < 0) return null;
      const ref = db.collection(COLLECTIONS.sessions).doc();
      const inviteExpiresAt = admin.firestore.Timestamp.fromMillis(now() + INVITE_MS);
      tx.set(ref, { participants: [user.uid, candidate.uid], status: 'invited', acceptedBy: [], createdAt: admin.firestore.FieldValue.serverTimestamp(), inviteExpiresAt, expiresAt: admin.firestore.Timestamp.fromMillis(now() + SESSION_MS), channelId: ref.id, pausedBy: [], callType: 'audio', source: candidate.viaQueue ? 'queue' : 'online-match' });
      tx.delete(ownQueueRef); if (otherQueue.exists) tx.delete(otherQueueRef);
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
  if (waiting && !session) {
    // Retry on every poll: a partner who came online after the search began is found within seconds.
    let matched = null;
    try { matched = await findMatch(db, user); } catch (err) { console.error('match retry failed:', err.message); }
    if (matched) return dashboard(db, user);
  }
  let partner = null;
  let messages = [];
  if (session) {
    const partnerSnap = await db.collection(COLLECTIONS.profiles).doc(partnerId(user.uid, session)).get();
    if (partnerSnap.exists) partner = { ...publicProfile(partnerSnap.data()), level: publicPartner(partnerSnap.data()).level, introduction: publicPartner(partnerSnap.data()).introduction, interests: publicPartner(partnerSnap.data()).interests };
    if (session.status === 'active') {
      const messageSnapshot = await ref.collection('messages').orderBy('createdAt', 'desc').limit(CHAT_LIMIT).get();
      messages = messageSnapshot.docs.reverse().map(doc => {
        const item = doc.data();
        return { id: doc.id, fromMe: item.fromUid === user.uid, text: clean(item.text, 1000), createdAt: iso(item.createdAt) };
      });
    }
  }
  let recentSession = null;
  if (!session && profile.data?.lastSessionId) {
    const last = await db.collection(COLLECTIONS.sessions).doc(profile.data.lastSessionId).get();
    if (last.exists && ['ended', 'blocked', 'expired'].includes(last.data().status) && last.data().participants.includes(user.uid)) recentSession = { id: last.id, status: last.data().status };
  }
  let onlineLearners = 0;
  try { onlineLearners = (await db.collection(COLLECTIONS.queues).where('status', '==', 'waiting').count().get()).data().count; } catch (_) { /* Aggregate is optional in local emulators. */ }
  return { ok: true, profile: profile.data ? { fullName: profile.data.fullName, alias: profile.data.alias, email: profile.data.email, emailVerified: true, age: profile.data.age, city: profile.data.city, state: profile.data.state, level: profile.data.level, interests: profile.data.interests, goals: profile.data.goals, intro: profile.data.intro || '', avatarURL: require('../lib/calling').safeAvatar(profile.data.avatarURL), preferredLanguage: profile.data.preferredLanguage, locationPreference: profile.data.locationPreference, status: profile.data.status || 'pending', availableForRequests: profile.data.availableForRequests !== false, completedCallCount: Number(profile.data.completedCallCount || 0), speakingSeconds: Number(profile.data.speakingSeconds || 0), createdAt: iso(profile.data.createdAt), reviewedAt: iso(profile.data.reviewedAt) } : null, queue: waiting ? { expiresAt: iso(waiting.expiresAt) } : null, session: session ? { id: ref.id, status: session.status, acceptedByMe: (session.acceptedBy || []).includes(user.uid), inviteExpiresAt: iso(session.inviteExpiresAt), expiresAt: iso(session.expiresAt), pausedByMe: (session.pausedBy || []).includes(user.uid), pausedByPartner: (session.pausedBy || []).includes(partnerId(user.uid, session)), partner, messages } : null, recentSession, onlineLearners };
}

exports.handler = async event => {
  try {
    const db = store();
    const user = await authenticatedUser(event);
    requireCommunityLearner(user);
    if (event.httpMethod === 'GET') return reply(200, await dashboard(db, user));
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');
    const action = clean(body.action, 40);
    if (action === 'register-profile' || action === 'update-profile') {
      const input = profileInput(body.profile || {});
      const own = await ownProfile(db, user, false);
      const isNew = !own.exists;
      const existingStatus = own.data?.status || 'new';
      const status = existingStatus === 'suspended' || existingStatus === 'rejected' ? existingStatus : 'approved';
      const verifiedAvatarURL = safeAvatar(user.claims.picture);
      const avatarURL = input.avatarURL || (!own.data?.avatarURL ? verifiedAvatarURL : null);
      await own.ref.set({ ...input, uid: user.uid, email: user.email, emailVerified: true, countryCode: 'IN', countryStatus: status === 'approved' ? 'approved' : 'pending', adultConfirmed: true, status, moderationStatus: status === 'suspended' ? 'suspended' : 'active', availability: own.data?.availability || 'offline', availableForRequests: own.data?.availableForRequests !== false, ...(avatarURL ? { avatarURL } : {}), ...(status === 'approved' ? { approvalMethod: 'automatic', approvedAt: own.data?.approvedAt || admin.firestore.FieldValue.serverTimestamp() } : {}), updatedAt: admin.firestore.FieldValue.serverTimestamp(), ...(isNew ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}) }, { merge: true });
      await audit(db, user, isNew ? 'profile_created' : 'profile_updated', user.uid);
      return reply(200, { ok: true, message: status === 'approved' ? 'Profile saved. Your community access is active.' : status === 'suspended' ? 'Profile saved, but community access is suspended. Contact Englishmates for help.' : 'Profile saved, but community access remains blocked. Contact Englishmates for help.' });
    }
    const own = await ownProfile(db, user);
    if (action === 'join-queue') {
      requireEligible(own.data); await consumeLimit(db, user.uid, 'queue', 8, 60 * 60 * 1000);
      const queueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
      let alreadyInvited = false;
      await db.runTransaction(async tx => {
        const [profileSnap, queueSnap] = await Promise.all([tx.get(own.ref), tx.get(queueRef)]);
        if (!profileSnap.exists) throw httpError(404, 'Complete your speaking profile first.');
        const profileData = profileSnap.data();
        requireEligible(profileData);
        if (profileData.activeSessionId) { alreadyInvited = true; return; } // someone just matched with you: show that invitation instead of an error
        if (profileData.availableForRequests === false) throw httpError(409, 'Go online before searching for a partner.');
        if (queueSnap.exists && timestampMs(queueSnap.data().expiresAt) > now()) return;
        tx.set(queueRef, { uid: user.uid, status: 'waiting', createdAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromMillis(now() + QUEUE_MS) });
        tx.update(own.ref, { availability: 'waiting', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      if (alreadyInvited) return reply(200, { ok: true, message: 'You already have a practice invitation. Review it below.' });
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
    if (action === 'pause-call') {
      if (session.status !== 'active') throw httpError(409, 'Join an active call before pausing it.');
      const pause = body.paused === true;
      const currentPaused = (session.pausedBy || []).includes(user.uid);
      if (pause !== currentPaused) {
        await current.ref.update({
          pausedBy: pause ? admin.firestore.FieldValue.arrayUnion(user.uid) : admin.firestore.FieldValue.arrayRemove(user.uid),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      return reply(200, { ok: true, message: pause ? 'Call audio paused.' : 'Call audio resumed.' });
    }
    if (action === 'send-message') {
      if (session.status !== 'active') throw httpError(409, 'Messages are available after both learners accept the call.');
      const text = clean(body.message, 1000);
      if (!text) throw httpError(400, 'Write a message first.');
      if (containsContactDetails(text)) throw httpError(400, 'Keep your contact details private. Email addresses and phone numbers cannot be sent here.');
      await consumeLimit(db, user.uid, 'call_message', 30, 60 * 1000);
      const messageRef = current.ref.collection('messages').doc();
      await db.runTransaction(async tx => {
        const snap = await tx.get(current.ref);
        if (!snap.exists || snap.data().status !== 'active') throw httpError(409, 'This call has ended.');
        tx.create(messageRef, { fromUid: user.uid, text, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return reply(200, { ok: true, message: 'Message sent.' });
    }
    if (action === 'accept-call') {
      if (!['invited', 'accepted'].includes(session.status) || timestampMs(session.inviteExpiresAt) <= now()) { await closeSession(db, current.ref, 'expired'); throw httpError(410, 'This invitation has expired.'); }
      await db.runTransaction(async tx => {
        const snap = await tx.get(current.ref); if (!snap.exists || !['invited', 'accepted'].includes(snap.data().status)) throw httpError(409, 'This invitation is no longer available.');
        const acceptedBy = [...new Set([...(snap.data().acceptedBy || []), user.uid])];
        const active = acceptedBy.length === 2;
        tx.update(current.ref, { acceptedBy, status: active ? 'active' : 'accepted', acceptedAt: admin.firestore.FieldValue.serverTimestamp(), ...(active ? { startedAt: admin.firestore.FieldValue.serverTimestamp() } : {}) });
        if (active) for (const uid of snap.data().participants) tx.update(db.collection(COLLECTIONS.profiles).doc(uid), { availability: 'in_call', totalCallCount: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
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
