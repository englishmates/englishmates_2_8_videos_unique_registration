const admin = require('firebase-admin');

function db() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Tutor services are not configured yet.');
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
const clean = (v, max = 120) => String(v || '').trim().slice(0, max);
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const suffix = process.env.CONTEXT === 'production' ? '' : 'Preview';
const TUTORS = 'tutorApplications' + suffix;
const SCHEDULES = 'tutorWeeklyAvailability' + suffix;
const BLOCKS = 'tutorAvailabilityBlocks' + suffix;
const BOOKINGS = 'tutorBookings' + suffix;
const DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];

async function approvedTutor(event) {
  const headers = event.headers || {};
  const token = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Please sign in with your approved tutor account.'), { status: 401 });
  const decoded = await admin.auth().verifyIdToken(token);
  if (!decoded.email || !decoded.email_verified) throw Object.assign(new Error('Please verify your tutor email first.'), { status: 403 });
  const snapshot = await db().collection(TUTORS)
    .where('email', '==', decoded.email.toLowerCase())
    .where('status', '==', 'approved').limit(1).get();
  if (snapshot.empty) throw Object.assign(new Error('Your tutor profile is not approved yet. Please contact Englishmates.'), { status: 403 });
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data(), email: decoded.email.toLowerCase() };
}

function validateSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Please provide a valid weekly schedule.');
  const schedule = {};
  for (const key of Object.keys(input)) {
    if (!DAY_KEYS.includes(key)) throw new Error('Invalid weekday in your schedule.');
  }
  for (const day of DAY_KEYS) {
    const ranges = input[day] || [];
    if (!Array.isArray(ranges) || ranges.length > 1) throw new Error('Please add one time range per weekday for this first version.');
    if (!ranges.length) continue;
    const start = clean(ranges[0].start, 5), end = clean(ranges[0].end, 5);
    if (!timePattern.test(start) || !timePattern.test(end) || start >= end) {
      throw new Error('Check the start and end times. The end must be later than the start.');
    }
    schedule[day] = [{ start, end }];
  }
  return schedule;
}

exports.handler = async event => {
  try {
    const store = db();
    const tutor = await approvedTutor(event);
    if (event.httpMethod === 'GET') {
      const [scheduleDoc, blockSnapshot, bookingSnapshot] = await Promise.all([
        store.collection(SCHEDULES).doc(tutor.id).get(),
        store.collection(BLOCKS).where('tutorId', '==', tutor.id).limit(120).get(),
        store.collection(BOOKINGS).where('tutorId', '==', tutor.id).limit(100).get()
      ]);
      const blocks = blockSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a,b) => String(a.date).localeCompare(String(b.date)));
      const bookings = bookingSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')));
      return reply(200, {
        ok: true,
        tutorName: clean(tutor.name, 90),
        schedule: scheduleDoc.exists ? scheduleDoc.data().schedule || {} : {},
        blocks,
        bookings
      });
    }
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');

    if (body.action === 'save-weekly-schedule') {
      const schedule = validateSchedule(body.schedule);
      await store.collection(SCHEDULES).doc(tutor.id).set({
        tutorId: tutor.id,
        tutorEmail: tutor.email,
        timezone: 'Asia/Kolkata',
        schedule,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return reply(200, { ok: true, message: 'Weekly schedule saved.' });
    }

    if (body.action === 'block-date') {
      const date = clean(body.date, 10);
      const reason = clean(body.reason, 100);
      if (!isDate(date)) return reply(400, { ok: false, error: 'Choose a valid date.' });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      if (date < today) return reply(400, { ok: false, error: 'You cannot block a date in the past.' });
      const ref = store.collection(BLOCKS).doc(tutor.id + '_' + date);
      await ref.set({
        tutorId: tutor.id,
        date,
        reason,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return reply(200, { ok: true });
    }

    if (body.action === 'unblock-date') {
      const dateId = clean(body.dateId, 180);
      if (!dateId || !dateId.startsWith(tutor.id + '_')) return reply(400, { ok: false, error: 'Invalid blocked date.' });
      const ref = store.collection(BLOCKS).doc(dateId);
      const existing = await ref.get();
      if (existing.exists && existing.data().tutorId === tutor.id) await ref.delete();
      return reply(200, { ok: true });
    }

    return reply(400, { ok: false, error: 'Unknown dashboard action.' });
  } catch (error) {
    console.error('Teacher dashboard function:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Could not load the teacher dashboard.' });
  }
};
