'use strict';
const crypto = require('crypto');
const { admin, COLLECTIONS, authenticatedUser, clean, httpError, ownProfile, reply, requireCommunityLearner, requireEligible, store } = require('../lib/calling');
const cors = require('../lib/cors');

const PRICE_PAISE = 29900;
const PASS_DAYS = 30;
const FREE_SECONDS = 600;
function now() { return Date.now(); }
function asMillis(value) { return value && typeof value.toMillis === 'function' ? value.toMillis() : Number(value || 0); }
function istDay() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const data = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return data.year + '-' + data.month + '-' + data.day;
}
function safeEqualHex(actual, expected) {
  if (!/^[a-f0-9]{64}$/i.test(actual || '') || !/^[a-f0-9]{64}$/i.test(expected || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function passSummary(profile) {
  const end = asMillis(profile.subscriptionEndsAt);
  return { active: end > now(), endsAt: end ? new Date(end).toISOString() : null };
}
async function extendPass(db, profileRef, profile) {
  const start = Math.max(now(), asMillis(profile.subscriptionEndsAt));
  const end = start + PASS_DAYS * 24 * 60 * 60 * 1000;
  await profileRef.update({ subscriptionEndsAt: admin.firestore.Timestamp.fromMillis(end), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return end;
}
async function getSummary(db, user, profile) {
  const day = istDay();
  const usage = await db.collection(COLLECTIONS.dailyUsage).doc(user.uid + '_' + day).get();
  const used = Math.min(FREE_SECONDS, Number(usage.data()?.seconds || 0));
  const pass = passSummary(profile);
  const paymentDocs = await db.collection(COLLECTIONS.subscriptionPayments).where('uid', '==', user.uid).limit(30).get();
  const pendingReview = paymentDocs.docs.some(doc => doc.data().status === 'under_review');
  return { ok: true, day, freeDailySeconds: FREE_SECONDS, usedSeconds: used, remainingSeconds: pass.active ? FREE_SECONDS : Math.max(0, FREE_SECONDS - used), paidActive: pass.active, subscriptionEndsAt: pass.endsAt, pendingReview };
}
async function razorpayRequest(path, method, body) {
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) throw httpError(503, 'Razorpay is not configured on this preview yet. Use UPI review or add the two Razorpay Netlify variables.');
  const response = await fetch('https://api.razorpay.com/v1' + path, {
    method: method || 'GET',
    headers: {
      Authorization: 'Basic ' + Buffer.from(key + ':' + secret).toString('base64'),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(502, data.error?.description || 'Razorpay could not complete this request.');
  return data;
}
exports.handler = async event => {
  try {
    const db = store();
    const user = await authenticatedUser(event);
    requireCommunityLearner(user);
    const own = await ownProfile(db, user);
    requireEligible(own.data);
    if (event.httpMethod === 'GET') return reply(200, await getSummary(db, user, own.data));
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');
    const action = clean(body.action, 50);
    if (action === 'create-razorpay-order') {
      const order = await razorpayRequest('/orders', 'POST', {
        amount: PRICE_PAISE, currency: 'INR',
        receipt: 'cm-' + user.uid.slice(0, 12) + '-' + now(),
        notes: { uid: user.uid, product: 'calling-community-30-day-pass' }
      });
      await db.collection(COLLECTIONS.subscriptionPayments).doc(order.id).set({
        uid: user.uid, provider: 'razorpay', orderId: order.id, amountPaise: PRICE_PAISE,
        currency: 'INR', status: 'created', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return reply(201, { ok: true, keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency, email: user.email });
    }
    if (action === 'verify-razorpay-payment') {
      const orderId = clean(body.razorpay_order_id, 100);
      const paymentId = clean(body.razorpay_payment_id, 100);
      const signature = clean(body.razorpay_signature, 100);
      if (!orderId || !paymentId || !signature) throw httpError(400, 'Payment verification details are incomplete.');
      const paymentRef = db.collection(COLLECTIONS.subscriptionPayments).doc(orderId);
      const saved = await paymentRef.get();
      if (!saved.exists || saved.data().uid !== user.uid || saved.data().provider !== 'razorpay' || saved.data().amountPaise !== PRICE_PAISE) throw httpError(403, 'This payment order does not belong to your account.');
      const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(orderId + '|' + paymentId).digest('hex');
      if (!safeEqualHex(signature, expected)) throw httpError(400, 'Razorpay signature verification failed.');
      const remote = await razorpayRequest('/payments/' + encodeURIComponent(paymentId), 'GET');
      if (remote.order_id !== orderId || Number(remote.amount) !== PRICE_PAISE || remote.currency !== 'INR' || remote.status !== 'captured') throw httpError(409, 'Razorpay has not confirmed a captured ₹299 payment for this order.');
      const end = await db.runTransaction(async tx => {
        const [paymentSnap, profileSnap] = await Promise.all([tx.get(paymentRef), tx.get(own.ref)]);
        if (!paymentSnap.exists || paymentSnap.data().uid !== user.uid) throw httpError(403, 'Payment order not found.');
        if (paymentSnap.data().status === 'approved') return asMillis(profileSnap.data().subscriptionEndsAt);
        const start = Math.max(now(), asMillis(profileSnap.data().subscriptionEndsAt));
        const nextEnd = start + PASS_DAYS * 24 * 60 * 60 * 1000;
        tx.update(paymentRef, { status: 'approved', paymentId, verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.update(own.ref, { subscriptionEndsAt: admin.firestore.Timestamp.fromMillis(nextEnd), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        return nextEnd;
      });
      return reply(200, { ok: true, subscriptionEndsAt: new Date(end).toISOString(), message: 'Payment verified. Your Calling Community pass is active for 30 days.' });
    }
    if (action === 'submit-upi-proof') {
      const utr = clean(body.utr, 48).replace(/\s+/g, '');
      if (!/^[a-zA-Z0-9]{8,40}$/.test(utr)) throw httpError(400, 'Enter the UPI transaction reference shown by your payment app.');
      const duplicate = await db.collection(COLLECTIONS.subscriptionPayments).where('utr', '==', utr).limit(1).get();
      if (!duplicate.empty) throw httpError(409, 'That UPI transaction reference has already been submitted.');
      const id = crypto.createHash('sha256').update(user.uid + '|' + utr).digest('hex');
      await db.collection(COLLECTIONS.subscriptionPayments).doc(id).create({
        uid: user.uid, provider: 'upi', utr, amountPaise: PRICE_PAISE, currency: 'INR',
        status: 'under_review', createdAt: admin.firestore.FieldValue.serverTimestamp()
      }).catch(error => { if (error.code === 6 || error.code === 'already-exists') throw httpError(409, 'This UPI reference was already submitted.'); throw error; });
      return reply(202, { ok: true, pendingReview: true, message: 'UPI reference submitted. Your pass begins after admin verification.' });
    }
    throw httpError(400, 'Unknown billing action.');
  } catch (error) {
    console.error('Calling billing:', error.message);
    return reply(error.status || 500, { ok: false, error: error.message || 'Request failed.' });
  }
};
const handler = exports.handler;
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return cors.options(event);
  const response = await handler(event);
  return { ...response, headers: { ...(response.headers || {}), ...cors.headers(event) } };
};
