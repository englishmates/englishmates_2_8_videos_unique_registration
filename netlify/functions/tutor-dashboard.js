const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('../lib/cors');

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
const GOOGLE_CONNECTIONS = 'tutorGoogleConnections' + suffix;
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.events';
const MAX_INTRO_VIDEO_SECONDS = 60;
function encryptionKey(){const k=process.env.GOOGLE_TOKEN_ENCRYPTION_KEY||'';if(!/^[a-f0-9]{64}$/i.test(k))throw new Error('Google Meet integration is not configured: token encryption key is missing.');return Buffer.from(k,'hex');}
function googleOAuthConfig(){const clientId=clean(process.env.GOOGLE_CLIENT_ID,300),clientSecret=clean(process.env.GOOGLE_CLIENT_SECRET,500),tokenKey=String(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY||'').trim(),redirectUri=String(process.env.GOOGLE_REDIRECT_URI||'').trim().replace(/\/+$/,'');const missing=[];if(!clientId)missing.push('GOOGLE_CLIENT_ID');if(!clientSecret)missing.push('GOOGLE_CLIENT_SECRET');if(!redirectUri)missing.push('GOOGLE_REDIRECT_URI');if(!/^[a-f0-9]{64}$/i.test(tokenKey))missing.push('GOOGLE_TOKEN_ENCRYPTION_KEY (64 hexadecimal characters)');if(missing.length)throw new Error('Google OAuth configuration is incomplete for this deploy. Missing: '+missing.join(', ')+'.');let parsed;try{parsed=new URL(redirectUri);}catch{throw new Error('GOOGLE_REDIRECT_URI must be a valid HTTPS URL.');}if(parsed.protocol!=='https:'||parsed.pathname!=='/.netlify/functions/google-oauth'||parsed.search||parsed.hash)throw new Error('GOOGLE_REDIRECT_URI must exactly end with /.netlify/functions/google-oauth and must not include a query string or trailing slash.');return {clientId,clientSecret,redirectUri};}
function publicDashboardUrl(value){try{const url=new URL(String(value||''));if(url.origin!=='https://englishmates.github.io'||!url.pathname.startsWith('/englishmates_2_8_videos_unique_registration/'))return '';return url.href;}catch{return '';}}
function mediaUrlForTutor(value,uid,label){const url=clean(value,1600);if(!url)return '';try{const parsed=new URL(url),path=decodeURIComponent(parsed.pathname);if(parsed.protocol!=='https:'||parsed.hostname!=='firebasestorage.googleapis.com'||!path.includes('/o/tutor-media/'+uid+'/'))throw new Error();return url;}catch{throw new Error(label+' must be uploaded from your Englishmates profile media form.');}}
function decryptToken(value){const [iv,tag,data]=String(value||'').split('.');const d=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(data,'base64url')),d.final()]).toString();}
async function createMeetEvent(store,tutor,booking,bookingRef){
 const conn=await store.collection(GOOGLE_CONNECTIONS).doc(tutor.id).get();if(!conn.exists||!conn.data().refreshToken)throw new Error('Connect your Google Calendar before confirming bookings.');
 const refreshToken=decryptToken(conn.data().refreshToken);
 const oauth=googleOAuthConfig();
 const tokenRes=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:oauth.clientId,client_secret:oauth.clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'})});
 const tokenData=await tokenRes.json();if(!tokenRes.ok||!tokenData.access_token)throw new Error('Google authorization expired. Reconnect Google Calendar.');
 const eventId='em'+crypto.createHash('sha256').update(bookingRef.id).digest('hex').slice(0,40);
 const start=new Date(booking.date+'T'+booking.startTime+':00+05:30'),end=new Date(booking.date+'T'+booking.endTime+':00+05:30');
 const payload={id:eventId,summary:'Englishmates 30-minute session with '+clean(booking.studentName,90),description:'Englishmates tutoring session. Booking ID: '+bookingRef.id, start:{dateTime:start.toISOString(),timeZone:'Asia/Kolkata'},end:{dateTime:end.toISOString(),timeZone:'Asia/Kolkata'},attendees:[{email:booking.email}],conferenceData:{createRequest:{requestId:eventId,conferenceSolutionKey:{type:'hangoutsMeet'}}}};
 let eventRes=await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',{method:'POST',headers:{Authorization:'Bearer '+tokenData.access_token,'Content-Type':'application/json'},body:JSON.stringify(payload)});
 let eventData=await eventRes.json();if(eventRes.status===409){eventRes=await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+eventId,{headers:{Authorization:'Bearer '+tokenData.access_token}});eventData=await eventRes.json();}
 if(!eventRes.ok)throw new Error('Google Calendar could not create the meeting. Reconnect your Google account and try again.');
 let meetLink=eventData.hangoutLink||eventData.conferenceData?.entryPoints?.find(x=>x.entryPointType==='video')?.uri;
 for(let attempt=0;!meetLink&&attempt<5;attempt++){
  await new Promise(resolve=>setTimeout(resolve,1000));
  const poll=await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+eventId,{headers:{Authorization:'Bearer '+tokenData.access_token}});
  if(poll.ok){eventData=await poll.json();meetLink=eventData.hangoutLink||eventData.conferenceData?.entryPoints?.find(x=>x.entryPointType==='video')?.uri;}
 }
 if(!meetLink)throw new Error('Google Calendar has not finished generating the Meet link. Please retry in a moment.');
 return {meetLink,googleEventId:eventData.id};
}
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
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data(), uid: decoded.uid, email: decoded.email.toLowerCase() };
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
        photoUrl: clean(tutor.photoUrl, 1600),
        introVideoUrl: clean(tutor.introVideoUrl, 1600),
        introVideoDurationSeconds: Math.min(MAX_INTRO_VIDEO_SECONDS, Math.max(0, Number(tutor.introVideoDurationSeconds) || 0)),
        schedule: scheduleDoc.exists ? scheduleDoc.data().schedule || {} : {},
        blocks,
        bookings,
        googleConnected: (await store.collection(GOOGLE_CONNECTIONS).doc(tutor.id).get()).exists
      });
    }
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');

    if (body.action === 'connect-google') {
      const oauth=googleOAuthConfig();
      const state=crypto.randomBytes(32).toString('hex');
      await store.collection('googleOAuthStates'+suffix).doc(state).set({tutorId:tutor.id,returnUrl:publicDashboardUrl(body.returnUrl),createdAt:admin.firestore.FieldValue.serverTimestamp(),expiresAt:Date.now()+10*60*1000});
      const params=new URLSearchParams({client_id:oauth.clientId,redirect_uri:oauth.redirectUri,response_type:'code',scope:GOOGLE_SCOPES,access_type:'offline',prompt:'consent',include_granted_scopes:'true',state});
      return reply(200,{ok:true,authUrl:'https://accounts.google.com/o/oauth2/v2/auth?'+params.toString()});
    }

    if (body.action === 'update-profile-media') {
      const hasPhoto=Object.prototype.hasOwnProperty.call(body,'photoUrl'),hasVideo=Object.prototype.hasOwnProperty.call(body,'introVideoUrl');
      if(!hasPhoto&&!hasVideo)return reply(400,{ok:false,error:'Choose a profile photo or intro video first.'});
      const patch={updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:tutor.uid};
      if(hasPhoto)patch.photoUrl=mediaUrlForTutor(body.photoUrl,tutor.uid,'Profile photo');
      if(hasVideo){const seconds=Number(body.introVideoDurationSeconds);if(!Number.isFinite(seconds)||seconds<=0||seconds>MAX_INTRO_VIDEO_SECONDS)return reply(400,{ok:false,error:'Your intro video must be no longer than 60 seconds.'});patch.introVideoUrl=mediaUrlForTutor(body.introVideoUrl,tutor.uid,'Intro video');patch.introVideoDurationSeconds=Math.round(seconds*10)/10;}
      await store.collection(TUTORS).doc(tutor.id).set(patch,{merge:true});
      return reply(200,{ok:true,message:'Tutor profile media saved.'});
    }

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

    if (body.action === 'update-booking-status') {
      const bookingId = clean(body.bookingId, 180);
      const status = clean(body.status, 20).toLowerCase();
      if (!bookingId || !['confirmed','rejected','cancelled'].includes(status)) return reply(400, { ok: false, error: 'Invalid booking update.' });
      const ref = store.collection(BOOKINGS).doc(bookingId);
      const booking = await ref.get();
      if (!booking.exists || booking.data().tutorId !== tutor.id) return reply(404, { ok: false, error: 'Booking request not found.' });
      if(status==='confirmed'){
        const current=booking.data();
        if(current.status==='confirmed'&&current.meetLink)return reply(200,{ok:true,message:'Booking is already confirmed.',meetLink:current.meetLink});
        if(current.status!=='pending')return reply(409,{ok:false,error:'Only pending requests can be confirmed.'});
        const meeting=await createMeetEvent(store,tutor,current,ref);
        await ref.update({status:'confirmed',meetLink:meeting.meetLink,googleEventId:meeting.googleEventId,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
        return reply(200,{ok:true,message:'Booking confirmed and Google Meet created.',meetLink:meeting.meetLink});
      }
      await ref.update({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return reply(200, { ok: true, message: 'Booking status updated.' });
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

const handler = exports.handler;
exports.handler = async event => {
 if(event.httpMethod==='OPTIONS')return cors.options(event);
 const response=await handler(event);
 return {...response,headers:{...(response.headers||{}),...cors.headers(event)}};
};
