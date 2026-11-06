const {
  admin, COLLECTIONS, authenticatedUser, audit, clean, iso, reply,
  requireAdmin, store, httpError
} = require('../lib/calling');

const STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

function profileForAdmin(snapshot) {
  const value = snapshot.data();
  return {
    uid: snapshot.id, fullName: value.fullName, alias: value.alias, email: value.email,
    age: value.age, city: value.city, state: value.state, level: value.level,
    interests: value.interests || [], goals: value.goals, preferredLanguage: value.preferredLanguage,
    locationPreference: value.locationPreference, status: value.status || 'pending',
    countryStatus: value.countryStatus || 'pending', createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt), reviewedAt: iso(value.reviewedAt), reviewedBy: value.reviewedBy || null
  };
}

exports.handler = async event => {
  try {
    const db = store();
    const user = await authenticatedUser(event);
    requireAdmin(user);
    if (event.httpMethod === 'GET') {
      const requested = clean(event.queryStringParameters?.status, 20);
      const status = STATUSES.includes(requested) ? requested : null;
      let query = db.collection(COLLECTIONS.profiles).orderBy('createdAt', 'desc').limit(100);
      if (status) query = db.collection(COLLECTIONS.profiles).where('status', '==', status).limit(100);
      const [profiles, reports, sessions, auditSnap] = await Promise.all([
        query.get(),
        db.collection(COLLECTIONS.reports).where('status', '==', 'open').limit(100).get(),
        db.collection(COLLECTIONS.sessions).where('status', 'in', ['invited', 'accepted', 'active']).limit(50).get(),
        db.collection(COLLECTIONS.audit).orderBy('createdAt', 'desc').limit(100).get()
      ]);
      return reply(200, { ok: true,
        profiles: profiles.docs.map(profileForAdmin),
        reports: reports.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt), resolvedAt: iso(doc.data().resolvedAt) })),
        sessions: sessions.docs.map(doc => ({ id: doc.id, status: doc.data().status, participants: doc.data().participants || [], createdAt: iso(doc.data().createdAt), expiresAt: iso(doc.data().expiresAt) })),
        audit: auditSnap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) }))
      });
    }
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');
    const action = clean(body.action, 40);
    if (action === 'set-profile-status') {
      const uid = clean(body.uid, 160); const status = clean(body.status, 20);
      if (!uid || !STATUSES.includes(status)) throw httpError(400, 'Choose a valid learner and status.');
      const ref = db.collection(COLLECTIONS.profiles).doc(uid); const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Learner profile not found.');
      await ref.update({ status, countryStatus: status === 'approved' ? 'approved' : 'pending', moderationStatus: status === 'suspended' ? 'suspended' : 'active', reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await audit(db, user, `profile_${status}`, uid);
      return reply(200, { ok: true, message: `Learner marked ${status}.` });
    }
    if (action === 'resolve-report') {
      const id = clean(body.id, 160); const outcome = clean(body.outcome, 120);
      if (!id || outcome.length < 2) throw httpError(400, 'Add a report resolution.');
      const ref = db.collection(COLLECTIONS.reports).doc(id); const report = await ref.get();
      if (!report.exists) throw httpError(404, 'Report not found.');
      await ref.update({ status: 'resolved', outcome, resolvedBy: user.email, resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
      await audit(db, user, 'report_resolved', report.data().reportedUid, { reportId: id, outcome });
      return reply(200, { ok: true, message: 'Report marked resolved.' });
    }
    throw httpError(400, 'Unknown action.');
  } catch (error) {
    console.error('Calling admin:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Request failed.' });
  }
};
