const {
  admin, COLLECTIONS, authenticatedUser, blockId, clean, consumeLimit,
  httpError, iso, ownProfile, reply, requireEligible, store, audit
} = require('../lib/calling');
const { LEVELS, TOPICS, hasContactDetails, isOnline, matchingScore, pairId, publicPartner, timestampMs } = require('../lib/partner-community');
const cors = require('../lib/cors');

const REQUEST_MS = 14 * 24 * 60 * 60 * 1000;
const INVITE_MS = 90 * 1000;
const SESSION_MS = 15 * 60 * 1000;

function assertApproved(profile) {
  if (!profile || profile.status !== 'approved' || profile.countryStatus !== 'approved' || profile.countryCode !== 'IN' || profile.adultConfirmed !== true || profile.moderationStatus !== 'active') {
    throw httpError(403, 'Both learner profiles must be approved and active.');
  }
}
function requestResult(snapshot, uid, profiles) {
  const request = snapshot.data();
  const peerUid = request.fromUid === uid ? request.toUid : request.fromUid;
  const peer = profiles.get(peerUid);
  const expired = timestampMs(request.expiresAt) > 0 && timestampMs(request.expiresAt) <= Date.now();
  return {
    id: snapshot.id, status: expired && request.status === 'pending' ? 'expired' : request.status, fromMe: request.fromUid === uid,
    createdAt: iso(request.createdAt), expiresAt: iso(request.expiresAt),
    partner: peer ? publicPartner(peer) : { alias: 'English learner', avatarURL: null }
  };
}
async function peerProfiles(db, uidList) {
  const unique = [...new Set(uidList.filter(Boolean))];
  const snapshots = await Promise.all(unique.map(uid => db.collection(COLLECTIONS.profiles).doc(uid).get()));
  return new Map(snapshots.filter(s => s.exists).map(s => [s.id, s.data()]));
}
async function blockedUids(db, uid) {
  const [outgoing, incoming] = await Promise.all([
    db.collection(COLLECTIONS.blocks).where('blockerUid', '==', uid).limit(300).get(),
    db.collection(COLLECTIONS.blocks).where('blockedUid', '==', uid).limit(300).get()
  ]);
  return new Set([...outgoing.docs.map(doc => doc.data().blockedUid), ...incoming.docs.map(doc => doc.data().blockerUid)]);
}
async function loadHub(db, user, profile) {
  const [outgoing, incoming, connections] = await Promise.all([
    db.collection(COLLECTIONS.partnerRequests).where('fromUid', '==', user.uid).limit(100).get(),
    db.collection(COLLECTIONS.partnerRequests).where('toUid', '==', user.uid).limit(100).get(),
    db.collection(COLLECTIONS.connections).where('participants', 'array-contains', user.uid).limit(100).get()
  ]);
  const requests = [...new Map([...outgoing.docs, ...incoming.docs].map(doc => [doc.id, doc])).values()];
  const stale = requests.filter(doc => doc.data().status === 'pending' && timestampMs(doc.data().expiresAt) > 0 && timestampMs(doc.data().expiresAt) <= Date.now());
  if (stale.length) {
    const batch = db.batch();
    stale.forEach(doc => batch.update(doc.ref, { status: 'expired', updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
    await batch.commit();
  }
  const visibleRequests = requests.filter(doc => ['pending', 'accepted', 'rejected', 'cancelled', 'expired'].includes(doc.data().status));
  const connectionDocs = connections.docs.filter(doc => doc.data().status === 'active');
  const recentCalls = Array.isArray(profile.recentCalls) ? profile.recentCalls.slice(-20) : [];
  const peerIds = [
    ...visibleRequests.map(doc => doc.data().fromUid === user.uid ? doc.data().toUid : doc.data().fromUid),
    ...connectionDocs.flatMap(doc => doc.data().participants.filter(uid => uid !== user.uid)),
    ...recentCalls.map(item => item.partnerUid)
  ];
  const [profiles, blocked] = await Promise.all([peerProfiles(db, peerIds), blockedUids(db, user.uid)]);
  const requestItems = visibleRequests
    .filter(doc => !blocked.has(doc.data().fromUid === user.uid ? doc.data().toUid : doc.data().fromUid))
    .map(doc => requestResult(doc, user.uid, profiles))
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
  const connectionItems = connectionDocs.filter(doc => !blocked.has(doc.data().participants.find(uid => uid !== user.uid)))
    .map(doc => {
      const peerUid = doc.data().participants.find(uid => uid !== user.uid);
      return { id: doc.id, peerId: peerUid, connectedAt: iso(doc.data().connectedAt), partner: publicPartner(profiles.get(peerUid) || {}) };
    });
  const history = recentCalls.slice().sort((a, b) => timestampMs(b.completedAt) - timestampMs(a.completedAt)).map(item => {
    const partner = publicPartner(profiles.get(item.partnerUid) || {});
    return { id: item.sessionId, completedAt: iso(item.completedAt), durationSeconds: Number(item.durationSeconds || 0), partner: { ...partner, alias: clean(item.partnerAlias, 32) || partner.alias } };
  });
  const seconds = Number(profile.speakingSeconds || 0);
  const count = Number(profile.completedCallCount || 0);
  return {
    ok: true,
    availability: profile.availableForRequests !== false,
    stats: { totalCalls: Number(profile.totalCallCount || 0), completedCalls: count, speakingSeconds: seconds, averageSeconds: count ? Math.round(seconds / count) : 0 },
    incoming: requestItems.filter(item => !item.fromMe && item.status === 'pending'),
    outgoing: requestItems.filter(item => item.fromMe && item.status === 'pending'),
    updates: requestItems.filter(item => item.status !== 'pending').slice(0, 20),
    connections: connectionItems,
    history
  };
}
async function loadDirectory(db, user, profile, params) {
  const queryText = clean(params.get('q'), 60).toLowerCase();
  const level = clean(params.get('level'), 40);
  const topic = clean(params.get('topic'), 60);
  const onlineOnly = params.get('online') === '1';
  if (level && !LEVELS.includes(level)) throw httpError(400, 'Choose a valid proficiency level.');
  if (topic && !TOPICS.includes(topic)) throw httpError(400, 'Choose a valid speaking interest.');
  const pageSize = params.get('random') === '1' ? 200 : 30;
  let query = db.collection(COLLECTIONS.profiles).where('status', '==', 'approved').limit(pageSize);
  const cursor = clean(params.get('cursor'), 160);
  if (cursor && !/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) throw httpError(400, 'Choose a valid page cursor.');
  if (cursor) {
    const cursorDoc = await db.collection(COLLECTIONS.profiles).doc(cursor).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }
  const [snapshot, blocked, outgoing, incoming, connections] = await Promise.all([
    query.get(), blockedUids(db, user.uid),
    db.collection(COLLECTIONS.partnerRequests).where('fromUid', '==', user.uid).limit(100).get(),
    db.collection(COLLECTIONS.partnerRequests).where('toUid', '==', user.uid).limit(100).get(),
    db.collection(COLLECTIONS.connections).where('participants', 'array-contains', user.uid).limit(100).get()
  ]);
  const excluded = new Set(blocked);
  for (const request of [...outgoing.docs, ...incoming.docs]) {
    const value = request.data();
    if (value.status === 'pending' && timestampMs(value.expiresAt) > Date.now()) excluded.add(value.fromUid === user.uid ? value.toUid : value.fromUid);
  }
  for (const connection of connections.docs) if (connection.data().status === 'active') excluded.add(connection.data().participants.find(uid => uid !== user.uid));
  const candidates = [];
  for (const doc of snapshot.docs) {
    if (doc.id === user.uid || excluded.has(doc.id)) continue;
    const value = doc.data();
    if (value.countryCode !== 'IN' || value.countryStatus !== 'approved' || value.adultConfirmed !== true || value.moderationStatus !== 'active' || value.activeSessionId) continue;
    const partner = publicPartner(value);
    if (level && partner.level !== level) continue;
    if (topic && !partner.interests.includes(topic)) continue;
    if (onlineOnly && !partner.online) continue;
    if (queryText && !(partner.alias + ' ' + partner.introduction + ' ' + partner.interests.join(' ')).toLowerCase().includes(queryText)) continue;
    candidates.push({ uid: doc.id, ...partner });
  }
  if (params.get('random') === '1') {
    const matches = candidates.filter(candidate => {
      const value = snapshot.docs.find(doc => doc.id === candidate.uid)?.data();
      return isOnline(value) && matchingScore(profile, value) >= 0;
    });
    return { ok: true, partner: matches.length ? matches[Math.floor(Math.random() * matches.length)] : null, nextCursor: null };
  }
  candidates.sort((a, b) => Number(b.online) - Number(a.online) || a.alias.localeCompare(b.alias));
  return { ok: true, partners: candidates, nextCursor: snapshot.docs.length === pageSize ? snapshot.docs[snapshot.docs.length - 1].id : null };
}
async function handlePost(db, user, body) {
  const action = clean(body.action, 40);
  const own = await ownProfile(db, user);
  requireEligible(own.data);
  if (action === 'heartbeat') {
    await consumeLimit(db, user.uid, 'partner_presence', 4, 60 * 1000);
    const patch = { lastSeenAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (!own.data.activeSessionId && !['waiting', 'invited', 'in_call'].includes(own.data.availability) && own.data.availableForRequests !== false) patch.availability = 'available';
    await own.ref.update(patch);
    return { ok: true };
  }
  if (action === 'set-availability') {
    const available = body.available === true;
    if (own.data.activeSessionId && available) throw httpError(409, 'Availability cannot change during a call.');
    const queueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
    if (!available) await queueRef.delete().catch(() => {});
    await own.ref.update({ availableForRequests: available, availability: available && !own.data.activeSessionId ? 'available' : 'offline', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true, message: available ? 'You are available for speaking requests.' : 'You are offline for new calls.' };
  }
  if (action === 'send-request') {
    const peerUid = clean(body.peerUid, 160);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(peerUid) || peerUid === user.uid) throw httpError(400, 'Choose another learner.');
    const peerRef = db.collection(COLLECTIONS.profiles).doc(peerUid);
    const requestRef = db.collection(COLLECTIONS.partnerRequests).doc(pairId(user.uid, peerUid));
    const connectionRef = db.collection(COLLECTIONS.connections).doc(pairId(user.uid, peerUid));
    const outgoingBlockRef = db.collection(COLLECTIONS.blocks).doc(blockId(user.uid, peerUid));
    const incomingBlockRef = db.collection(COLLECTIONS.blocks).doc(blockId(peerUid, user.uid));
    await consumeLimit(db, user.uid, 'partner_request', 12, 24 * 60 * 60 * 1000);
    await db.runTransaction(async tx => {
      const ownRef = db.collection(COLLECTIONS.profiles).doc(user.uid);
      const [ownSnap, peer, request, connection, outgoingBlock, incomingBlock] = await Promise.all([
        tx.get(ownRef), tx.get(peerRef), tx.get(requestRef), tx.get(connectionRef), tx.get(outgoingBlockRef), tx.get(incomingBlockRef)
      ]);
      if (!ownSnap.exists) throw httpError(403, 'Your profile is unavailable.');
      assertApproved(ownSnap.data());
      if (!peer.exists) throw httpError(404, 'Learner profile not found.');
      assertApproved(peer.data());
      if (ownSnap.data().activeSessionId || peer.data().activeSessionId) throw httpError(409, 'You cannot send a request during an active call.');
      if (outgoingBlock.exists || incomingBlock.exists) throw httpError(403, 'This learner is unavailable for connection requests.');
      if (connection.exists && connection.data().status === 'active') throw httpError(409, 'You are already connected.');
      if (request.exists && request.data().status === 'pending' && timestampMs(request.data().expiresAt) > Date.now()) throw httpError(409, 'A request is already waiting between you.');
      tx.set(requestRef, { participants: [user.uid, peerUid].sort(), fromUid: user.uid, toUid: peerUid, status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + REQUEST_MS) });
    });
    return { ok: true, message: 'Speaking request sent.' };
  }
  if (['accept-request', 'reject-request', 'cancel-request'].includes(action)) {
    const requestId = clean(body.requestId, 160);
    if (!/^[a-f0-9]{64}$/.test(requestId)) throw httpError(400, 'Choose a valid speaking request.');
    const requestRef = db.collection(COLLECTIONS.partnerRequests).doc(requestId);
    const connectionRef = db.collection(COLLECTIONS.connections).doc(requestId);
    await db.runTransaction(async tx => {
      const request = await tx.get(requestRef);
      if (!request.exists) throw httpError(404, 'Speaking request not found.');
      const data = request.data();
      if (!(data.participants || []).includes(user.uid)) throw httpError(403, 'This request is not for your account.');
      if (data.status !== 'pending' || timestampMs(data.expiresAt) <= Date.now()) throw httpError(409, 'This request has expired or was already handled.');
      if (action === 'accept-request') {
        if (data.toUid !== user.uid) throw httpError(403, 'Only the invited learner can accept this request.');
        const peerUid = data.fromUid;
        const peerRef = db.collection(COLLECTIONS.profiles).doc(peerUid);
        const ownRef = db.collection(COLLECTIONS.profiles).doc(user.uid);
        const outBlock = db.collection(COLLECTIONS.blocks).doc(blockId(user.uid, peerUid));
        const inBlock = db.collection(COLLECTIONS.blocks).doc(blockId(peerUid, user.uid));
        const [peer, ownSnap, connection, blockOne, blockTwo] = await Promise.all([tx.get(peerRef), tx.get(ownRef), tx.get(connectionRef), tx.get(outBlock), tx.get(inBlock)]);
        if (!peer.exists || !ownSnap.exists || blockOne.exists || blockTwo.exists) throw httpError(403, 'This learner is unavailable.');
        assertApproved(peer.data()); assertApproved(ownSnap.data());
        if (connection.exists && connection.data().status === 'active') throw httpError(409, 'You are already connected.');
        tx.update(requestRef, { status: 'accepted', updatedAt: admin.firestore.FieldValue.serverTimestamp(), respondedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.set(connectionRef, { participants: data.participants, status: 'active', connectedAt: admin.firestore.FieldValue.serverTimestamp(), sourceRequestId: requestId });
      } else {
        if (action === 'reject-request' && data.toUid !== user.uid) throw httpError(403, 'Only the invited learner can reject this request.');
        if (action === 'cancel-request' && data.fromUid !== user.uid) throw httpError(403, 'Only the sender can cancel this request.');
        tx.update(requestRef, { status: action === 'reject-request' ? 'rejected' : 'cancelled', updatedAt: admin.firestore.FieldValue.serverTimestamp(), respondedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    });
    return { ok: true, message: action === 'accept-request' ? 'You are connected. You can now invite this learner to an audio call.' : action === 'reject-request' ? 'Speaking request declined.' : 'Speaking request cancelled.' };
  }
  if (action === 'start-partner-call') {
    const connectionId = clean(body.connectionId, 160);
    if (!/^[a-f0-9]{64}$/.test(connectionId)) throw httpError(400, 'Choose a valid connection.');
    await consumeLimit(db, user.uid, 'partner_call', 10, 60 * 60 * 1000);
    const connectionRef = db.collection(COLLECTIONS.connections).doc(connectionId);
    const sessionRef = db.collection(COLLECTIONS.sessions).doc();
    const queueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
    await db.runTransaction(async tx => {
      const connection = await tx.get(connectionRef);
      if (!connection.exists || connection.data().status !== 'active' || !(connection.data().participants || []).includes(user.uid)) throw httpError(403, 'Connect with this learner before starting a call.');
      const peerUid = connection.data().participants.find(uid => uid !== user.uid);
      const peerRef = db.collection(COLLECTIONS.profiles).doc(peerUid);
      const ownRef = db.collection(COLLECTIONS.profiles).doc(user.uid);
      const peerQueueRef = db.collection(COLLECTIONS.queues).doc(peerUid);
      const [ownSnap, peer, ownQueue, peerQueue, outBlock, inBlock] = await Promise.all([
        tx.get(ownRef), tx.get(peerRef), tx.get(queueRef), tx.get(peerQueueRef),
        tx.get(db.collection(COLLECTIONS.blocks).doc(blockId(user.uid, peerUid))),
        tx.get(db.collection(COLLECTIONS.blocks).doc(blockId(peerUid, user.uid)))
      ]);
      if (!peer.exists || !ownSnap.exists || outBlock.exists || inBlock.exists) throw httpError(403, 'This learner is unavailable.');
      assertApproved(ownSnap.data()); assertApproved(peer.data());
      if (ownSnap.data().activeSessionId || peer.data().activeSessionId || ownQueue.exists || peerQueue.exists) throw httpError(409, 'One of you is already in a call or matching queue.');
      if (!isOnline(peer.data()) || !isOnline(ownSnap.data())) throw httpError(409, 'Both learners must be online and available before calling.');
      tx.set(sessionRef, { participants: [user.uid, peerUid], status: 'invited', acceptedBy: [], createdAt: admin.firestore.FieldValue.serverTimestamp(), inviteExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + INVITE_MS), expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + SESSION_MS), channelId: sessionRef.id, pausedBy: [], callType: 'audio', source: 'connection' });
      tx.update(ownRef, { activeSessionId: sessionRef.id, availability: 'invited', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.update(peerRef, { activeSessionId: sessionRef.id, availability: 'invited', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    return { ok: true, message: 'Audio call invitation sent. Your partner must accept before microphone access starts.' };
  }
  if (action === 'block-partner') {
    const peerUid = clean(body.peerUid, 160);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(peerUid) || peerUid === user.uid) throw httpError(400, 'Choose another learner to block.');
    const peer = await db.collection(COLLECTIONS.profiles).doc(peerUid).get();
    if (!peer.exists || peer.data().status !== 'approved') throw httpError(404, 'Learner profile not found.');
    await db.collection(COLLECTIONS.blocks).doc(blockId(user.uid, peerUid)).set({ blockerUid: user.uid, blockedUid: peerUid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    const pair = pairId(user.uid, peerUid);
    await db.collection(COLLECTIONS.connections).doc(pair).set({ participants: [user.uid, peerUid].sort(), status: 'blocked', blockedBy: user.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const requestRef = db.collection(COLLECTIONS.partnerRequests).doc(pair);
    const request = await requestRef.get();
    if (request.exists && request.data().status === 'pending') await requestRef.update({ status: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await audit(db, user, 'partner_blocked', peerUid);
    return { ok: true, message: 'This learner was blocked.' };
  }
  if (action === 'report-partner') {
    const peerUid = clean(body.peerUid, 160);
    const reason = clean(body.reason, 120);
    const details = clean(body.details, 1000);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(peerUid) || peerUid === user.uid || reason.length < 3 || hasContactDetails(details)) throw httpError(400, 'Choose a learner and report reason without contact details.');
    await consumeLimit(db, user.uid, 'partner_report', 5, 24 * 60 * 60 * 1000);
    const pairRef = db.collection(COLLECTIONS.connections).doc(pairId(user.uid, peerUid));
    const connected = await pairRef.get();
    if (!connected.exists || !['active', 'blocked'].includes(connected.data().status)) throw httpError(403, 'You can report a learner after a connection or call.');
    await db.collection(COLLECTIONS.reports).add({ reporterUid: user.uid, reportedUid: peerUid, sessionId: own.data.activeSessionId || null, reason, details, status: 'open', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await audit(db, user, 'partner_reported', peerUid);
    return { ok: true, message: 'Your report was sent for administrator review.' };
  }
  if (action === 'record-call-failure') {
    const sessionId = clean(body.sessionId, 160);
    const category = clean(body.category, 50);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !['microphone-permission', 'audio-network', 'audio-service', 'token'].includes(category)) throw httpError(400, 'Choose a valid call issue.');
    const session = await db.collection(COLLECTIONS.sessions).doc(sessionId).get();
    if (!session.exists || session.data().status !== 'active' || !(session.data().participants || []).includes(user.uid)) throw httpError(403, 'This call issue cannot be recorded.');
    await consumeLimit(db, user.uid, 'call_failure', 10, 60 * 60 * 1000);
    await db.collection(COLLECTIONS.failures).add({ uid: user.uid, sessionId, category, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true };
  }
  throw httpError(400, 'Unknown partner action.');
}
exports.handler = async event => {
  try {
    if (event.httpMethod === 'OPTIONS') return cors.options(event);
    const db = store();
    const user = await authenticatedUser(event);
    if (event.httpMethod === 'GET') {
      const own = await ownProfile(db, user);
      requireEligible(own.data);
      const params = new URLSearchParams(event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString());
      const view = clean(params.get('view'), 20);
      return reply(200, view === 'directory' ? await loadDirectory(db, user, own.data, params) : await loadHub(db, user, own.data));
    }
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');
    return reply(200, await handlePost(db, user, body));
  } catch (error) {
    console.error('Calling partners:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Request failed.' });
  }
};