const admin = require('firebase-admin');
const crypto = require('crypto');

function store() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Booking service is not configured.');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: process.env.FIREBASE_PROJECT_ID || 'englishmates-ratangarh-933f1' });
  }
  return admin.firestore();
}
const reply=(statusCode,payload)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(payload)});
const clean=(v,n=120)=>String(v||'').trim().slice(0,n);
const days=['sun','mon','tue','wed','thu','fri','sat'];
const timeRe=/^(?:[01]\\d|2[0-3]):[0-5]\\d$/;
function indiaNowParts(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const o={};parts.forEach(p=>o[p.type]=p.value);return {date:o.year+'-'+o.month+'-'+o.day,time:o.hour+':'+o.minute};
}
function addDays(date,n){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function validDate(s){if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;}
function makeSlots(schedule,blocks,bookings){
 const now=indiaNowParts(),blocked=new Set(blocks.map(x=>x.date));
 const taken=new Set(bookings.filter(x=>!['cancelled','rejected'].includes(String(x.status||'').toLowerCase())).map(x=>x.date+'_'+x.startTime));
 const out=[];
 for(let offset=0;offset<14;offset++){
  const date=addDays(now.date,offset),day=days[new Date(date+'T00:00:00Z').getUTCDay()];
  if(blocked.has(date))continue;
  const ranges=schedule[day]||[];
  for(const range of ranges){
   if(!timeRe.test(range.start||'')||!timeRe.test(range.end||''))continue;
   let [h,m]=range.start.split(':').map(Number),[eh,em]=range.end.split(':').map(Number);
   let cur=h*60+m,end=eh*60+em;
   while(cur+30<=end){
    const start=String(Math.floor(cur/60)).padStart(2,'0')+':'+String(cur%60).padStart(2,'0');
    const finish=String(Math.floor((cur+30)/60)).padStart(2,'0')+':'+String((cur+30)%60).padStart(2,'0');
    if((date>now.date||(date===now.date&&start>now.time))&&!taken.has(date+'_'+start))out.push({date,startTime:start,endTime:finish,durationMinutes:30});
    cur+=30;
   }
  }
 }
 return out;
}
exports.handler=async event=>{
 try{
  const db=store(),suffix=process.env.CONTEXT==='production'?'':'Preview';
  const tutorsCol='tutorApplications'+suffix,weeklyCol='tutorWeeklyAvailability'+suffix,blocksCol='tutorAvailabilityBlocks'+suffix,bookingsCol='tutorBookings'+suffix;
  if(event.httpMethod==='GET'){
   const tutorsSnap=await db.collection(tutorsCol).where('status','==','approved').limit(50).get();
   const tutors=[];
   for(const doc of tutorsSnap.docs){
    const t=doc.data(),id=doc.id;
    const [s,b,k]=await Promise.all([
     db.collection(weeklyCol).doc(id).get(),
     db.collection(blocksCol).where('tutorId','==',id).limit(120).get(),
     db.collection(bookingsCol).where('tutorId','==',id).limit(300).get()
    ]);
    const schedule=s.exists?(s.data().schedule||{}):{};
    const slots=makeSlots(schedule,b.docs.map(x=>x.data()),k.docs.map(x=>x.data()));
    if(!slots.length)continue;
    tutors.push({id,name:clean(t.name||t.fullName||t.displayName,90)||'Englishmates Tutor',subjects:clean(t.subjects||t.expertise||t.specialization,140),bio:clean(t.bio||t.about,240),photoUrl:clean(t.photoUrl||t.photoURL||t.profileUrl,500),slots});
   }
   return reply(200,{ok:true,durationMinutes:30,tutors});
  }
  if(event.httpMethod!=='POST')return reply(405,{ok:false,error:'Method not allowed.'});
  const body=JSON.parse(event.body||'{}'),tutorId=clean(body.tutorId,180),date=clean(body.date,10),startTime=clean(body.startTime,5);
  const studentName=clean(body.studentName,90),phone=clean(body.phone,20).replace(/\\D/g,'').slice(-10),email=clean(body.email,140);
  if(!tutorId||!validDate(date)||!timeRe.test(startTime)||!studentName||!/^\\d{10}$/.test(phone)||!/^\\S+@\\S+\\.\\S+$/.test(email))return reply(400,{ok:false,error:'Enter your name, valid 10-digit phone, email and choose a valid slot.'});
  const tutorRef=db.collection(tutorsCol).doc(tutorId),[tutorSnap,scheduleSnap,blockSnap,bookingSnap]=await Promise.all([
   tutorRef.get(),db.collection(weeklyCol).doc(tutorId).get(),db.collection(blocksCol).doc(tutorId+'_'+date).get(),db.collection(bookingsCol).where('tutorId','==',tutorId).get()
  ]);
  if(!tutorSnap.exists||tutorSnap.data().status!=='approved')return reply(404,{ok:false,error:'This tutor is not available.'});
  if(!scheduleSnap.exists||blockSnap.exists)return reply(409,{ok:false,error:'This date is not available. Please choose another slot.'});
  const day=days[new Date(date+'T00:00:00Z').getUTCDay()],ranges=(scheduleSnap.data().schedule||{})[day]||[];
  const startM=Number(startTime.slice(0,2))*60+Number(startTime.slice(3));
  const fits=ranges.some(r=>timeRe.test(r.start||'')&&timeRe.test(r.end||'')&&startM>=Number(r.start.slice(0,2))*60+Number(r.start.slice(3))&&startM+30<=Number(r.end.slice(0,2))*60+Number(r.end.slice(3)));
  const now=indiaNowParts();if(!fits||date<now.date||(date===now.date&&startTime<=now.time))return reply(409,{ok:false,error:'That 30-minute slot is no longer available.'});
  const occupied=bookingSnap.docs.some(d=>d.data().date===date&&!['cancelled','rejected'].includes(String(d.data().status||'').toLowerCase())&&d.data().startTime===startTime);
  if(occupied)return reply(409,{ok:false,error:'Someone has already requested this slot. Please choose another.'});
  const id=crypto.createHash('sha256').update(tutorId+'|'+date+'|'+startTime).digest('hex');
  const ref=db.collection(bookingsCol).doc(id);
  try{
   await db.runTransaction(async tx=>{
    const existing=await tx.get(ref);if(existing.exists)throw new Error('SLOT_TAKEN');
    tx.create(ref,{tutorId,tutorName:clean(tutorSnap.data().name||tutorSnap.data().fullName||tutorSnap.data().displayName,90)||'Englishmates Tutor',studentName,phone,email,date,startTime,endTime:String(Math.floor((startM+30)/60)).padStart(2,'0')+':'+String((startM+30)%60).padStart(2,'0'),durationMinutes:30,status:'pending',timezone:'Asia/Kolkata',createdAt:admin.firestore.FieldValue.serverTimestamp()});
   });
  }catch(e){if(e.message==='SLOT_TAKEN')return reply(409,{ok:false,error:'This slot has just been requested. Please choose another.'});throw e;}
  return reply(200,{ok:true,message:'Your 30-minute class request has been sent. The tutor will contact you to confirm it.'});
 }catch(e){console.error('Student booking:',e.message);return reply(500,{ok:false,error:'We could not process your request. Please try again.'});}
};