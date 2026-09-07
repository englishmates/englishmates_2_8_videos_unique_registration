const admin = require('firebase-admin');
const crypto = require('crypto');

let initialized = false;
function initFirebase() {
  if (initialized) return;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
    projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1'
  });
  initialized = true;
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function lockIdFor(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex');
}

async function sendAdminPush(data) {
  try {
    const db = admin.firestore();
    const snap = await db.collection('adminDevices').get();
    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return { sent: 0 };

    const title = 'New Englishmates Registration';
    const body = `${data.name} joined ${data.course}${data.fee ? ` • ${data.fee}` : ''}`;
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: {
        title,
        body,
        course: String(data.course || ''),
        fee: String(data.fee || ''),
        admissionDate: String(data.admissionDate || '')
      },
      webpush: {
        notification: {
          icon: '/bhagirath-dayma-profile.png',
          badge: '/bhagirath-dayma-profile.png'
        },
        fcmOptions: { link: '/' }
      }
    });

    const cleanup = [];
    snap.docs.forEach((doc, i) => {
      const r = response.responses[i];
      if (r && !r.success) {
        const code = r.error && r.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          cleanup.push(doc.ref.delete());
        }
      }
    });
    await Promise.all(cleanup);
    return { sent: response.successCount };
  } catch (err) {
    console.error('Push notification failed:', err);
    return { sent: 0, error: err.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  let lockRef = null;
  try {
    initFirebase();
    const db = admin.firestore();
    const body = JSON.parse(event.body || '{}');
    const name = String(body.name || '').trim();
    const phone = normalizePhone(body.phone);
    const email = String(body.email || '').trim();
    const course = String(body.course || body.interest || '').trim();

    if (!name || !/^\d{10}$/.test(phone) || !course) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Name, valid 10-digit phone and course are required.' }) };
    }

    const lockId = lockIdFor(phone);
    lockRef = db.collection('registrationLocks').doc(lockId);

    // First protect against registrations already present in the existing roster.
    const [leadSnap, studentSnap] = await Promise.all([
      db.collection('leads').where('phone', '==', phone).limit(1).get(),
      db.collection('students').where('phone', '==', phone).limit(1).get()
    ]);
    if (!leadSnap.empty || !studentSnap.empty) {
      return { statusCode: 409, body: JSON.stringify({ ok: false, duplicate: true, message: 'You are already registered.' }) };
    }

    // Atomic lock: two simultaneous submissions with the same phone cannot both succeed.
    await lockRef.create({
      phone,
      name,
      course,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const now = new Date().toISOString();
    const data = {
      name,
      phone,
      email,
      course,
      goal: String(body.goal || '').trim(),
      txnId: String(body.txnId || '').trim(),
      profileUrl: String(body.profileUrl || ''),
      fee: String(body.fee || ''),
      admissionDate: now,
      paymentStatus: body.txnId ? 'Paid / Registered' : 'Pending',
      status: body.txnId ? 'Enrolled' : 'Enquiry',
      registrationId: lockId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const leadRef = await db.collection('leads').add(data);
    await db.collection('students').add({ ...data, leadId: leadRef.id });

    // Keep the lock with the final registration record for auditability.
    await lockRef.set({ leadId: leadRef.id, completedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    const push = await sendAdminPush(data);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, duplicate: false, message: 'Registration successful.', notificationSent: push.sent || 0 })
    };
  } catch (err) {
    console.error('Admission submission failed:', err);
    if (err && err.code === 6) {
      return { statusCode: 409, body: JSON.stringify({ ok: false, duplicate: true, message: 'You are already registered.' }) };
    }
    if (lockRef) {
      try { await lockRef.delete(); } catch (cleanupErr) { console.error('Lock cleanup failed:', cleanupErr); }
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Registration could not be completed right now.' }) };
  }
};
