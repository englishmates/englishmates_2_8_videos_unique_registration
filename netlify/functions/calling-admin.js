const {
  admin, COLLECTIONS, authenticatedUser, audit, clean, iso, reply,
  requireAdmin, store, httpError
} = require('../lib/calling');
const cors = require('../lib/cors');

const STATUSES = ['approved', 'rejected', 'suspended'];
function millis(value) { return value && typeof value.toMillis === 'function' ? value.toMillis() : Number(value || 0); }

function profileForAdmin(snapshot) {
  const value = snapshot.data();
  return {
    uid: snapshot.id, fullName: value.fullName, alias: value.alias, email: value.email,
    age: value.age, city: value.city, state: value.state, level: value.level,
    interests: value.interests || [], goals: value.goals, preferredLanguage: value.preferredLanguage, speechConsent: value.speechConsent === true, subscriptionEndsAt: iso(value.subscriptionEndsAt),
    locationPreference: value.locationPreference, status: value.status || 'approved', approvalMethod: value.approvalMethod || null,
    countryStatus: value.countryStatus || 'approved', createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt), reviewedAt: iso(value.reviewedAt), reviewedBy: value.reviewedBy || null
  };
}

async function activatePendingProfiles(db) {
  const pending = await db.collection(COLLECTIONS.profiles).where('status', '==', 'pending').get();
  const profiles = pending.docs;
  for (let start = 0; start < profiles.length; start += 450) {
    const batch = db.batch();
    profiles.slice(start, start + 450).forEach(doc => {
      const suspended = doc.data().moderationStatus === 'suspended';
      batch.update(doc.ref, {
        status: suspended ? 'suspended' : 'approved',
        countryStatus: 'approved',
        ...(suspended ? {} : { approvalMethod: 'automatic', approvedAt: admin.firestore.FieldValue.serverTimestamp() }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
  }
}

exports.handler = async event => {
  try {
    const db = store();
    const user = await authenticatedUser(event);
    requireAdmin(user);
    if (event.httpMethod === 'GET') {
      await activatePendingProfiles(db);
      const requested = clean(event.queryStringParameters?.status, 20);
      const status = STATUSES.includes(requested) ? requested : null;
      let query = db.collection(COLLECTIONS.profiles).orderBy('createdAt', 'desc').limit(100);
      if (status) query = db.collection(COLLECTIONS.profiles).where('status', '==', status).limit(100);
      const [profiles, reports, sessions, auditSnap, approvedCount, completedCount, activeCount, failureCount, payments, languageEvents] = await Promise.all([
        query.get(),
        db.collection(COLLECTIONS.reports).where('status', '==', 'open').limit(100).get(),
        db.collection(COLLECTIONS.sessions).where('status', 'in', ['invited', 'accepted', 'active']).limit(50).get(),
        db.collection(COLLECTIONS.audit).orderBy('createdAt', 'desc').limit(100).get(),
        db.collection(COLLECTIONS.profiles).where('status', '==', 'approved').count().get(),
        db.collection(COLLECTIONS.sessions).where('callCompleted', '==', true).count().get(),
        db.collection(COLLECTIONS.sessions).where('status', 'in', ['invited', 'accepted', 'active']).count().get(),
        db.collection(COLLECTIONS.failures).where('createdAt', '>=', admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000)).count().get(),
        db.collection(COLLECTIONS.subscriptionPayments).where('status', '==', 'under_review').limit(100).get(),
        db.collection(COLLECTIONS.languageEvents).orderBy('createdAt', 'desc').limit(100).get()
      ]);
      return reply(200, { ok: true,
        profiles: profiles.docs.map(profileForAdmin),
        reports: reports.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt), resolvedAt: iso(doc.data().resolvedAt) })),
        sessions: sessions.docs.map(doc => ({ id: doc.id, status: doc.data().status, participants: doc.data().participants || [], createdAt: iso(doc.data().createdAt), expiresAt: iso(doc.data().expiresAt) })),
        audit: auditSnap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) })),
        subscriptionPayments: payments.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) })),
        languageEvents: languageEvents.docs.filter(doc => millis(doc.data().deleteAt) > Date.now()).map(doc => ({ id: doc.id, uid: doc.data().uid, contextType: doc.data().contextType, detectedLanguage: doc.data().detectedLanguage, excerpt: doc.data().excerpt, strike: doc.data().strike, createdAt: iso(doc.data().createdAt), deleteAt: iso(doc.data().deleteAt) })),
        metrics: { approvedLearners: approvedCount.data().count, completedCalls: completedCount.data().count, activeCalls: activeCount.data().count, callFailures24h: failureCount.data().count }
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
      return reply(200, { ok: true, message: status === 'approved' ? 'Learner access restored.' : status === 'rejected' ? 'Learner access blocked.' : 'Learner access suspended.' });
    }
    if (action === 'review-subscription-payment') {
      const id = clean(body.id, 160);
      const decision = clean(body.decision, 20);
      if (!id || !['approve', 'reject'].includes(decision)) throw httpError(400, 'Choose a UPI payment and an approval decision.');
      const paymentRef = db.collection(COLLECTIONS.subscriptionPayments).doc(id);
      const payment = await paymentRef.get();
      if (!payment.exists || payment.data().provider !== 'upi' || payment.data().status !== 'under_review') throw httpError(404, 'Pending UPI payment review not found.');
      let passEnd = null;
      if (decision === 'approve') {
        const profileRef = db.collection(COLLECTIONS.profiles).doc(payment.data().uid);
        passEnd = await db.runTransaction(async tx => {
          const [paymentSnap, profileSnap] = await Promise.all([tx.get(paymentRef), tx.get(profileRef)]);
          if (!paymentSnap.exists || paymentSnap.data().status !== 'under_review' || !profileSnap.exists) throw httpError(409, 'This payment review is no longer pending.');
          const start = Math.max(Date.now(), millis(profileSnap.data().subscriptionEndsAt));
          const end = start + 30 * 24 * 60 * 60 * 1000;
          tx.update(paymentRef, { status: 'approved', reviewedBy: user.email, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(profileRef, { subscriptionEndsAt: admin.firestore.Timestamp.fromMillis(end), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          return end;
        });
      } else {
        await paymentRef.update({ status: 'rejected', reviewedBy: user.email, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      await audit(db, user, 'calling_subscription_' + decision, payment.data().uid, { paymentId: id, provider: 'upi', passEnd: passEnd || null });
      return reply(200, { ok: true, message: decision === 'approve' ? 'UPI verified. A 30-day pass is active.' : 'UPI payment was rejected.' });
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

const handler = exports.handler;
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return cors.options(event);
  const response = await handler(event);
  return { ...response, headers: { ...(response.headers || {}), ...cors.headers(event) } };
};
