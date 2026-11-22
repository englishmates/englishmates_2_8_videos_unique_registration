'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('../lib/cors');

function db() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('LMS backend is not configured.');
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'englishmates-ratangarh-933f1.firebasestorage.app'
    });
  }
  return admin.firestore();
}

const suffix = process.env.CONTEXT === 'production' ? '' : 'Preview';
const proofRoot = suffix ? 'payment-proofs-preview' : 'payment-proofs';
const col = name => db().collection(name + suffix);
const clean = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const now = () => admin.firestore.FieldValue.serverTimestamp();
const response = (event, statusCode, body) => ({
  statusCode,
  headers: Object.assign({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, cors.headers(event)),
  body: JSON.stringify(body)
});
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });

function authToken(event) {
  const headers = event.headers || {};
  return String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');
}

async function userFromEvent(event, required = true) {
  const token = authToken(event);
  if (!token) {
    if (!required) return null;
    throw fail(401, 'Please sign in to continue.');
  }
  const decoded = await admin.auth().verifyIdToken(token);
  if (!decoded.email || decoded.email_verified !== true) {
    throw fail(403, 'Verify your email address before continuing.');
  }
  return decoded;
}

async function requireAdmin(event) {
  const user = await userFromEvent(event);
  const allowed = String(process.env.LMS_ADMIN_EMAIL || 'bddayma12@gmail.com').toLowerCase();
  if (String(user.email || '').toLowerCase() !== allowed || user.firebase?.sign_in_provider !== 'password') throw fail(403, 'Sign in with the authorized admin email and password for admin access.');
  return user;
}

function slug(value) {
  return clean(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
}

function validImageBytes(buffer, contentType) {
  if (contentType === 'image/jpeg') return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (contentType === 'image/png') return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/webp') return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function streamConfig() {
  const accountId = process.env.CLOUDFLARE_STREAM_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
  const customerHost = String(process.env.CLOUDFLARE_STREAM_CUSTOMER_HOST || '').trim().toLowerCase();
  if (!accountId || !apiToken || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.cloudflarestream\.com$/.test(customerHost)) {
    throw fail(503, 'Secure video hosting is not configured. Add the Cloudflare Stream settings in Netlify.');
  }
  return { accountId, apiToken, customerHost };
}

function streamAllowedOrigins() {
  const raw = process.env.CONTEXT === 'production'
    ? [process.env.URL]
    : [process.env.DEPLOY_PRIME_URL || process.env.URL];
  return Array.from(new Set(raw.map(value => {
    try { return new URL(value).hostname.toLowerCase(); } catch (_) { return ''; }
  }).filter(Boolean)));
}

async function streamApi(path, options = {}) {
  const config = streamConfig();
  const headers = { Authorization: 'Bearer ' + config.apiToken };
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const result = await fetch('https://api.cloudflare.com/client/v4/accounts/' +
    encodeURIComponent(config.accountId) + '/stream' + path, {
      method: options.method || 'GET', headers, body
    });
  let payload = {};
  try { payload = await result.json(); } catch (_) {}
  if (!result.ok || payload.success !== true) {
    console.error('Cloudflare Stream API error:', result.status, Array.isArray(payload.errors) ? payload.errors.map(x => x.code).join(',') : '');
    throw fail(502, 'Secure video provider could not complete the request.');
  }
  return payload.result || {};
}

function timestampValue(value) {
  return value && typeof value.toDate === 'function' ? value.toDate().toISOString() : value || null;
}

function serialize(doc) {
  const value = doc.data();
  return Object.assign({ id: doc.id }, value, {
    createdAt: timestampValue(value.createdAt),
    updatedAt: timestampValue(value.updatedAt),
    reviewedAt: timestampValue(value.reviewedAt),
    paidAt: timestampValue(value.paidAt)
  });
}

function parseMoneyPaise(course) {
  for (const key of ['pricePaise', 'salePricePaise', 'discountedPricePaise']) {
    if (course[key] === null || course[key] === undefined || course[key] === '') continue;
    const n = Number(course[key]);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  for (const key of ['price', 'salePrice', 'discountedPrice']) {
    if (course[key] === null || course[key] === undefined || course[key] === '') continue;
    const n = Number(course[key]);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100);
  }
  const digits = String(course.fee || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) * 100 : null;
}

function publicCourse(id, c, source) {
  return {
    id,
    source: source || 'lms',
    title: clean(c.title || c.name, 140),
    name: clean(c.name || c.title, 140),
    description: clean(c.description || c.shortDescription, 1600),
    shortDescription: clean(c.shortDescription || c.description, 260),
    category: clean(c.category || c.tag || 'Spoken English', 80),
    level: clean(c.level || 'All levels', 40),
    language: clean(c.language || 'English', 60),
    duration: clean(c.duration, 80),
    startDate: clean(c.startDate, 24),
    endDate: clean(c.endDate, 24),
    enrollmentDeadline: clean(c.enrollmentDeadline, 24),
    instructorName: clean(c.instructorName || c.instructor || 'Englishmates', 100),
    instructorPhoto: clean(c.instructorPhoto, 500),
    thumbnailUrl: clean(c.thumbnailUrl || c.bannerUrl, 700),
    pricePaise: parseMoneyPaise(c),
    originalPricePaise: Number.isFinite(Number(c.originalPricePaise)) ? Number(c.originalPricePaise) : null,
    fee: clean(c.fee, 80),
    features: Array.isArray(c.features) ? c.features.map(x => clean(x, 160)).slice(0, 20) : [],
    outcomes: Array.isArray(c.outcomes) ? c.outcomes.map(x => clean(x, 200)).slice(0, 20) : [],
    syllabus: Array.isArray(c.syllabus) ? c.syllabus.map(x => clean(x, 240)).slice(0, 30) : [],
    requirements: clean(c.requirements, 800),
    faqs: Array.isArray(c.faqs) ? c.faqs.slice(0, 12).map(x => ({
      question: clean(x.question, 180), answer: clean(x.answer, 600)
    })) : [],
    demoVideoId: clean(c.demoVideoId, 20),
    lectureCount: Number(c.lectureCount || 0),
    previewCount: Number(c.previewCount || 0),
    totalMinutes: Number(c.totalMinutes || 0),
    popularity: Number(c.popularity || c.enrollmentCount || 0),
    ratingAverage: Number(c.ratingAverage || 0),
    reviewCount: Number(c.reviewCount || 0),
    status: clean(c.status || (c.active === false || c.archived ? 'draft' : 'published'), 20),
    order: Number(c.order || 999),
    createdAt: timestampValue(c.createdAt)
  };
}

async function findCourse(courseId) {
  const lmsSnap = await col('lmsCourses').doc(courseId).get();
  if (lmsSnap.exists && lmsSnap.data().status !== 'draft') return { id: lmsSnap.id, data: lmsSnap.data(), source: 'lms' };
  const legacySnap = await db().collection('courses').doc(courseId).get();
  if (legacySnap.exists) return { id: legacySnap.id, data: legacySnap.data(), source: 'legacy' };
  if (lmsSnap.exists) return { id: lmsSnap.id, data: lmsSnap.data(), source: 'lms' };
  return null;
}

async function listPublicCourses() {
  const lms = await col('lmsCourses').get();
  const published = lms.docs
    .map(d => publicCourse(d.id, d.data(), 'lms'))
    .filter(c => c.status === 'published');
  const overrides = new Set(lms.docs.filter(d => d.data().status !== 'draft').map(d => d.id));
  const legacy = await db().collection('courses').get();
  const legacyCourses = legacy.docs
    .filter(d => !overrides.has(d.id))
    .map(d => publicCourse(d.id, d.data(), 'legacy'))
    .filter(c => c.status === 'published');
  return published.concat(legacyCourses)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

function priceFromCourse(course) {
  const amount = parseMoneyPaise(course);
  if (amount === null) throw fail(400, 'The course fee is not configured. Please contact Englishmates.');
  return amount;
}

function profileId(uid) {
  return 'EM-' + uid.toUpperCase();
}

async function ensureProfile(uid, decoded, details = {}) {
  const ref = col('userProfiles').doc(uid);
  const profile = {
    uid,
    studentId: profileId(uid),
    name: clean(details.name || decoded.name || decoded.email.split('@')[0], 100),
    email: String(decoded.email || '').toLowerCase(),
    phone: clean(details.phone, 10).replace(/\D/g, '').slice(-10),
    qualification: clean(details.qualification, 120),
    city: clean(details.city, 100),
    state: clean(details.state, 100),
    role: 'student',
    updatedAt: now()
  };
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const current = snap.data();
      tx.set(ref, Object.assign({}, profile, {
        role: current.role || 'student',
        studentId: current.studentId || profile.studentId,
        createdAt: current.createdAt || now()
      }), { merge: true });
    } else {
      tx.set(ref, Object.assign({}, profile, { createdAt: now() }));
    }
  });
  const saved = await ref.get();
  return serialize(saved);
}

async function getContent(courseId) {
  const modulesSnap = await col('lmsCourseContent').doc(courseId).collection('modules').orderBy('order').get();
  const modules = [];
  for (const moduleDoc of modulesSnap.docs) {
    const lessonSnap = await moduleDoc.ref.collection('lessons').orderBy('order').get();
    modules.push(Object.assign({ id: moduleDoc.id }, moduleDoc.data(), {
      lessons: lessonSnap.docs.filter(d => d.data().published !== false).map(d => {
        const lesson = d.data();
        return {
          id: d.id,
          title: clean(lesson.title, 180),
          description: clean(lesson.description, 1200),
          notes: clean(lesson.notes, 3000),
          resourceUrl: clean(lesson.resourceUrl, 700),
          assignment: clean(lesson.assignment, 1600),
          hasVideo: Boolean(lesson.videoUid || lesson.youtubeId),
          durationMinutes: Number(lesson.durationMinutes || 0),
          order: Number(lesson.order || 0),
          preview: lesson.preview === true
        };
      })
    }));
  }
  return modules;
}

async function recountCourse(courseId) {
  const modules = await col('lmsCourseContent').doc(courseId).collection('modules').get();
  let lectureCount = 0, previewCount = 0, totalMinutes = 0;
  for (const m of modules.docs) {
    const lessons = await m.ref.collection('lessons').get();
    lessons.docs.filter(d => d.data().published !== false).forEach(d => {
      lectureCount++;
      if (d.data().preview === true) previewCount++;
      totalMinutes += Number(d.data().durationMinutes || 0);
    });
  }
  await col('lmsCourses').doc(courseId).set({ lectureCount, previewCount, totalMinutes, updatedAt: now() }, { merge: true });
  return { lectureCount, previewCount, totalMinutes };
}

const materialsRoot = suffix ? 'course-materials-preview' : 'course-materials';
const MATERIAL_KINDS = ['workbook', 'pdf'];
const MATERIAL_MAX_BYTES = 25 * 1024 * 1024;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeIdFrom(value) {
  const text = clean(value, 300);
  if (YT_ID.test(text)) return text;
  const m = text.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

function materialMeta(file) {
  return file && file.path ? { name: clean(file.name, 140), size: Number(file.size || 0) } : null;
}

async function hasActiveEnrollment(uid, courseId) {
  const id = crypto.createHash('sha256').update(uid + ':' + courseId).digest('hex').slice(0, 40);
  const snap = await col('enrollments').doc(id).get();
  return snap.exists && snap.data().status === 'active' ? { id, data: snap.data() } : null;
}

async function adminDashboard() {
  const [courses, enrollments, payments] = await Promise.all([
    col('lmsCourses').get(),
    col('enrollments').limit(300).get(),
    col('payments').limit(300).get()
  ]);
  const courseMap = new Map(courses.docs.map(d => [d.id, d.data()]));
  const enrollmentRows = enrollments.docs.map(d => {
    const item = serialize(d);
    const course = courseMap.get(item.courseId) || {};
    item.totalLessons = Number(course.lectureCount || item.totalLessons || 0);
    item.completedLessons = Number(item.completedLessons || 0);
    item.progressPercent = item.totalLessons ? Math.min(100, Math.round(item.completedLessons * 100 / item.totalLessons)) : 0;
    return item;
  });
  const sortRecent = a => a.sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  return {
    courses: courses.docs.map(d => {
      const item = serialize(d);
      const m = item.materials || {};
      item.materials = { workbook: materialMeta(m.workbook), pdf: materialMeta(m.pdf) };
      return item;
    }),
    enrollments: sortRecent(enrollmentRows),
    payments: sortRecent(payments.docs.map(serialize))
  };
}

async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return cors.options(event);
  if (event.httpMethod !== 'POST') return response(event, 405, { ok: false, error: 'POST required.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return response(event, 400, { ok: false, error: 'Invalid request body.' }); }
  const action = clean(body.action, 60);

  try {
    db();
    if (action === 'public-courses') {
      return response(event, 200, { ok: true, courses: await listPublicCourses() });
    }

    if (action === 'public-course') {
      const id = clean(body.courseId, 120);
      const found = id ? await findCourse(id) : null;
      if (!found) return response(event, 404, { ok: false, error: 'Course not found.' });
      const item = publicCourse(found.id, found.data, found.source);
      if (item.status !== 'published') return response(event, 404, { ok: false, error: 'Course not found.' });
      return response(event, 200, { ok: true, course: item });
    }

    if (action === 'course-reviews') {
      const courseId = clean(body.courseId, 120);
      if (!courseId) throw fail(400, 'Choose a course.');
      const course = await findCourse(courseId);
      if (!course || publicCourse(course.id, course.data, course.source).status !== 'published') throw fail(404, 'Course not found.');
      const snapshot = await col('courseReviews').where('courseId', '==', courseId).limit(30).get();
      const reviews = snapshot.docs.map(d => ({
        name: clean(d.data().name, 100), rating: Number(d.data().rating || 0),
        text: clean(d.data().text, 600), createdAt: timestampValue(d.data().createdAt)
      })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return response(event, 200, { ok: true, reviews });
    }

    if (action === 'submit-course-review') {
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      const rating = Number(body.rating);
      const text = clean(body.text, 600);
      if (!courseId || !Number.isInteger(rating) || rating < 1 || rating > 5 || text.length < 5) throw fail(400, 'Choose a 1–5 rating and write at least five characters.');
      const active = await hasActiveEnrollment(user.uid, courseId);
      if (!active) throw fail(403, 'Only enrolled students can review this course.');
      const courseRef = col('lmsCourses').doc(courseId);
      const reviewId = crypto.createHash('sha256').update(user.uid + ':' + courseId).digest('hex').slice(0, 40);
      const reviewRef = col('courseReviews').doc(reviewId);
      await db().runTransaction(async tx => {
        const [courseSnap, reviewSnap, profileSnap] = await Promise.all([
          tx.get(courseRef), tx.get(reviewRef), tx.get(col('userProfiles').doc(user.uid))
        ]);
        if (!courseSnap.exists || courseSnap.data().status !== 'published') throw fail(404, 'Course not found.');
        const prior = reviewSnap.exists ? reviewSnap.data() : null;
        const count = Number(courseSnap.data().reviewCount || 0);
        const previousRating = prior ? Number(prior.rating || 0) : 0;
        const nextCount = prior ? count : count + 1;
        const total = Number(courseSnap.data().ratingTotal || (Number(courseSnap.data().ratingAverage || 0) * count)) - previousRating + rating;
        const name = clean((profileSnap.exists && profileSnap.data().name) || user.name || String(user.email).split('@')[0], 100);
        tx.set(reviewRef, { uid: user.uid, courseId, name, rating, text, createdAt: now(), updatedAt: now() }, { merge: true });
        tx.set(courseRef, { ratingTotal: total, reviewCount: nextCount, ratingAverage: nextCount ? Math.round((total / nextCount) * 10) / 10 : 0, updatedAt: now() }, { merge: true });
      });
      return response(event, 200, { ok: true });
    }

    if (action === 'save-profile') {
      const user = await userFromEvent(event);
      const profile = await ensureProfile(user.uid, user, body.profile || {});
      return response(event, 200, { ok: true, profile });
    }

    if (action === 'my-enrollments') {
      const user = await userFromEvent(event);
      const snapshot = await col('enrollments').where('uid', '==', user.uid).limit(100).get();
      const profileSnap = await col('userProfiles').doc(user.uid).get();
      const profile = profileSnap.exists ? serialize(profileSnap) : null;
      const enrollments = [];
      for (const doc of snapshot.docs.slice(0, 30)) {
        const item = serialize(doc);
        const courseSnap = await col('lmsCourses').doc(item.courseId).get();
        item.totalLessons = Number((courseSnap.exists && courseSnap.data().lectureCount) || item.totalLessons || 0);
        item.completedLessons = Number(item.completedLessons || 0);
        item.progressPercent = item.totalLessons ? Math.min(100, Math.round(item.completedLessons * 100 / item.totalLessons)) : 0;
        enrollments.push(item);
      }
      enrollments.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const [paymentSnap, notificationSnap] = await Promise.all([
        col('payments').where('uid', '==', user.uid).limit(100).get(),
        col('userNotifications').where('uid', '==', user.uid).limit(40).get()
      ]);
      const payments = paymentSnap.docs.map(d => {
        const p = d.data();
        return { id: d.id, enrollmentId: p.enrollmentId, courseName: clean(p.courseName, 140), amountPaise: Number(p.amountPaise || 0), status: clean(p.status, 30), utr: clean(p.utr, 40), createdAt: timestampValue(p.createdAt), updatedAt: timestampValue(p.updatedAt) };
      }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const notifications = notificationSnap.docs.map(serialize).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return response(event, 200, { ok: true, profile, enrollments, payments, notifications });
    }

    if (action === 'get-certificate') {
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      const enrollment = await hasActiveEnrollment(user.uid, courseId);
      if (!enrollment) throw fail(403, 'An active enrollment is required.');
      const courseSnap = await col('lmsCourses').doc(courseId).get();
      const total = Number((courseSnap.exists && courseSnap.data().lectureCount) || enrollment.data.totalLessons || 0);
      const completed = Number(enrollment.data.completedLessons || 0);
      if (!total || completed < total) throw fail(409, 'Complete all published lessons before requesting a certificate.');
      const certificateId = 'EMC-' + crypto.createHash('sha256').update(user.uid + ':' + courseId).digest('hex').slice(0, 10).toUpperCase();
      const ref = col('certificates').doc(certificateId);
      await db().runTransaction(async tx => {
        const existing = await tx.get(ref);
        if (!existing.exists) tx.create(ref, {
          certificateId, uid: user.uid, studentId: enrollment.data.studentId,
          studentName: enrollment.data.studentName, courseId,
          courseName: enrollment.data.courseName, completedLessons: completed,
          totalLessons: total, issuedAt: now()
        });
      });
      const certificate = await ref.get();
      return response(event, 200, { ok: true, certificate: serialize(certificate) });
    }

    if (action === 'mark-notifications-read') {
      const user = await userFromEvent(event);
      const snapshot = await col('userNotifications').where('uid', '==', user.uid).limit(40).get();
      const batch = db().batch();
      snapshot.docs.forEach(d => batch.set(d.ref, { read: true, updatedAt: now() }, { merge: true }));
      if (!snapshot.empty) await batch.commit();
      return response(event, 200, { ok: true });
    }

    if (action === 'enroll') {
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      const name = clean(body.name, 100);
      const phone = clean(body.phone, 32).replace(/\D/g, '').slice(-10);
      const qualification = clean(body.qualification, 120);
      const city = clean(body.city, 100);
      const state = clean(body.state, 100);
      if (!courseId || name.length < 2 || !/^\d{10}$/.test(phone) || !qualification || !city || !state) {
        throw fail(400, 'Enter your name, 10-digit mobile number, qualification, city and state.');
      }
      const course = await findCourse(courseId);
      if (!course) throw fail(404, 'Course not found.');
      const p = publicCourse(course.id, course.data, course.source);
      if (p.status !== 'published') throw fail(400, 'This course is not open for enrollment.');
      const amount = priceFromCourse(course.data);
      if (p.enrollmentDeadline && /^\d{4}-\d{2}-\d{2}$/.test(p.enrollmentDeadline) && p.enrollmentDeadline < new Date().toISOString().slice(0, 10)) throw fail(400, 'Enrollment for this course has closed.');
      const profile = await ensureProfile(user.uid, user, { name, phone, qualification, city, state });
      const enrollmentId = crypto.createHash('sha256').update(user.uid + ':' + courseId).digest('hex').slice(0, 40);
      const ref = col('enrollments').doc(enrollmentId);
      let alreadyExists = false;
      await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists) { alreadyExists = true; return; }
        const free = amount === 0;
        const data = {
          uid: user.uid, studentId: profile.studentId, studentName: name,
          email: String(user.email).toLowerCase(), phone, qualification, city, state,
          courseId, courseName: p.title, courseSource: course.source,
          courseStartDate: p.startDate, courseEndDate: p.endDate, duration: p.duration,
          amountPaise: amount, totalLessons: Number(p.lectureCount || 0), completedLessons: 0,
          paymentStatus: free ? 'not_required' : 'unpaid',
          status: free ? 'active' : 'pending_payment',
          createdAt: now(), updatedAt: now()
        };
        tx.create(ref, data);
      });
      const enrollment = serialize(await ref.get());
      return response(event, 200, { ok: true, existing: alreadyExists, enrollment });
    }

    if (action === 'create-payment') {
      const user = await userFromEvent(event);
      const enrollmentId = clean(body.enrollmentId, 100);
      const ref = col('enrollments').doc(enrollmentId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== user.uid) throw fail(404, 'Enrollment not found.');
      const enrollment = snap.data();
      if (enrollment.status === 'active') return response(event, 200, { ok: true, alreadyPaid: true });
      if (Number(enrollment.amountPaise || 0) <= 0) throw fail(400, 'This enrollment does not require payment.');
      const prior = await col('payments').where('enrollmentId', '==', enrollmentId).limit(20).get();
      const waiting = prior.docs.find(d => ['created', 'under_review', 'paid'].includes(d.data().status));
      if (waiting) return response(event, 200, { ok: true, payment: serialize(waiting) });
      const paymentRef = col('payments').doc();
      const payment = {
        enrollmentId, uid: user.uid, courseId: enrollment.courseId,
        courseName: enrollment.courseName, amountPaise: enrollment.amountPaise,
        currency: 'INR', method: 'manual_upi', status: 'created',
        utr: '', proofPath: '', createdAt: now(), updatedAt: now()
      };
      await paymentRef.set(payment);
      return response(event, 200, { ok: true, payment: Object.assign({ id: paymentRef.id }, payment) });
    }

    if (action === 'upload-payment-proof') {
      const user = await userFromEvent(event);
      const paymentId = clean(body.paymentId, 120);
      const fileName = clean(body.fileName, 100).replace(/[^A-Za-z0-9._-]/g, '_') || 'proof.png';
      const contentType = clean(body.contentType, 80).toLowerCase();
      const encoded = String(body.base64 || '');
      if (!paymentId || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail(400, 'Upload a JPEG, PNG or WebP payment image.');
      const paymentRef = col('payments').doc(paymentId);
      const paymentSnap = await paymentRef.get();
      if (!paymentSnap.exists || paymentSnap.data().uid !== user.uid || paymentSnap.data().status !== 'created') throw fail(404, 'Payment request not found.');
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw fail(413, 'Payment proof must be 3 MB or smaller.');
      if (!validImageBytes(bytes, contentType)) throw fail(400, 'The uploaded file is not a valid image.');
      const proofPath = proofRoot + '/' + user.uid + '/' + paymentId + '/' + fileName;
      await admin.storage().bucket().file(proofPath).save(bytes, {
        resumable: false,
        metadata: { contentType, cacheControl: 'private, max-age=0, no-transform' }
      });
      await paymentRef.set({ proofPath, updatedAt: now() }, { merge: true });
      return response(event, 200, { ok: true, proofPath });
    }

    if (action === 'payment-proof-url') {
      await requireAdmin(event);
      const paymentId = clean(body.paymentId, 120);
      const paymentSnap = await col('payments').doc(paymentId).get();
      if (!paymentSnap.exists || !paymentSnap.data().proofPath) throw fail(404, 'Payment proof not found.');
      const path = String(paymentSnap.data().proofPath);
      if (!path.startsWith(proofRoot + '/')) throw fail(403, 'Payment proof belongs to another deployment.');
      const signed = await admin.storage().bucket().file(path).getSignedUrl({
        action: 'read', expires: Date.now() + 5 * 60 * 1000
      });
      return response(event, 200, { ok: true, url: signed[0] });
    }

    if (action === 'upload-course-thumbnail') {
      await requireAdmin(event);
      const courseId = slug(body.courseId);
      const fileName = clean(body.fileName, 100).replace(/[^A-Za-z0-9._-]/g, '_') || 'cover';
      const contentType = clean(body.contentType, 80).toLowerCase();
      const encoded = String(body.base64 || '');
      if (!courseId || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail(400, 'Upload a JPEG, PNG or WebP course image.');
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw fail(413, 'Course image must be 3 MB or smaller.');
      if (!validImageBytes(bytes, contentType)) throw fail(400, 'The uploaded file is not a valid image.');
      const courseSnap = await col('lmsCourses').doc(courseId).get();
      if (!courseSnap.exists) throw fail(404, 'Save the course before uploading its thumbnail.');
      const root = suffix ? 'course-thumbnails-preview' : 'course-thumbnails';
      const path = root + '/' + courseId + '/' + fileName;
      const token = crypto.randomUUID();
      await admin.storage().bucket().file(path).save(bytes, {
        resumable: false,
        metadata: {
          contentType, cacheControl: 'public, max-age=3600',
          metadata: { firebaseStorageDownloadTokens: token }
        }
      });
      const bucketName = admin.storage().bucket().name;
      const url = 'https://firebasestorage.googleapis.com/v0/b/' + encodeURIComponent(bucketName) + '/o/' + encodeURIComponent(path) + '?alt=media&token=' + token;
      return response(event, 200, { ok: true, thumbnailUrl: url });
    }

    if (action === 'submit-payment') {
      const user = await userFromEvent(event);
      const paymentId = clean(body.paymentId, 120);
      const utr = clean(body.utr, 40).replace(/\s/g, '');
      const proofPath = clean(body.proofPath, 500);
      if (!paymentId || !/^[A-Za-z0-9-]{6,40}$/.test(utr)) throw fail(400, 'Enter a valid UTR or transaction reference.');
      const paymentRef = col('payments').doc(paymentId);
      const paymentSnap = await paymentRef.get();
      if (!paymentSnap.exists || paymentSnap.data().uid !== user.uid) throw fail(404, 'Payment request not found.');
      const expectedPrefix = proofRoot + '/' + user.uid + '/' + paymentId + '/';
      if (!proofPath.startsWith(expectedPrefix)) throw fail(400, 'Upload the payment screenshot using this form.');
      const exists = await admin.storage().bucket().file(proofPath).exists();
      if (!exists[0]) throw fail(400, 'Payment screenshot upload was not found. Please upload it again.');
      if (paymentSnap.data().status !== 'created') throw fail(409, 'This payment is already awaiting review.');
      await db().runTransaction(async tx => {
        const fresh = await tx.get(paymentRef);
        if (!fresh.exists || fresh.data().uid !== user.uid || fresh.data().status !== 'created') throw fail(409, 'This payment is already awaiting review.');
        tx.update(paymentRef, { utr, proofPath, status: 'under_review', updatedAt: now() });
        tx.update(col('enrollments').doc(fresh.data().enrollmentId), {
          status: 'pending_review', paymentStatus: 'under_review', updatedAt: now()
        });
      });
      return response(event, 200, { ok: true, message: 'Payment details sent to the admin for review.' });
    }

    if (action === 'public-lessons') {
      // Public outline: titles, lengths and which lessons are free. Never includes video IDs or notes.
      const courseId = clean(body.courseId, 120);
      if (!courseId) throw fail(400, 'Choose a course.');
      const found = await findCourse(courseId);
      if (!found || publicCourse(found.id, found.data, found.source).status !== 'published') throw fail(404, 'Course not found.');
      const content = await getContent(courseId);
      return response(event, 200, { ok: true, modules: content.map(m => ({
        id: m.id, title: m.title,
        lessons: m.lessons.map(l => ({ id: l.id, title: l.title, durationMinutes: l.durationMinutes, preview: l.preview, hasVideo: l.hasVideo, locked: !l.preview }))
      })) });
    }

    if (action === 'lesson-list') {
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      if (!courseId) throw fail(400, 'Choose a course.');
      const isAdmin = String(user.email).toLowerCase() === String(process.env.LMS_ADMIN_EMAIL || 'bddayma12@gmail.com').toLowerCase() && user.firebase?.sign_in_provider === 'password';
      const activeEnrollment = isAdmin ? null : await hasActiveEnrollment(user.uid, courseId);
      const hasAccess = isAdmin || Boolean(activeEnrollment);
      const course = await findCourse(courseId);
      if (!course) throw fail(404, 'Course not found.');
      const content = await getContent(courseId);
      const progress = activeEnrollment ? await col('studentProgress').where('enrollmentId', '==', activeEnrollment.id).get() : { docs: [] };
      const completed = new Set(progress.docs.filter(p => p.data().completed === true).map(p => p.data().lessonId));
      const modules = content.map(m => Object.assign({}, m, { lessons: m.lessons.map(l => {
        const locked = !hasAccess && !l.preview;
        const lesson = Object.assign({}, l, { locked, completed: completed.has(l.id) });
        if (locked) { lesson.notes = ''; lesson.assignment = ''; lesson.resourceUrl = ''; }
        return lesson;
      }) }));
      return response(event, 200, {
        ok: true, enrolled: hasAccess,
        lastLessonId: activeEnrollment ? String(activeEnrollment.data.lastLessonId || '') : '',
        course: publicCourse(course.id, course.data, course.source), modules
      });
    }

    if (action === 'lesson-playback') {
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      const moduleId = clean(body.moduleId, 120);
      const lessonId = clean(body.lessonId, 120);
      if (!courseId || !moduleId || !lessonId) throw fail(400, 'Choose a course lesson.');
      const isAdmin = String(user.email).toLowerCase() === String(process.env.LMS_ADMIN_EMAIL || 'bddayma12@gmail.com').toLowerCase() && user.firebase?.sign_in_provider === 'password';
      const lessonSnap = await col('lmsCourseContent').doc(courseId).collection('modules').doc(moduleId).collection('lessons').doc(lessonId).get();
      if (!lessonSnap.exists || lessonSnap.data().published === false) throw fail(404, 'Published lesson not found.');
      const lesson = lessonSnap.data();
      // Free demo lessons are open to any signed-in, verified student; everything else needs an active enrollment.
      if (!isAdmin && lesson.preview !== true && !await hasActiveEnrollment(user.uid, courseId)) {
        throw fail(403, 'Enroll in this course to unlock this lesson.');
      }
      if (lesson.videoProvider === 'youtube' && YT_ID.test(String(lesson.youtubeId || ''))) {
        // Unlisted YouTube video: the ID is released only after login + enrollment (or free-demo) checks.
        return response(event, 200, {
          ok: true, provider: 'youtube',
          playbackUrl: 'https://www.youtube-nocookie.com/embed/' + lesson.youtubeId + '?rel=0&modestbranding=1&playsinline=1'
        });
      }
      const videoUid = clean(lesson.videoUid, 80);
      if (!videoUid || lesson.videoProvider !== 'cloudflare-stream') throw fail(409, 'This lesson must be re-uploaded to secure video hosting before it can play.');
      const video = await streamApi('/' + encodeURIComponent(videoUid));
      if (video.requireSignedURLs !== true) throw fail(503, 'This video is not protected by signed playback. Ask the admin to re-upload it.');
      if (video.readyToStream !== true) throw fail(409, 'This lesson is still being prepared. Please try again in a minute.');
      const tokenResult = await streamApi('/' + encodeURIComponent(videoUid) + '/token', {
        method: 'POST',
        body: {
          exp: Math.floor(Date.now() / 1000) + Math.max(20 * 60, Math.min(4 * 60 * 60, (Number(lesson.durationMinutes || 30) + 15) * 60)),
          downloadable: false
        }
      });
      const token = clean(tokenResult.token, 4096);
      if (!token) throw fail(502, 'Secure video provider did not return a playback token.');
      const { customerHost } = streamConfig();
      return response(event, 200, {
        ok: true,
        playbackUrl: 'https://' + customerHost + '/' + encodeURIComponent(token) + '/iframe'
      });
    }

    if (action === 'track-lesson') {
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      const lessonId = clean(body.lessonId, 120);
      const enrollment = await hasActiveEnrollment(user.uid, courseId);
      if (!enrollment) throw fail(403, 'An active enrollment is required.');
      const modules = await col('lmsCourseContent').doc(courseId).collection('modules').get();
      let exists = false;
      for (const moduleDoc of modules.docs) {
        const snap = await moduleDoc.ref.collection('lessons').doc(lessonId).get();
        if (snap.exists && snap.data().published !== false) { exists = true; break; }
      }
      if (!exists) throw fail(404, 'Lesson not found.');
      await col('enrollments').doc(enrollment.id).set({ lastLessonId: lessonId, updatedAt: now() }, { merge: true });
      return response(event, 200, { ok: true });
    }

    if (action === 'mark-progress') {
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      const lessonId = clean(body.lessonId, 120);
      if (!courseId || !lessonId) throw fail(400, 'Choose a lesson.');
      const enrollment = await hasActiveEnrollment(user.uid, courseId);
      if (!enrollment) throw fail(403, 'An active enrollment is required.');
      const modules = await col('lmsCourseContent').doc(courseId).collection('modules').get();
      let lessonRef = null;
      for (const moduleDoc of modules.docs) {
        const candidate = moduleDoc.ref.collection('lessons').doc(lessonId);
        const lessonSnap = await candidate.get();
        if (lessonSnap.exists) { lessonRef = candidate; break; }
      }
      if (!lessonRef) throw fail(404, 'Lesson not found.');
      const progressId = crypto.createHash('sha256').update(user.uid + ':' + courseId + ':' + lessonId).digest('hex').slice(0, 40);
      const progressRef = col('studentProgress').doc(progressId);
      const enrollmentRef = col('enrollments').doc(enrollment.id);
      await db().runTransaction(async tx => {
        const [progressSnap, enrollmentSnap] = await Promise.all([tx.get(progressRef), tx.get(enrollmentRef)]);
        if (!enrollmentSnap.exists || enrollmentSnap.data().status !== 'active') throw fail(403, 'Your enrollment is no longer active.');
        if (!progressSnap.exists || progressSnap.data().completed !== true) {
          tx.set(progressRef, {
            uid: user.uid, courseId, enrollmentId: enrollment.id, lessonId,
            completed: true, completedAt: now(), updatedAt: now()
          }, { merge: true });
          tx.update(enrollmentRef, {
            completedLessons: admin.firestore.FieldValue.increment(1),
            lastLessonId: lessonId, updatedAt: now()
          });
        } else {
          tx.update(enrollmentRef, { lastLessonId: lessonId, updatedAt: now() });
        }
      });
      return response(event, 200, { ok: true });
    }

    if (action === 'admin-dashboard') {
      await requireAdmin(event);
      return response(event, 200, Object.assign({ ok: true }, await adminDashboard()));
    }

    if (action === 'import-legacy-courses') {
      const actor = await requireAdmin(event);
      const existing = await col('lmsCourses').limit(1).get();
      if (!existing.empty) throw fail(409, 'The LMS catalog already has courses. Import was stopped to avoid duplicates.');
      const legacy = await db().collection('courses').get();
      const batch = db().batch();
      legacy.docs.forEach(d => {
        const data = d.data();
        const amount = parseMoneyPaise(data);
        batch.set(col('lmsCourses').doc(d.id), Object.assign({}, data, {
          title: clean(data.title || data.name, 140), pricePaise: amount,
          originalPricePaise: amount, status: 'draft', importedFrom: 'courses', updatedAt: now(), createdAt: now()
        }));
      });
      if (legacy.docs.length) await batch.commit();
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'import-legacy-courses', imported: legacy.docs.length, createdAt: now() });
      return response(event, 200, { ok: true, imported: legacy.docs.length });
    }

    if (action === 'save-course') {
      const actor = await requireAdmin(event);
      const title = clean(body.title, 140);
      const description = clean(body.description, 1600);
      const pricePaise = Math.round(Number(body.pricePaise));
      const originalPricePaise = Math.round(Number(body.originalPricePaise || body.pricePaise));
      if (title.length < 3 || description.length < 10 || !Number.isFinite(pricePaise) || pricePaise < 0 || !Number.isFinite(originalPricePaise) || originalPricePaise < pricePaise) {
        throw fail(400, 'Enter a course title, description and valid prices.');
      }
      const courseId = slug(body.courseId || title) || slug(title);
      if (!courseId) throw fail(400, 'Course ID could not be created.');
      const ref = col('lmsCourses').doc(courseId);
      const data = {
        title, name: title, description,
        shortDescription: clean(body.shortDescription || description, 260),
        category: clean(body.category || 'Spoken English', 80),
        level: clean(body.level || 'Beginner', 40),
        language: clean(body.language || 'English', 60),
        duration: clean(body.duration, 80),
        startDate: clean(body.startDate, 24),
        endDate: clean(body.endDate, 24),
        enrollmentDeadline: clean(body.enrollmentDeadline, 24),
        instructorName: clean(body.instructorName || 'Englishmates', 100),
        instructorPhoto: clean(body.instructorPhoto, 500),
        thumbnailUrl: clean(body.thumbnailUrl, 700),
        pricePaise, originalPricePaise,
        fee: '₹' + (pricePaise / 100).toLocaleString('en-IN'),
        features: Array.isArray(body.features) ? body.features.map(x => clean(x, 160)).slice(0, 20) : [],
        outcomes: Array.isArray(body.outcomes) ? body.outcomes.map(x => clean(x, 200)).slice(0, 20) : [],
        syllabus: Array.isArray(body.syllabus) ? body.syllabus.map(x => clean(x, 240)).slice(0, 30) : [],
        requirements: clean(body.requirements, 800),
        faqs: Array.isArray(body.faqs) ? body.faqs.slice(0, 12).map(x => ({ question: clean(x.question, 180), answer: clean(x.answer, 600) })) : [],
        demoVideoId: clean(body.demoVideoId, 20),
        popularity: Math.max(0, Number(body.popularity || 0)),
        status: body.status === 'published' ? 'published' : 'draft',
        order: Math.max(1, Number(body.order || 999)),
        updatedAt: now()
      };
      const old = await ref.get();
      if (!old.exists) data.createdAt = now();
      await ref.set(data, { merge: true });
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'save-course', courseId, status: data.status, createdAt: now() });
      return response(event, 200, { ok: true, course: Object.assign({ id: courseId }, data) });
    }

    if (action === 'archive-course') {
      const actor = await requireAdmin(event);
      const courseId = clean(body.courseId, 120);
      if (!courseId) throw fail(400, 'Course ID is required.');
      await col('lmsCourses').doc(courseId).set({ status: 'archived', updatedAt: now() }, { merge: true });
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'archive-course', courseId, createdAt: now() });
      return response(event, 200, { ok: true });
    }

    if (action === 'create-stream-upload') {
      const actor = await requireAdmin(event);
      const origins = streamAllowedOrigins();
      if (!origins.length) throw fail(503, 'Netlify must provide the site URL before secure video uploads can be enabled.');
      const minutes = Number(body.durationMinutes || 0);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw fail(400, 'Enter a lesson length from 1 to 180 minutes.');
      const created = await streamApi('/direct_upload', {
        method: 'POST',
        body: {
          maxDurationSeconds: Math.min(10800, Math.round(minutes * 60 + 120)),
          expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          requireSignedURLs: true,
          allowedOrigins: origins
        }
      });
      const uid = clean(created.uid, 80);
      const uploadURL = clean(created.uploadURL, 500);
      if (!/^[a-f0-9]{24,64}$/i.test(uid) || !uploadURL.startsWith('https://upload.videodelivery.net/')) {
        throw fail(502, 'Secure video provider returned an invalid upload session.');
      }
      await col('lmsVideoUploads').doc(uid).set({
        uid, creatorUid: actor.uid, allowedOrigins: origins,
        createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
      return response(event, 200, { ok: true, uid, uploadURL });
    }

    if (action === 'save-lesson') {
      const actor = await requireAdmin(event);
      const courseId = clean(body.courseId, 120);
      const moduleTitle = clean(body.moduleTitle, 120) || 'Course videos';
      const title = clean(body.title, 180);
      const description = clean(body.description, 1200);
      const youtubeId = body.youtubeUrl || body.youtubeId ? youtubeIdFrom(body.youtubeUrl || body.youtubeId) : '';
      if ((body.youtubeUrl || body.youtubeId) && !youtubeId) throw fail(400, 'That is not a valid YouTube link.');
      const videoUid = youtubeId ? '' : clean(body.videoUid, 80);
      if (!courseId || moduleTitle.length < 2 || title.length < 2 || (!youtubeId && !/^[a-f0-9]{24,64}$/i.test(videoUid))) {
        throw fail(400, 'Add a YouTube link or upload a secure course video, then enter the course and lesson title.');
      }
      const courseSnap = await col('lmsCourses').doc(courseId).get();
      if (!courseSnap.exists) throw fail(404, 'Save or import this LMS course before adding lessons.');
      const pendingRef = youtubeId ? null : col('lmsVideoUploads').doc(videoUid);
      if (pendingRef) {
        const pendingSnap = await pendingRef.get();
        const pending = pendingSnap.exists ? pendingSnap.data() : null;
        if (!pending || pending.creatorUid !== actor.uid || Date.parse(pending.expiresAt || '') < Date.now()) {
          throw fail(403, 'This secure upload expired or was not created by your admin session. Upload the video again.');
        }
      }
      const moduleId = slug(body.moduleId || moduleTitle);
      const moduleRef = col('lmsCourseContent').doc(courseId).collection('modules').doc(moduleId);
      await moduleRef.set({ title: moduleTitle, order: Math.max(1, Number(body.moduleOrder || 1)), updatedAt: now() }, { merge: true });
      // Lesson number: use the one given, otherwise add after the last lesson in this module.
      let lessonOrder = Math.round(Number(body.order));
      if (!Number.isFinite(lessonOrder) || lessonOrder < 1) {
        const existing = await moduleRef.collection('lessons').get();
        lessonOrder = existing.docs.reduce((max, d) => Math.max(max, Number(d.data().order || 0)), 0) + 1;
      }
      const lessonId = body.lessonId ? slug(body.lessonId) : (slug(title) + '-' + lessonOrder).slice(0, 80);
      await moduleRef.collection('lessons').doc(lessonId).set({
        title, description,
        videoUid: youtubeId ? null : videoUid,
        videoProvider: youtubeId ? 'youtube' : 'cloudflare-stream',
        youtubeId: youtubeId || null,
        durationMinutes: youtubeId
          ? Math.max(0, Math.min(180, Math.round(Number(body.durationMinutes || 0))))
          : Math.max(1, Math.min(180, Number(body.durationMinutes || 1))),
        order: lessonOrder,
        preview: body.preview === true, published: body.published !== false,
        notes: clean(body.notes, 3000), resourceUrl: clean(body.resourceUrl, 700), assignment: clean(body.assignment, 1600), updatedAt: now()
      }, { merge: true });
      if (pendingRef) await pendingRef.delete();
      const { lectureCount } = await recountCourse(courseId);
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'save-lesson', courseId, moduleId, lessonId, videoProvider: youtubeId ? 'youtube' : 'cloudflare-stream', published: body.published !== false, createdAt: now() });
      return response(event, 200, { ok: true, moduleId, lessonId, order: lessonOrder, lectureCount });
    }
    if (action === 'save-course-files') {
      // Admin uploads the file straight to Firebase Storage from the browser, then records it here.
      const actor = await requireAdmin(event);
      const courseId = slug(body.courseId);
      if (!courseId) throw fail(400, 'Choose a course.');
      const ref = col('lmsCourses').doc(courseId);
      const courseSnap = await ref.get();
      if (!courseSnap.exists) throw fail(404, 'Save the course before adding files.');
      const current = (courseSnap.data().materials) || {};
      const next = Object.assign({}, current);
      const bucket = admin.storage().bucket();
      const toDelete = [];
      for (const kind of MATERIAL_KINDS) {
        if (!(kind in (body.files || {}))) continue;
        const incoming = body.files[kind];
        if (incoming === null) { if (current[kind] && current[kind].path) toDelete.push(current[kind].path); delete next[kind]; continue; }
        const path = clean(incoming && incoming.path, 300);
        if (!path.startsWith(materialsRoot + '/' + courseId + '/' + kind + '/') || path.includes('..')) throw fail(400, 'Invalid file location.');
        const [exists] = await bucket.file(path).exists();
        if (!exists) throw fail(400, 'The uploaded file could not be found. Please upload it again.');
        const [meta] = await bucket.file(path).getMetadata();
        if (Number(meta.size) > MATERIAL_MAX_BYTES) { await bucket.file(path).delete().catch(() => {}); throw fail(413, 'File must be 25 MB or smaller.'); }
        if (current[kind] && current[kind].path && current[kind].path !== path) toDelete.push(current[kind].path);
        next[kind] = { path, name: clean(incoming.name, 140) || 'file', size: Number(meta.size || 0), updatedAt: new Date().toISOString() };
      }
      await ref.set({ materials: next, updatedAt: now() }, { merge: true });
      await Promise.all(toDelete.map(p => bucket.file(p).delete().catch(() => {})));
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'save-course-files', courseId, createdAt: now() });
      return response(event, 200, { ok: true, materials: { workbook: materialMeta(next.workbook), pdf: materialMeta(next.pdf) } });
    }

    if (action === 'course-materials') {
      // Workbook / PDF: only for an enrolled student (or the admin). Links expire in 20 minutes.
      const user = await userFromEvent(event);
      const courseId = clean(body.courseId, 120);
      if (!courseId) throw fail(400, 'Choose a course.');
      const isAdmin = String(user.email).toLowerCase() === String(process.env.LMS_ADMIN_EMAIL || 'bddayma12@gmail.com').toLowerCase() && user.firebase?.sign_in_provider === 'password';
      if (!isAdmin && !await hasActiveEnrollment(user.uid, courseId)) throw fail(403, 'Enroll in this course to open its practice files.');
      const found = await col('lmsCourses').doc(courseId).get();
      const materials = found.exists ? (found.data().materials || {}) : {};
      const bucket = admin.storage().bucket();
      const files = {};
      for (const kind of MATERIAL_KINDS) {
        const f = materials[kind];
        if (!f || !f.path || !String(f.path).startsWith(materialsRoot + '/' + courseId + '/')) continue;
        const [url] = await bucket.file(f.path).getSignedUrl({
          action: 'read', expires: Date.now() + 20 * 60 * 1000,
          responseDisposition: 'inline; filename="' + String(f.name || kind).replace(/[^\w.\- ]/g, '_') + '"'
        });
        files[kind] = { name: f.name, size: f.size, url };
      }
      return response(event, 200, { ok: true, files });
    }

    if (action === 'admin-lessons') {
      await requireAdmin(event);
      const courseId = clean(body.courseId, 120);
      if (!courseId) throw fail(400, 'Choose a course.');
      return response(event, 200, { ok: true, modules: await getContent(courseId) });
    }

    if (action === 'set-lesson-preview') {
      const actor = await requireAdmin(event);
      const courseId = clean(body.courseId, 120);
      const moduleId = clean(body.moduleId, 120);
      const lessonId = clean(body.lessonId, 120);
      if (!courseId || !moduleId || !lessonId) throw fail(400, 'Choose a lesson.');
      const ref = col('lmsCourseContent').doc(courseId).collection('modules').doc(moduleId).collection('lessons').doc(lessonId);
      const snap = await ref.get();
      if (!snap.exists) throw fail(404, 'Lesson not found.');
      await ref.set({ preview: body.preview === true, updatedAt: now() }, { merge: true });
      await recountCourse(courseId);
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'set-lesson-preview', courseId, moduleId, lessonId, preview: body.preview === true, createdAt: now() });
      return response(event, 200, { ok: true, preview: body.preview === true });
    }

    if (action === 'publish-announcement') {
      const actor = await requireAdmin(event);
      const courseId = clean(body.courseId, 120);
      const title = clean(body.title, 140);
      const message = clean(body.message, 600);
      const courseSnap = await col('lmsCourses').doc(courseId).get();
      if (!courseSnap.exists || courseSnap.data().status !== 'published') throw fail(404, 'Publish the course before announcing it.');
      if (title.length < 3 || message.length < 5) throw fail(400, 'Enter an announcement title and message.');
      const enrolled = await col('enrollments').where('courseId', '==', courseId).limit(500).get();
      const recipients = enrolled.docs.filter(d => d.data().status === 'active');
      for (let start = 0; start < recipients.length; start += 450) {
        const batch = db().batch();
        recipients.slice(start, start + 450).forEach(d => {
          batch.set(col('userNotifications').doc(), {
            uid: d.data().uid, type: 'announcement', courseId, courseName: d.data().courseName,
            title, message, read: false, createdAt: now()
          });
        });
        await batch.commit();
      }
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'publish-announcement', courseId, recipientCount: recipients.length, createdAt: now() });
      return response(event, 200, { ok: true, recipients: recipients.length });
    }

    if (action === 'set-enrollment-status') {
      const actor = await requireAdmin(event);
      const enrollmentId = clean(body.enrollmentId, 120);
      const status = body.status === 'suspended' ? 'suspended' : body.status === 'active' ? 'active' : '';
      if (!enrollmentId || !status) throw fail(400, 'Choose active or suspended.');
      const ref = col('enrollments').doc(enrollmentId);
      const snap = await ref.get();
      if (!snap.exists) throw fail(404, 'Enrollment not found.');
      const e = snap.data();
      if (status === 'active' && !['paid', 'not_required'].includes(e.paymentStatus)) {
        throw fail(409, 'Confirm payment before restoring course access.');
      }
      await ref.set({ status, updatedAt: now(), reviewedBy: actor.email }, { merge: true });
      await col('adminLogs').add({ actorUid: actor.uid, actorEmail: actor.email, action: 'set-enrollment-status', enrollmentId, status, createdAt: now() });
      return response(event, 200, { ok: true });
    }

    if (action === 'review-payment') {
      const actor = await requireAdmin(event);
      const paymentId = clean(body.paymentId, 120);
      const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : '';
      if (!paymentId || !decision) throw fail(400, 'Choose approve or reject.');
      const paymentRef = col('payments').doc(paymentId);
      let result;
      await db().runTransaction(async tx => {
        const paymentSnap = await tx.get(paymentRef);
        if (!paymentSnap.exists || paymentSnap.data().status !== 'under_review') throw fail(409, 'This payment is not awaiting review.');
        const payment = paymentSnap.data();
        const enrollmentRef = col('enrollments').doc(payment.enrollmentId);
        const enrollmentSnap = await tx.get(enrollmentRef);
        if (!enrollmentSnap.exists) throw fail(404, 'Enrollment not found.');
        const approved = decision === 'approve';
        const nextPayment = approved ? 'paid' : 'rejected';
        tx.update(paymentRef, {
          status: nextPayment, reviewedBy: actor.email, reviewedAt: now(), reviewNote: clean(body.note, 500), updatedAt: now()
        });
        tx.update(enrollmentRef, {
          paymentStatus: nextPayment,
          status: approved ? 'active' : 'pending_payment',
          reviewedBy: actor.email, reviewedAt: now(), updatedAt: now()
        });
        const notificationRef = col('userNotifications').doc();
        tx.set(notificationRef, {
          uid: enrollmentSnap.data().uid, type: 'payment',
          title: approved ? 'Payment approved' : 'Payment needs attention',
          message: approved ? 'Your payment for ' + enrollmentSnap.data().courseName + ' was approved. Course access is now active.' : 'Your payment for ' + enrollmentSnap.data().courseName + ' was not approved. You can submit a new payment proof.',
          read: false, createdAt: now()
        });
        result = { enrollmentId: payment.enrollmentId, paymentStatus: nextPayment };
        const auditRef = col('adminLogs').doc();
        tx.set(auditRef, {
          actorUid: actor.uid, actorEmail: actor.email, action: 'review-payment',
          paymentId, enrollmentId: payment.enrollmentId, decision, createdAt: now()
        });
      });
      return response(event, 200, { ok: true, result });
    }

    return response(event, 400, { ok: false, error: 'Unknown LMS action.' });
  } catch (error) {
    const status = Number(error.statusCode || 500);
    if (status >= 500) console.error('LMS API failure:', error && error.message);
    return response(event, status, { ok: false, error: status < 500 ? error.message : 'The LMS request could not be completed.' });
  }
}

exports.handler = handle;
