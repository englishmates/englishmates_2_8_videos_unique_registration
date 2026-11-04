const admin = require('firebase-admin');
const crypto = require('crypto');
const ADMIN_EMAIL = 'bddayma12@gmail.com';
function db() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Tutor applications are not configured yet.');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1' });
  }
  return admin.firestore();
}
const reply=(statusCode,payload)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(payload)});
const clean=(v,n=160)=>String(v??'').trim().slice(0,n);
const suffix=process.env.CONTEXT==='production'?'':'Preview';
const APPS='tutorApplications'+suffix;
const AUDIT='tutorAdminAudit'+suffix;
const VALID_STATUSES=['pending','approved','rejected','inactive'];
async function adminUser(event){
 const h=event.headers||{},token=String(h.authorization||h.Authorization||'').replace(/^Bearer\\s+/i,'');
 if(!token)throw Object.assign(new Error('Admin sign-in required.'),{status:401});
 const user=await admin.auth().verifyIdToken(token);
 if(!user.email_verified||String(user.email||'').toLowerCase()!==ADMIN_EMAIL)throw Object.assign(new Error('Not authorized.'),{status:403});
 return user;
}
function serialize(doc){const d=doc.data();return {id:doc.id,...d,createdAt:d.createdAt?.toDate?.().toISOString()||null,updatedAt:d.updatedAt?.toDate?.().toISOString()||null,approvedAt:d.approvedAt?.toDate?.().toISOString()||null,reviewedAt:d.reviewedAt?.toDate?.().toISOString()||null,deactivatedAt:d.deactivatedAt?.toDate?.().toISOString()||null};}
async function audit(store,actor,applicationId,action,fromStatus,toStatus,extra={}) {
 await store.collection(AUDIT).add({actorUid:actor.uid,actorEmail:String(actor.email||'').toLowerCase(),applicationId,action,fromStatus:fromStatus||null,toStatus:toStatus||null,details:extra,createdAt:admin.firestore.FieldValue.serverTimestamp()});
}
exports.handler=async event=>{
 try{
  const store=db();
  if(event.httpMethod==='POST'){
   const body=JSON.parse(event.body||'{}');
   if(body.action==='apply'){
    const name=clean(body.name,80),email=clean(body.email,160).toLowerCase(),phone=clean(body.phone,10),subjects=clean(body.subjects,180),experience=clean(body.experience,80),bio=clean(body.bio,600);
    if(name.length<2||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)||!/^\\d{10}$/.test(phone)||subjects.length<2||bio.length<20)return reply(400,{ok:false,error:'Please complete all required fields. Use a valid email, 10-digit phone number and a bio of at least 20 characters.'});
    const applicationId='email_'+crypto.createHash('sha256').update(email).digest('hex');
    try{await store.collection(APPS).doc(applicationId).create({name,email,phone,subjects,experience,bio,status:'pending',createdAt:admin.firestore.FieldValue.serverTimestamp()});}
    catch(err){if(err.code===6||err.code==='already-exists')return reply(409,{ok:false,error:'An application with this email already exists. Please contact Englishmates for an update.'});throw err;}
    return reply(200,{ok:true,message:'Application submitted. Englishmates will review your profile.'});
   }
   const actor=await adminUser(event);
   const id=clean(body.applicationId,180);if(!id)return reply(400,{ok:false,error:'Invalid application.'});
   const ref=store.collection(APPS).doc(id),initial=await ref.get();
   if(!initial.exists)return reply(404,{ok:false,error:'Tutor record not found.'});
   const before=initial.data(),currentStatus=before.status||'pending';
   if(body.action==='update-profile'){
    const p=body.profile||{},name=clean(p.name,80),phone=clean(p.phone,10),subjects=clean(p.subjects,180),experience=clean(p.experience,80),bio=clean(p.bio,600);
    if(name.length<2||!/^\\d{10}$/.test(phone)||subjects.length<2||bio.length<20)return reply(400,{ok:false,error:'Check the name, 10-digit phone, subjects and introduction (at least 20 characters).'});
    const patch={name,phone,subjects,experience,bio,updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:actor.uid};
    await store.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('Tutor record not found.');tx.update(ref,patch);});
    await audit(store,actor,id,'profile_updated',currentStatus,currentStatus,{fields:['name','phone','subjects','experience','bio']});
    return reply(200,{ok:true,message:'Tutor profile updated.'});
   }
   if(body.action==='set-status'){
    const status=clean(body.status,20);if(!VALID_STATUSES.includes(status))return reply(400,{ok:false,error:'Invalid tutor status.'});
    if(status==='approved'){
     const account=await admin.auth().getUserByEmail(String(before.email||'').toLowerCase()).catch(()=>null);
     if(!account||!account.emailVerified)return reply(409,{ok:false,error:'This tutor needs a Firebase Authentication account with a verified email before approval.'});
     await store.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('Tutor record not found.');const old=snap.data().status||'pending';const patch={status:'approved',authUid:account.uid,approvedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:actor.uid,deactivatedAt:admin.firestore.FieldValue.delete(),deactivatedBy:admin.firestore.FieldValue.delete()};tx.update(ref,patch);});
    }else{
     await store.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('Tutor record not found.');const patch={status,updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:actor.uid};if(status==='rejected')patch.reviewedAt=admin.firestore.FieldValue.serverTimestamp();if(status==='inactive'){patch.deactivatedAt=admin.firestore.FieldValue.serverTimestamp();patch.deactivatedBy=actor.uid;}tx.update(ref,patch);});
    }
    await audit(store,actor,id,'status_changed',currentStatus,status);
    return reply(200,{ok:true,message:status==='approved'?'Tutor approved / reactivated.':status==='inactive'?'Tutor deactivated. Existing booking history was preserved.':status==='rejected'?'Tutor application rejected.':'Tutor status updated.'});
   }
   return reply(400,{ok:false,error:'Unknown action.'});
  }
  if(event.httpMethod==='GET'){
   await adminUser(event);
   const status=clean(event.queryStringParameters?.status||'pending',20),limit=Math.min(100,Math.max(1,Number(event.queryStringParameters?.limit)||40));
   if(status!=='all'&&!VALID_STATUSES.includes(status))return reply(400,{ok:false,error:'Invalid status filter.'});
   const counts={};
   await Promise.all(VALID_STATUSES.map(async s=>{try{const snap=await store.collection(APPS).where('status','==',s).count().get();counts[s]=snap.data().count;}catch{counts[s]=null;}}));
   let query=store.collection(APPS).orderBy(admin.firestore.FieldPath.documentId());
   if(status!=='all')query=query.where('status','==',status);
   const cursor=clean(event.queryStringParameters?.cursor,180);
   if(cursor){const cursorSnap=await store.collection(APPS).doc(cursor).get();if(cursorSnap.exists)query=query.startAfter(cursorSnap);}
   const snap=await query.limit(limit+1).get(),hasMore=snap.docs.length>limit,docs=hasMore?snap.docs.slice(0,limit):snap.docs;
   return reply(200,{ok:true,applications:docs.map(serialize),counts,nextCursor:hasMore?docs[docs.length-1].id:null});
  }
  return reply(405,{ok:false,error:'Method not allowed.'});
 }catch(e){console.error('Tutor applications:',e.message);return reply(e.status||400,{ok:false,error:e.message||'Request failed.'});}
};