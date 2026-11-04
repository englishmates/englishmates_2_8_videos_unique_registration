const admin = require('firebase-admin');
const crypto = require('crypto');
const ADMIN_EMAIL = 'bddayma12@gmail.com';
function db() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Tutor applications are not configured yet.');
    admin.initializeApp({credential: admin.credential.cert(JSON.parse(raw)), projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1'});
  }
  return admin.firestore();
}
const reply=(statusCode,payload)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(payload)});
const clean=(v,n=160)=>String(v||'').trim().replace(/[<>]/g,'').slice(0,n);
const suffix=process.env.CONTEXT==='production'?'':'Preview';
const APPS='tutorApplications'+suffix;
async function adminUser(event){
 const h=event.headers||{}, token=String(h.authorization||h.Authorization||'').replace(/^Bearer\s+/i,'');
 if(!token) throw Object.assign(new Error('Admin sign-in required.'),{status:401});
 const user=await admin.auth().verifyIdToken(token);
 if(!user.email_verified || String(user.email||'').toLowerCase()!==ADMIN_EMAIL) throw Object.assign(new Error('Not authorized.'),{status:403});
 return user;
}
exports.handler=async event=>{
 try{
  const store=db();
  if(event.httpMethod==='POST'){
   const body=JSON.parse(event.body||'{}');
   if(body.action==='apply'){
    const name=clean(body.name,80),email=clean(body.email,160).toLowerCase(),phone=clean(body.phone,10),subjects=clean(body.subjects,180),experience=clean(body.experience,80),bio=clean(body.bio,600);
    if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||!/^\d{10}$/.test(phone)||subjects.length<2||bio.length<20) return reply(400,{ok:false,error:'Please complete all required fields. Use a valid email, 10-digit phone number and a bio of at least 20 characters.'});
    const applicationId='email_'+crypto.createHash('sha256').update(email).digest('hex');
    const ref=store.collection(APPS).doc(applicationId);
    try {
     await ref.create({name,email,phone,subjects,experience,bio,status:'pending',createdAt:admin.firestore.FieldValue.serverTimestamp()});
    } catch (err) {
     if(err.code===6 || err.code==='already-exists') return reply(409,{ok:false,error:'An application with this email already exists. Please contact Englishmates for an update.'});
     throw err;
    }
    return reply(200,{ok:true,message:'Application submitted. Englishmates will review your profile.'});
   }
   await adminUser(event);
   if(body.action==='approve'||body.action==='reject'){
    const id=clean(body.applicationId,140);if(!id)return reply(400,{ok:false,error:'Invalid application.'});
    const ref=store.collection(APPS).doc(id);
    const initial=await ref.get();
    if(!initial.exists||initial.data().status!=='pending') throw new Error('This application is no longer pending.');
    let account=null;
    if(body.action==='approve'){
     account=await admin.auth().getUserByEmail(initial.data().email).catch(()=>null);
     if(!account||!account.emailVerified) throw new Error('Create a Firebase Authentication account for this tutor and verify the email before approval.');
    }
    await store.runTransaction(async tx=>{
     const snap=await tx.get(ref);
     if(!snap.exists||snap.data().status!=='pending') throw new Error('This application is no longer pending.');
     if(body.action==='approve') tx.set(ref,{status:'approved',authUid:account.uid,approvedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
     else tx.set(ref,{status:'rejected',reviewedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    });
    return reply(200,{ok:true,message:body.action==='approve'?'Tutor approved.':'Application rejected.'});
   }
   return reply(400,{ok:false,error:'Unknown action.'});
  }
  if(event.httpMethod==='GET'){
   await adminUser(event);
   const snap=await store.collection(APPS).where('status','==','pending').limit(100).get();
   return reply(200,{ok:true,applications:snap.docs.map(d=>({id:d.id,...d.data(),createdAt:d.data().createdAt?.toDate?.().toISOString()||null}))});
  }
  return reply(405,{ok:false,error:'Method not allowed.'});
 }catch(e){console.error('Tutor applications:',e.message);return reply(e.status||400,{ok:false,error:e.message||'Request failed.'});}
};