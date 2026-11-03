const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Firebase service account is not configured');
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1'
    });
  }
  return admin.firestore();
}
const reply = (statusCode, payload) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(payload)
});
const clean = (v, max) => String(v || '').trim().slice(0, max);
// Keep preview submissions separate from the live tutor directory.
const COLLECTION = process.env.CONTEXT === 'production' ? 'tutorApplications' : 'tutorApplicationsPreview';

exports.handler = async event => {
  try {
    const db = getDb();
    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters && event.queryStringParameters.admin === '1') {
        const token = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
        if (!token) return reply(401, { ok: false, error: 'Admin sign-in required.' });
        const decoded = await admin.auth().verifyIdToken(token);
        if ((decoded.email || '').toLowerCase() !== 'bddayma12@gmail.com') return reply(403, { ok: false, error: 'Owner access only.' });
        const pending = await db.collection(COLLECTION).where('status', '==', 'pending').limit(100).get();
        return reply(200, { ok: true, applications: pending.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
      }
      const snap = await db.collection(COLLECTION)
        .where('status', '==', 'approved').limit(60).get();
      const tutors = snap.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id, name: d.name || '', qualification: d.qualification || '',
          experience: d.experience || '', subjects: d.subjects || '',
          city: d.city || '', photoData: d.photoData || '', bio: d.bio || ''
        };
      });
      return reply(200, { ok: true, tutors });
    }
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });

    const body = JSON.parse(event.body || '{}');
    if (body.action === 'approve' || body.action === 'reject') {
      const token = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return reply(401, { ok: false, error: 'Admin sign-in required.' });
      const decoded = await admin.auth().verifyIdToken(token);
      if ((decoded.email || '').toLowerCase() !== 'bddayma12@gmail.com') return reply(403, { ok: false, error: 'Owner access only.' });
      const id = clean(body.id, 150);
      if (!id) return reply(400, { ok: false, error: 'Application ID is required.' });
      await db.collection(COLLECTION).doc(id).update({
        status: body.action === 'approve' ? 'approved' : 'rejected',
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedBy: decoded.email
      });
      return reply(200, { ok: true });
    }
    const data = {
      name: clean(body.name, 90),
      phone: clean(body.phone, 10).replace(/\D/g, ''),
      email: clean(body.email, 160).toLowerCase(),
      qualification: clean(body.qualification, 160),
      experience: clean(body.experience, 100),
      subjects: clean(body.subjects, 180),
      city: clean(body.city, 100),
      photoData: clean(body.photoData, 700000),
      bio: clean(body.bio, 700)
    };
    if (!body.consent || data.name.length < 2 || !/^\d{10}$/.test(data.phone) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ||
        !data.qualification || !data.experience || !data.subjects || !data.city || data.bio.length < 20) {
      return reply(400, { ok: false, error: 'Please complete all required fields with valid details.' });
    }
    if (data.photoData && (!/^data:image\/jpeg;base64,/.test(data.photoData) || data.photoData.length > 700000)) {
      return reply(400, { ok: false, error: 'Please choose a smaller valid profile photo.' });
    }
    const existing = await db.collection(COLLECTION).where('phone', '==', data.phone).limit(1).get();
    if (!existing.empty) return reply(409, { ok: false, error: 'An application with this mobile number already exists. Please contact Englishmates.' });

    await db.collection(COLLECTION).add({
      ...data, status: 'pending',
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null
    });
    return reply(200, { ok: true, message: 'Application received for review.' });
  } catch (error) {
    console.error('Tutor marketplace endpoint:', error);
    return reply(500, { ok: false, error: 'Could not process the application right now. Please try again later.' });
  }
};
