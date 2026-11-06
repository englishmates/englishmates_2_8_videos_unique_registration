const admin = require('firebase-admin');

const ADMIN_EMAIL = 'bddayma12@gmail.com';
const COLLECTION = 'communityProfiles' + (process.env.CONTEXT === 'production' ? '' : 'Preview');
const AUDIT = 'communityProfileAudit' + (process.env.CONTEXT === 'production' ? '' : 'Preview');

function db() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Community profiles are not configured. Add FIREBASE_SERVICE_ACCOUNT_JSON in Netlify.');
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1'
    });
  }
  return admin.firestore();
}
const reply = (statusCode, payload) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  body: JSON.stringify(payload)
});
const clean = (v, max = 160) => String(v ?? '').trim().slice(0, max);
async function authenticate(event) {
  const headers = event.headers || {};
  const token = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\\s+/i, '');
  if (!token) throw Object.assign(new Error('Please sign in again.'), { status: 401 });
  const user = await admin.auth().verifyIdToken(token);
  if (!user.email_verified || !user.email) throw Object.assign(new Error('Verify your email before using the Calling Community.'), { status: 403 });
  return user;
}
async function requireAdmin(event) {
  const user = await authenticate(event);
  if (String(user.email).toLowerCase() !== ADMIN_EMAIL) throw Object.assign(new Error('Admin access only.'), { status: 403 });
  return user;
}
function profileFrom(body) {
  const p = body.profile || {};
  const name = clean(p.name, 80);
  const city = clean(p.city, 80);
  const age = Number(p.age);
  const speakingLevel = clean(p.speakingLevel, 24);
  const interests = Array.isArray(p.interests) ? p.interests.map(x => clean(x, 40)).filter(Boolean).slice(0, 8) : [];
  const goals = clean(p.goals, 500);
  const practiceLanguage = clean(p.practiceLanguage, 40);
  if (name.length < 2 || city.length < 2 || !Number.isInteger(age) || age < 13 || age > 100 ||
      !['Beginner', 'Intermediate', 'Advanced'].includes(speakingLevel) ||
      interests.length === 0 || goals.length < 5 || !['English', 'Hindi + English'].includes(practiceLanguage)) {
    throw Object.assign(new Error('Please complete all fields. Age must be 13 or above, and select at least one interest.'), { status: 400 });
  }
  return { name, city, age, speakingLevel, interests, goals, practiceLanguage };
}
exports.handler = async event => {
  try {
    const store = db();
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      if (params.admin === '1') {
        await requireAdmin(event);
        const snap = await store.collection(COLLECTION).where('status', '==', 'pending').limit(100).get();
        return reply(200, { ok: true, profiles: snap.docs.map(d => ({ uid: d.id, ...d.data() })) });
      }
      const user = await authenticate(event);
      const snap = await store.collection(COLLECTION).doc(user.uid).get();
      return reply(200, { ok: true, profile: snap.exists ? { uid: snap.id, ...snap.data() } : null });
    }
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'save-profile') {
        const user = await authenticate(event);
        const profile = profileFrom(body);
        const ref = store.collection(COLLECTION).doc(user.uid);
        const existing = await ref.get();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const data = {
          ...profile,
          uid: user.uid,
          email: String(user.email).toLowerCase(),
          emailVerified: true,
          updatedAt: now
        };
        if (!existing.exists) {
          data.status = 'pending';
          data.createdAt = now;
        }
        await ref.set(data, { merge: true });
        return reply(200, { ok: true, message: 'Profile saved. Your status is pending admin approval.' });
      }
      if (body.action === 'set-status') {
        const actor = await requireAdmin(event);
        const uid = clean(body.uid, 128);
        const status = clean(body.status, 20);
        if (!uid || !['approved', 'rejected', 'pending'].includes(status)) return reply(400, { ok: false, error: 'Invalid profile or status.' });
        const ref = store.collection(COLLECTION).doc(uid);
        const snap = await ref.get();
        if (!snap.exists) return reply(404, { ok: false, error: 'Student profile not found.' });
        await ref.update({
          status,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy: actor.uid,
          reviewedByEmail: ADMIN_EMAIL
        });
        await store.collection(AUDIT).add({
          uid, action: 'status_changed', status, actorUid: actor.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return reply(200, { ok: true, message: 'Student status updated to ' + status + '.' });
      }
      return reply(400, { ok: false, error: 'Unknown action.' });
    }
    return reply(405, { ok: false, error: 'Method not allowed.' });
  } catch (error) {
    console.error('Community profiles:', error.message);
    return reply(error.status || 400, { ok: false, error: error.message || 'Request failed.' });
  }
};
