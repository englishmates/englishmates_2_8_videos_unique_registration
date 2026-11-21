const admin = require('firebase-admin');
const crypto = require('crypto');

const IS_PRODUCTION = process.env.CONTEXT === 'production';
const suffix = IS_PRODUCTION ? '' : 'Preview';
const PRIMARY_ADMIN_EMAIL = 'bddayma12@gmail.com';
const COLLECTIONS = Object.freeze({
  profiles: `callingProfiles${suffix}`,
  queues: `callingQueues${suffix}`,
  sessions: `callingSessions${suffix}`,
  blocks: `callingBlocks${suffix}`,
  reports: `callingReports${suffix}`,
  audit: `callingModerationAudit${suffix}`,
  limits: `callingRateLimits${suffix}`,
  partnerRequests: `callingPartnerRequests${suffix}`,
  connections: `callingPartnerConnections${suffix}`,
  failures: `callingFailures${suffix}`
});

function store() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw httpError(503, 'Calling Community is not configured yet.');
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1'
    });
  }
  return admin.firestore();
}

function reply(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    },
    body: JSON.stringify(payload)
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function clean(value, max = 120) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function asArray(value, allowed, max = 8) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => clean(item, 40)).filter(item => allowed.includes(item)))].slice(0, max);
}

function iso(value) {
  return value?.toDate?.().toISOString?.() || null;
}

function containsContactDetails(value) {
  const text = String(value || '');
  const digits = text.replace(/\D/g, '');
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) || /0?[6-9]\d{9}/.test(digits);
}

function safeAvatar(value) {
  const text = String(value || '').trim();
  if (text.length <= 30000 && /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(text)) return text;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const allowed = host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com') || host === 'firebasestorage.googleapis.com';
    return url.protocol === 'https:' && allowed ? url.href.slice(0, 1000) : null;
  } catch (_) { return null; }
}

async function authenticatedUser(event) {
  const headers = event.headers || {};
  const token = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw httpError(401, 'Please sign in to use Calling Community.');
  const decoded = await admin.auth().verifyIdToken(token);
  if (!decoded.email || !decoded.email_verified) {
    throw httpError(403, 'Verify your email address before using Calling Community.');
  }
  return { uid: decoded.uid, email: String(decoded.email).toLowerCase(), claims: decoded };
}

async function ownProfile(db, user, required = true) {
  const ref = db.collection(COLLECTIONS.profiles).doc(user.uid);
  const snapshot = await ref.get();
  if (!snapshot.exists && required) throw httpError(404, 'Complete your speaking profile first.');
  return { ref, exists: snapshot.exists, data: snapshot.exists ? snapshot.data() : null };
}

function requireEligible(profile) {
  if (profile.status !== 'approved') throw httpError(403, 'Your community profile must be approved before you can find a partner.');
  if (profile.countryCode !== 'IN' || profile.countryStatus !== 'approved') throw httpError(403, 'India eligibility is still awaiting approval.');
  if (profile.adultConfirmed !== true) throw httpError(403, 'Calling Community is available only to adults aged 18 and above.');
  if (profile.moderationStatus && profile.moderationStatus !== 'active') {
    throw httpError(403, 'Calling Community access is currently unavailable for this account.');
  }
}

function adminAllowed(user) {
  // This is deliberately enforced in the Netlify function, not trusted to the UI.
  return user.email === PRIMARY_ADMIN_EMAIL;
}

function requireAdmin(user) {
  if (!adminAllowed(user)) {
    throw httpError(403, 'Calling Community administrator access is required.');
  }
}

async function consumeLimit(db, uid, action, maximum, intervalMs) {
  const bucket = Math.floor(Date.now() / intervalMs);
  const ref = db.collection(COLLECTIONS.limits).doc(`${uid}_${action}_${bucket}`);
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    const count = Number(existing.data()?.count || 0);
    if (count >= maximum) throw httpError(429, 'Please wait before trying again.');
    transaction.set(ref, {
      uid,
      action,
      count: count + 1,
      expiresAt: Date.now() + intervalMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

function blockId(firstUid, secondUid) {
  return crypto.createHash('sha256').update(`${firstUid}|${secondUid}`).digest('hex');
}

async function areBlocked(db, firstUid, secondUid) {
  const [first, second] = await Promise.all([
    db.collection(COLLECTIONS.blocks).doc(blockId(firstUid, secondUid)).get(),
    db.collection(COLLECTIONS.blocks).doc(blockId(secondUid, firstUid)).get()
  ]);
  return first.exists || second.exists;
}

function publicProfile(profile) {
  const alias = clean(profile.alias, 32);
  return { alias: containsContactDetails(alias) ? 'English learner' : alias || 'English learner', avatarURL: safeAvatar(profile.avatarURL) };
}

function audit(db, actor, action, targetUid, details = {}) {
  return db.collection(COLLECTIONS.audit).add({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action,
    targetUid: targetUid || null,
    details,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

module.exports = {
  admin,
  PRIMARY_ADMIN_EMAIL,
  COLLECTIONS,
  asArray,
  areBlocked,
  audit,
  authenticatedUser,
  blockId,
  clean,
  containsContactDetails,
  consumeLimit,
  httpError,
  iso,
  ownProfile,
  publicProfile,
  reply,
  safeAvatar,
  requireAdmin,
  requireEligible,
  store
};
