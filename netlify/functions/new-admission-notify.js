const admin = require('firebase-admin');

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return {statusCode:405,body:'Method not allowed'};
  try {
    initFirebase();
    const body = JSON.parse(event.body || '{}');
    const {name='New student', course='Course', fee='', admissionDate=''} = body;
    const snap = await admin.firestore().collection('adminDevices').get();
    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return {statusCode:200,body:JSON.stringify({ok:true,sent:0,reason:'no registered admin devices'})};

    const title = 'New Englishmates Admission';
    const messageBody = `${name} joined ${course}${fee ? ` • ${fee}` : ''}`;
    const results = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: messageBody },
      data: { title, body: messageBody, course:String(course), fee:String(fee), admissionDate:String(admissionDate) },
      webpush: { notification: { icon: '/bhagirath-dayma-profile.png', badge: '/bhagirath-dayma-profile.png' }, fcmOptions: { link: '/' } }
    });

    // Remove invalid registration tokens.
    const cleanup = [];
    snap.docs.forEach((doc, i) => {
      const r = results.responses[i];
      if (r && !r.success) {
        const code = r.error && r.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') cleanup.push(doc.ref.delete());
      }
    });
    await Promise.all(cleanup);
    return {statusCode:200,body:JSON.stringify({ok:true,sent:results.successCount,failed:results.failureCount})};
  } catch (err) {
    console.error(err);
    return {statusCode:500,body:JSON.stringify({ok:false,error:err.message})};
  }
};
