const crypto = require('crypto');
const {
  admin, COLLECTIONS, areBlocked, audit, authenticatedUser, blockId, clean, consumeLimit,
  containsContactDetails, httpError, requireAdmin, requireCommunityLearner,
  requireEligible, ownProfile, reply, store
} = require('../lib/calling');
const cors = require('../lib/cors');

const TOPICS = ['Daily conversation', 'Travel stories', 'Job interviews', 'Public speaking', 'Debate club', 'Everyday English', 'Study and careers', 'Custom topic'];
const LEVELS = ['Beginner', 'Elementary', 'Intermediate', 'Upper Intermediate', 'Advanced', 'All levels'];
const DURATIONS = [15, 30, 45];
const CAPACITIES = [3, 4, 5, 6, 8];
const STALE_MEMBER_MS = 45000;
const STALE_HOST_MS = 90000;

function now() { return Date.now(); }
function stampMs(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
function uidFor(members) {
  const used = new Set((members || []).map(item => Number(item.rtcUid)));
  let value;
  do { value = crypto.randomInt(10000, 2000000000); } while (used.has(value));
  return value;
}
function memberFor(profile, uid, role, rtcUid) {
  return { uid, alias: clean(profile.alias, 32) || 'English learner', level: LEVELS.includes(profile.level) ? profile.level : 'Beginner', role, rtcUid, joinedAt: admin.firestore.Timestamp.now(), lastSeenAt: admin.firestore.Timestamp.now() };
}
function publicRoom(id, room, viewerUid) {
  const members = Array.isArray(room.members) ? room.members : [];
  const host = members.find(member => member.uid === room.hostUid);
  return {
    id, title: room.title, topic: room.topic, prompt: room.prompt || '',
    level: room.level, durationMinutes: room.durationMinutes, expiresAt: stampMs(room.expiresAt) ? new Date(stampMs(room.expiresAt)).toISOString() : null,
    status: room.status, capacity: room.capacity, memberCount: members.length,
    hostAlias: host?.alias || room.hostAlias || 'Room host',
    members: members.map(member => ({ alias: member.alias || 'English learner', level: member.level || 'Beginner', role: member.role === 'host' ? 'Host' : 'Learner', isYou: member.uid === viewerUid })),
    isMember: members.some(member => member.uid === viewerUid),
    seatsLeft: Math.max(0, Number(room.capacity || 0) - members.length)
  };
}
function inputRoom(body) {
  const topic = clean(body.topic, 80);
  const title = clean(body.title, 80);
  const prompt = clean(body.prompt, 280);
  const level = clean(body.level, 40);
  const durationMinutes = Number(body.durationMinutes);
  const capacity = Number(body.capacity);
  if (!TOPICS.includes(topic)) throw httpError(400, 'Choose a listed conversation topic.');
  if (title.length < 3 || containsContactDetails(title)) throw httpError(400, 'Add a room title without phone numbers or email addresses.');
  if (prompt && containsContactDetails(prompt)) throw httpError(400, 'Keep contact details out of the room prompt.');
  if (!LEVELS.includes(level)) throw httpError(400, 'Choose a valid speaking level.');
  if (!DURATIONS.includes(durationMinutes)) throw httpError(400, 'Choose a 15, 30, or 45 minute room.');
  if (!CAPACITIES.includes(capacity)) throw httpError(400, 'Choose a room size between 3 and 8 people.');
  return { topic, title, prompt, level, durationMinutes, capacity };
}

async function finishRoom(db, roomRef, reason, actorUid, adminActor) {
  let ended = false;
  await db.runTransaction(async tx => {
    const snap = await tx.get(roomRef);
    if (!snap.exists || snap.data().status !== 'live') return;
    const room = snap.data();
    if (!adminActor && room.hostUid !== actorUid) throw httpError(403, 'Only the host can end this room.');
    const members = Array.isArray(room.members) ? room.members : [];
    const refs = members.map(member => db.collection(COLLECTIONS.profiles).doc(member.uid));
    const profiles = await Promise.all(refs.map(ref => tx.get(ref)));
    const endedAt = admin.firestore.Timestamp.now();
    tx.update(roomRef, { status: 'ended', endReason: reason, endedAt, endedBy: actorUid || null, members: [], memberCount: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    members.forEach((member, index) => {
      if (profiles[index].exists && profiles[index].data().activeRoomId === roomRef.id) {
        const data = profiles[index].data();
        const restoreAvailable = data.availableForRequestsBeforeRoom === true;
        const restoreAvailability = data.availabilityBeforeRoom === 'available' ? 'available' : 'offline';
        tx.update(refs[index], {
          activeRoomId: admin.firestore.FieldValue.delete(),
          availableForRequests: restoreAvailable,
          availability: restoreAvailable ? restoreAvailability : 'offline',
          availableForRequestsBeforeRoom: admin.firestore.FieldValue.delete(),
          availabilityBeforeRoom: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
    ended = true;
  });
  if (ended && adminActor) await audit(db, adminActor, 'topic_room_ended_by_admin', roomRef.id, { reason });
  return ended;
}

async function cleanupRoom(db, roomRef) {
  await db.runTransaction(async tx => {
    const snap = await tx.get(roomRef);
    if (!snap.exists || snap.data().status !== 'live') return;
    const room = snap.data();
    const members = Array.isArray(room.members) ? room.members : [];
    const refs = members.map(member => db.collection(COLLECTIONS.profiles).doc(member.uid));
    const profiles = await Promise.all(refs.map(ref => tx.get(ref)));
    const current = now();
    const hostIndex = members.findIndex(member => member.uid === room.hostUid);
    const hostProfile = hostIndex >= 0 ? (profiles[hostIndex].data() || {}) : {};
    const hostStale = hostIndex < 0
      || !profiles[hostIndex].exists
      || hostProfile.status !== 'approved'
      || hostProfile.moderationStatus === 'suspended'
      || current - stampMs(members[hostIndex].lastSeenAt) > STALE_HOST_MS;
    const expired = stampMs(room.expiresAt) <= current;
    const ended = hostStale || expired;
    const keep = members.filter((member, index) => {
      if (ended) return false;
      const profile = profiles[index].data() || {};
      const stale = current - stampMs(member.lastSeenAt) > STALE_MEMBER_MS;
      const ineligible = !profiles[index].exists || profile.status !== 'approved' || profile.moderationStatus === 'suspended';
      return !stale && !ineligible;
    });
    const removed = members.filter(member => !keep.some(item => item.uid === member.uid));
    if (!ended && !removed.length) return;
    if (ended) {
      tx.update(roomRef, { status: 'ended', endReason: expired ? 'time-limit' : 'host-unavailable', endedAt: admin.firestore.Timestamp.now(), endedBy: null, members: [], memberCount: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      tx.update(roomRef, { members: keep, memberCount: keep.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    removed.forEach(member => {
      const index = members.findIndex(item => item.uid === member.uid);
      if (index >= 0 && profiles[index].exists && profiles[index].data().activeRoomId === roomRef.id) {
        const profile = profiles[index].data();
        const restoreAvailable = profile.availableForRequestsBeforeRoom === true;
        const restoreAvailability = profile.availabilityBeforeRoom === 'available' ? 'available' : 'offline';
        tx.update(refs[index], {
          activeRoomId: admin.firestore.FieldValue.delete(),
          availableForRequests: restoreAvailable,
          availability: restoreAvailable ? restoreAvailability : 'offline',
          availableForRequestsBeforeRoom: admin.firestore.FieldValue.delete(),
          availabilityBeforeRoom: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
  });
}

async function roomForMember(db, user, own) {
  const roomId = clean(own.data.activeRoomId, 160);
  if (!roomId) return null;
  const ref = db.collection(COLLECTIONS.rooms).doc(roomId);
  await cleanupRoom(db, ref);
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== 'live' || !(snap.data().members || []).some(item => item.uid === user.uid)) return null;
  return { id: snap.id, data: snap.data() };
}

async function listRooms(db, viewerUid) {
  const snapshot = await db.collection(COLLECTIONS.rooms).where('status', '==', 'live').limit(50).get();
  const rooms = [];
  for (const item of snapshot.docs) {
    const ref = item.ref;
    await cleanupRoom(db, ref);
    const current = await ref.get();
    if (current.exists && current.data().status === 'live') rooms.push(publicRoom(current.id, current.data(), viewerUid));
  }
  return rooms.sort((a, b) => (a.isMember === b.isMember ? b.memberCount - a.memberCount : a.isMember ? -1 : 1));
}

async function adminRooms(db) {
  const snapshot = await db.collection(COLLECTIONS.rooms).where('status', '==', 'live').limit(50).get();
  const rooms = [];
  for (const item of snapshot.docs) {
    await cleanupRoom(db, item.ref);
    const current = await item.ref.get();
    if (current.exists && current.data().status === 'live') rooms.push(publicRoom(current.id, current.data(), null));
  }
  return rooms.sort((a, b) => (stampMs(b.expiresAt) - stampMs(a.expiresAt)));
}

async function clearQueueCheck(db, user, tx) {
  const queueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
  const queue = await tx.get(queueRef);
  if (queue.exists && stampMs(queue.data().expiresAt) > now()) throw httpError(409, 'Leave partner matching before opening or joining a topic room.');
  return queueRef;
}

exports.handler = async event => {
  try {
    const db = store();
    const user = await authenticatedUser(event);
    const adminView = event.queryStringParameters?.admin === '1';
    if (adminView) {
      requireAdmin(user);
      if (event.httpMethod === 'GET') return reply(200, { ok: true, rooms: await adminRooms(db) });
      if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
      const body = JSON.parse(event.body || '{}');
      if (clean(body.action, 40) !== 'admin-end-room') throw httpError(400, 'Unknown administrator room action.');
      const roomId = clean(body.roomId, 160);
      if (!roomId) throw httpError(400, 'Choose a room to end.');
      const ref = db.collection(COLLECTIONS.rooms).doc(roomId);
      const ended = await finishRoom(db, ref, 'admin-ended', user.uid, user);
      if (!ended) throw httpError(409, 'This room has already ended.');
      return reply(200, { ok: true, message: 'Room ended and all participant sessions were released.' });
    }

    requireCommunityLearner(user);
    const own = await ownProfile(db, user);
    requireEligible(own.data);
    if (event.httpMethod === 'GET') {
      const rooms = await listRooms(db, user.uid);
      const current = await roomForMember(db, user, own);
      return reply(200, { ok: true, rooms, myRoom: current ? publicRoom(current.id, current.data, user.uid) : null });
    }
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');
    const action = clean(body.action, 40);

    if (action === 'create-room') {
      const input = inputRoom(body);
      await consumeLimit(db, user.uid, 'topic_room_create', 4, 24 * 60 * 60 * 1000);
      const roomRef = db.collection(COLLECTIONS.rooms).doc();
      const roomId = roomRef.id;
      const profileRef = own.ref;
      const queueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
      await db.runTransaction(async tx => {
        const [profileSnap, queueSnap] = await Promise.all([tx.get(profileRef), tx.get(queueRef)]);
        if (!profileSnap.exists) throw httpError(404, 'Complete your speaking profile first.');
        const profile = profileSnap.data();
        requireEligible(profile);
        if (profile.activeRoomId) throw httpError(409, 'You are already in a topic room. Leave it before creating another.');
        if (profile.activeSessionId) throw httpError(409, 'Finish or decline your one-to-one call before creating a room.');
        if (queueSnap.exists && stampMs(queueSnap.data().expiresAt) > now()) throw httpError(409, 'Leave partner matching before opening a topic room.');
        const members = [memberFor(profile, user.uid, 'host', uidFor([]))];
        const start = admin.firestore.Timestamp.now();
        tx.create(roomRef, {
          title: input.title, topic: input.topic, prompt: input.prompt, level: input.level,
          durationMinutes: input.durationMinutes, capacity: input.capacity, status: 'live',
          hostUid: user.uid, hostAlias: members[0].alias, channelId: crypto.randomBytes(18).toString('hex'),
          members, memberCount: 1, createdAt: start, updatedAt: start,
          expiresAt: admin.firestore.Timestamp.fromMillis(now() + input.durationMinutes * 60 * 1000)
        });
        tx.update(profileRef, {
          activeRoomId: roomId, availableForRequestsBeforeRoom: profile.availableForRequests !== false,
          availabilityBeforeRoom: profile.availability === 'available' ? 'available' : 'offline',
          availableForRequests: false, availability: 'in_room', lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if (queueSnap.exists) tx.delete(queueRef);
      });
      await audit(db, user, 'topic_room_created', roomId, { topic: input.topic, durationMinutes: input.durationMinutes, capacity: input.capacity });
      return reply(201, { ok: true, roomId, message: 'Your room is open. Invite learners to join the topic.' });
    }

    const roomId = clean(body.roomId, 160);
    if (!roomId || roomId.includes('/')) throw httpError(400, 'Choose a valid topic room.');
    const roomRef = db.collection(COLLECTIONS.rooms).doc(roomId);

    if (action === 'join-room') {
      await consumeLimit(db, user.uid, 'topic_room_join', 12, 60 * 60 * 1000);
      await cleanupRoom(db, roomRef);
      const profileRef = own.ref;
      const queueRef = db.collection(COLLECTIONS.queues).doc(user.uid);
      let joined = false;
      await db.runTransaction(async tx => {
        const [roomSnap, profileSnap, queueSnap] = await Promise.all([tx.get(roomRef), tx.get(profileRef), tx.get(queueRef)]);
        if (!roomSnap.exists || roomSnap.data().status !== 'live' || stampMs(roomSnap.data().expiresAt) <= now()) throw httpError(410, 'This topic room has ended.');
        if (!profileSnap.exists) throw httpError(404, 'Complete your speaking profile first.');
        const room = roomSnap.data();
        const profile = profileSnap.data();
        requireEligible(profile);
        if (profile.activeRoomId === roomId && (room.members || []).some(item => item.uid === user.uid)) { joined = true; return; }
        if (profile.activeRoomId) throw httpError(409, 'Leave your current topic room before joining another.');
        if (profile.activeSessionId) throw httpError(409, 'Finish or decline your one-to-one call before joining a room.');
        if (queueSnap.exists && stampMs(queueSnap.data().expiresAt) > now()) throw httpError(409, 'Leave partner matching before joining a topic room.');
        const members = Array.isArray(room.members) ? room.members : [];
        if (members.length >= Number(room.capacity)) throw httpError(409, 'This room is full. Choose another open room.');
        const blockRefs = members.flatMap(member => [
          db.collection(COLLECTIONS.blocks).doc(blockId(user.uid, member.uid)),
          db.collection(COLLECTIONS.blocks).doc(blockId(member.uid, user.uid))
        ]);
        const blocked = await Promise.all(blockRefs.map(ref => tx.get(ref)));
        if (blocked.some(snap => snap.exists)) throw httpError(403, 'You cannot join a room with a learner you have blocked.');
        const next = [...members, memberFor(profile, user.uid, 'learner', uidFor(members))];
        tx.update(roomRef, { members: next, memberCount: next.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.update(profileRef, {
          activeRoomId: roomId, availableForRequestsBeforeRoom: profile.availableForRequests !== false,
          availabilityBeforeRoom: profile.availability === 'available' ? 'available' : 'offline',
          availableForRequests: false, availability: 'in_room', lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if (queueSnap.exists) tx.delete(queueRef);
        joined = true;
      });
      if (joined) await audit(db, user, 'topic_room_joined', roomId);
      return reply(200, { ok: true, message: joined ? 'You joined the room. Connect your microphone when you are ready.' : 'You are already in this room.' });
    }

    if (action === 'heartbeat' || action === 'leave-room' || action === 'end-room' || action === 'remove-member' || action === 'report-room' || action === 'block-member') {
      await cleanupRoom(db, roomRef);
      const snap = await roomRef.get();
      if (!snap.exists || snap.data().status !== 'live') throw httpError(410, 'This topic room has ended.');
      const room = snap.data();
      const member = (room.members || []).find(item => item.uid === user.uid);
      if (!member) throw httpError(403, 'You are not a member of this room.');
      if (action === 'heartbeat') {
        await db.runTransaction(async tx => {
          const [roomSnap, profileSnap] = await Promise.all([tx.get(roomRef), tx.get(own.ref)]);
          if (!roomSnap.exists || roomSnap.data().status !== 'live') throw httpError(410, 'This topic room has ended.');
          const members = roomSnap.data().members || [];
          const index = members.findIndex(item => item.uid === user.uid);
          if (index < 0 || !profileSnap.exists || profileSnap.data().activeRoomId !== roomId) throw httpError(403, 'You are no longer in this room.');
          const next = [...members];
          next[index] = { ...next[index], lastSeenAt: admin.firestore.Timestamp.now() };
          tx.update(roomRef, { members: next, memberCount: next.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(own.ref, { lastSeenAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        });
        return reply(200, { ok: true, message: 'Room presence updated.' });
      }
      if (action === 'end-room') {
        if (room.hostUid !== user.uid) throw httpError(403, 'Only the host can end this room.');
        const ended = await finishRoom(db, roomRef, 'host-ended', user.uid, null);
        if (ended) await audit(db, user, 'topic_room_ended_by_host', roomId);
        return reply(200, { ok: true, message: 'Room ended for everyone.' });
      }
      if (action === 'leave-room') {
        if (room.hostUid === user.uid) {
          const ended = await finishRoom(db, roomRef, 'host-left', user.uid, null);
          if (ended) await audit(db, user, 'topic_room_ended_by_host', roomId);
          return reply(200, { ok: true, message: 'As host, leaving ends the room for everyone.' });
        }
        await db.runTransaction(async tx => {
          const [roomSnap, profileSnap] = await Promise.all([tx.get(roomRef), tx.get(own.ref)]);
          if (!roomSnap.exists || roomSnap.data().status !== 'live') return;
          const members = roomSnap.data().members || [];
          const next = members.filter(item => item.uid !== user.uid);
          if (next.length === members.length) return;
          tx.update(roomRef, { members: next, memberCount: next.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          if (profileSnap.exists && profileSnap.data().activeRoomId === roomId) {
            const profile = profileSnap.data();
            const restoreAvailable = profile.availableForRequestsBeforeRoom === true;
            const restoreAvailability = profile.availabilityBeforeRoom === 'available' ? 'available' : 'offline';
            tx.update(own.ref, {
              activeRoomId: admin.firestore.FieldValue.delete(), availableForRequests: restoreAvailable,
              availability: restoreAvailable ? restoreAvailability : 'offline',
              availableForRequestsBeforeRoom: admin.firestore.FieldValue.delete(), availabilityBeforeRoom: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        });
        await audit(db, user, 'topic_room_left', roomId);
        return reply(200, { ok: true, message: 'You left the room.' });
      }
      if (action === 'remove-member') {
        if (room.hostUid !== user.uid) throw httpError(403, 'Only the host can remove a learner.');
        const targetUid = clean(body.memberUid, 160);
        if (!targetUid || targetUid === user.uid) throw httpError(400, 'Choose another room member.');
        const target = (room.members || []).find(item => item.uid === targetUid);
        if (!target) throw httpError(404, 'That learner is not in this room.');
        const targetRef = db.collection(COLLECTIONS.profiles).doc(targetUid);
        await db.runTransaction(async tx => {
          const [roomSnap, profileSnap] = await Promise.all([tx.get(roomRef), tx.get(targetRef)]);
          if (!roomSnap.exists || roomSnap.data().status !== 'live') throw httpError(410, 'This topic room has ended.');
          const next = (roomSnap.data().members || []).filter(item => item.uid !== targetUid);
          tx.update(roomRef, { members: next, memberCount: next.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          if (profileSnap.exists && profileSnap.data().activeRoomId === roomId) {
            const profile = profileSnap.data();
            const restoreAvailable = profile.availableForRequestsBeforeRoom === true;
            tx.update(targetRef, {
              activeRoomId: admin.firestore.FieldValue.delete(), availableForRequests: restoreAvailable,
              availability: restoreAvailable && profile.availabilityBeforeRoom === 'available' ? 'available' : 'offline',
              availableForRequestsBeforeRoom: admin.firestore.FieldValue.delete(), availabilityBeforeRoom: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        });
        await audit(db, user, 'topic_room_member_removed', targetUid, { roomId });
        return reply(200, { ok: true, message: 'Learner removed from the room.' });
      }
      if (action === 'block-member') {
        const targetUid = clean(body.memberUid, 160);
        if (!targetUid || targetUid === user.uid || !(room.members || []).some(item => item.uid === targetUid)) throw httpError(404, 'Choose a learner who is in this room.');
        await db.collection(COLLECTIONS.blocks).doc(blockId(user.uid, targetUid)).set({ blockerUid: user.uid, blockedUid: targetUid, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'topic-room' });
        if (room.hostUid === user.uid) {
          const targetRef = db.collection(COLLECTIONS.profiles).doc(targetUid);
          await db.runTransaction(async tx => {
            const [freshRoom, targetProfile] = await Promise.all([tx.get(roomRef), tx.get(targetRef)]);
            if (!freshRoom.exists || freshRoom.data().status !== 'live') return;
            const next = (freshRoom.data().members || []).filter(item => item.uid !== targetUid);
            tx.update(roomRef, { members: next, memberCount: next.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            if (targetProfile.exists && targetProfile.data().activeRoomId === roomId) {
              const profile = targetProfile.data(); const restore = profile.availableForRequestsBeforeRoom === true;
              tx.update(targetRef, { activeRoomId: admin.firestore.FieldValue.delete(), availableForRequests: restore, availability: restore && profile.availabilityBeforeRoom === 'available' ? 'available' : 'offline', availableForRequestsBeforeRoom: admin.firestore.FieldValue.delete(), availabilityBeforeRoom: admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }
          });
        } else {
          const currentRoom = await roomRef.get();
          const targetRoomMember = (currentRoom.data()?.members || []).find(item => item.uid === targetUid);
          if (targetRoomMember) {
            const targetRef = db.collection(COLLECTIONS.profiles).doc(targetUid);
            await db.runTransaction(async tx => {
              const [freshRoom, targetProfile] = await Promise.all([tx.get(roomRef), tx.get(targetRef)]);
              if (!freshRoom.exists || freshRoom.data().status !== 'live') return;
              const next = (freshRoom.data().members || []).filter(item => item.uid !== user.uid);
              tx.update(roomRef, { members: next, memberCount: next.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
              if (profileExists(targetProfile)) { /* Target profile is intentionally untouched. */ }
              const ownProfileSnap = await tx.get(own.ref);
              if (ownProfileSnap.exists && ownProfileSnap.data().activeRoomId === roomId) {
                const profile = ownProfileSnap.data(); const restore = profile.availableForRequestsBeforeRoom === true;
                tx.update(own.ref, { activeRoomId: admin.firestore.FieldValue.delete(), availableForRequests: restore, availability: restore && profile.availabilityBeforeRoom === 'available' ? 'available' : 'offline', availableForRequestsBeforeRoom: admin.firestore.FieldValue.delete(), availabilityBeforeRoom: admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
              }
            });
          }
        }
        await audit(db, user, 'topic_room_member_blocked', targetUid, { roomId });
        return reply(200, { ok: true, message: room.hostUid === user.uid ? 'Learner blocked and removed from the room.' : 'Learner blocked; you left the shared room.' });
      }
      if (action === 'report-room') {
        const reason = clean(body.reason, 120);
        const details = clean(body.details, 1000);
        if (reason.length < 3) throw httpError(400, 'Choose or describe a report reason.');
        if (containsContactDetails(details)) throw httpError(400, 'Remove contact details from the report notes.');
        await consumeLimit(db, user.uid, 'topic_room_report', 5, 24 * 60 * 60 * 1000);
        await db.collection(COLLECTIONS.reports).add({
          reporterUid: user.uid, reportedUid: room.hostUid, roomId,
          reason, details, status: 'open', createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await audit(db, user, 'topic_room_reported', room.hostUid, { roomId });
        return reply(200, { ok: true, message: 'Room report sent to the community administrator.' });
      }
    }
    throw httpError(400, 'Unknown room action.');
  } catch (error) {
    console.error('Calling Rooms:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Request failed.' });
  }
};

const handler = exports.handler;
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return cors.options(event);
  const response = await handler(event);
  return { ...response, headers: { ...(response.headers || {}), ...cors.headers(event) } };
};

function profileExists(snapshot) { return snapshot.exists; }
