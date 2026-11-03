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
const clean = (v, max = 160) => String(v || '').trim().slice(0, max);
const COLLECTION = process.env.CONTEXT === 'production' ? 'tutorBookings' : 'tutorBookingsPreview';
const SLOTS = process.env.CONTEXT === 'production' ? 'tutorAvailability' : 'tutorAvailabilityPreview';
const TUTORS = process.env.CONTEXT === 'production' ? 'tutorApplications' : 'tutorApplicationsPreview';

async function getApprovedTutor(db, event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Tutor sign-in required.'), { status: 401 });
  const user = await admin.auth().verifyIdToken(token);
  if (!user.email || !user.email_verified) throw Object.assign(new Error('Please verify your tutor email first.'), { status: 403 });
  const snap = await db.collection(TUTORS).where('email', '==', user.email.toLowerCase()).where('status', '==', 'approved').limit(1).get();
  if (snap.empty) throw Object.assign(new Error('Only an approved tutor can manage availability or bookings.'), { status: 403 });
  return { user, tutor: { id: snap.docs[0].id, ...snap.docs[0].data() } };
}

exports.handler = async event => {
  try {
    const db = getDb();
    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters && event.queryStringParameters.mine === '1') {
        const { tutor } = await getApprovedTutor(db, event);
        const [slotsSnap, bookingsSnap] = await Promise.all([
          db.collection(SLOTS).where('tutorId', '==', tutor.id).limit(250).get(),
          db.collection(COLLECTION).where('tutorId', '==', tutor.id).limit(250).get()
        ]);
        return reply(200, {
          ok: true,
          slots: slotsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
          bookings: bookingsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        });
      }
      const tutorId = clean(event.queryStringParameters?.tutorId, 150);
      const from = clean(event.queryStringParameters?.from, 10);
      const to = clean(event.queryStringParameters?.to, 10);
      if (!tutorId || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return reply(400, { ok: false, error: 'Tutor and date range are required.' });
      }
      const snap = await db.collection(SLOTS).where('tutorId', '==', tutorId).where('date', '>=', from).where('date', '<=', to).where('status', '==', 'available').limit(200).get();
      return reply(200, { ok: true, slots: snap.docs.map(d => ({ id: d.id, date: d.data().date, startTime: d.data().startTime, endTime: d.data().endTime })) });
    }
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');

    if (body.action === 'save-availability') {
      const { user, tutor } = await getApprovedTutor(db, event);
      if (!Array.isArray(body.slots) || body.slots.length > 60) return reply(400, { ok: false, error: 'Please add up to 60 availability slots at a time.' });
      const batch = db.batch();
      for (const item of body.slots) {
        const date = clean(item.date, 10), startTime = clean(item.startTime, 5), endTime = clean(item.endTime, 5);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime >= endTime) {
          return reply(400, { ok: false, error: 'One or more date/time slots are invalid.' });
        }
        const id = tutor.id + '_' + date + '_' + startTime.replace(':', '');
        const ref = db.collection(SLOTS).doc(id);
        batch.set(ref, { tutorId: tutor.id, tutorName: clean(tutor.name, 90), date, startTime, endTime, status: 'available', updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: user.email }, { merge: true });
      }
      await batch.commit();
      return reply(200, { ok: true, message: 'Availability saved.' });
    }

    if (body.action === 'request-booking') {
      const tutorId = clean(body.tutorId, 150), slotId = clean(body.slotId, 220);
      const studentName = clean(body.studentName, 90), phone = clean(body.phone, 10).replace(/\D/g, '');
      const email = clean(body.email, 160).toLowerCase();
      if (!tutorId || !slotId || studentName.length < 2 || !/^\d{10}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply(400, { ok: false, error: 'Please enter your name, valid 10-digit phone number and email.' });
      }
      const tutorDoc = await db.collection(TUTORS).doc(tutorId).get();
      if (!tutorDoc.exists || tutorDoc.data().status !== 'approved') return reply(404, { ok: false, error: 'This tutor is not available for booking.' });
      const slotRef = db.collection(SLOTS).doc(slotId);
      const bookingRef = db.collection(COLLECTION).doc();
      await db.runTransaction(async tx => {
        const slot = await tx.get(slotRef);
        if (!slot.exists || slot.data().tutorId !== tutorId || slot.data().status !== 'available') throw new Error('This time slot is no longer available. Please choose another slot.');
        tx.update(slotRef, { status: 'requested', bookingId: bookingRef.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.set(bookingRef, {
          tutorId, tutorName: clean(tutorDoc.data().name, 90), slotId,
          date: slot.data().date, startTime: slot.data().startTime, endTime: slot.data().endTime,
          studentName, phone, email, status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      return reply(200, { ok: true, bookingId: bookingRef.id, message: 'Booking request sent to the tutor.' });
    }

    if (body.action === 'respond-booking') {
      const { tutor } = await getApprovedTutor(db, event);
      const bookingId = clean(body.bookingId, 180);
      const decision = body.decision === 'accept' ? 'confirmed' : body.decision === 'decline' ? 'declined' : '';
      if (!bookingId || !decision) return reply(400, { ok: false, error: 'A booking and valid decision are required.' });
      const bookingRef = db.collection(COLLECTION).doc(bookingId);
      await db.runTransaction(async tx => {
        const booking = await tx.get(bookingRef);
        if (!booking.exists || booking.data().tutorId !== tutor.id) throw new Error('Booking not found for this tutor.');
        if (booking.data().status !== 'pending') throw new Error('This booking has already been processed.');
        const slotRef = db.collection(SLOTS).doc(booking.data().slotId);
        const slot = await tx.get(slotRef);
        tx.update(bookingRef, { status: decision, respondedAt: admin.firestore.FieldValue.serverTimestamp() });
        if (slot.exists) tx.update(slotRef, { status: decision === 'confirmed' ? 'booked' : 'available', bookingId: decision === 'confirmed' ? bookingId : admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return reply(200, { ok: true, status: decision });
    }
    return reply(400, { ok: false, error: 'Unknown booking action.' });
  } catch (error) {
    console.error('Tutor booking endpoint:', error);
    return reply(error.status || 500, { ok: false, error: error.message || 'Could not process the request.' });
  }
};
