const admin = require('firebase-admin');
const crypto = require('crypto');
function db(){
 if(!admin.apps.length){
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if(!raw)throw new Error('Google connection is not configured.');
  admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw)),projectId:process.env.FIREBASE_PROJECT_ID||'englishmates-ratangarh-933f1'});
 }
 return admin.firestore();
}
function encryptToken(value){
 const key=Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY||'','hex');
 if(key.length!==32)throw new Error('Google token encryption key is not configured.');
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}
exports.handler=async event=>{
 const redirect=(url)=>({statusCode:302,headers:{Location:url,'Cache-Control':'no-store'}});
 try{
  const query=event.queryStringParameters||{};
  const code=query.code,state=query.state;
  const origin=new URL(process.env.GOOGLE_REDIRECT_URI).origin;
  if(query.error)return redirect(origin+'/teacher-dashboard.html?google=denied');
  if(!code||!state||!/^[a-f0-9]{64}$/.test(state))return redirect(origin+'/teacher-dashboard.html?google=error');
  const store=db(),suffix=process.env.CONTEXT==='production'?'':'Preview';
  const stateRef=store.collection('googleOAuthStates'+suffix).doc(state),snap=await stateRef.get();
  if(!snap.exists||Number(snap.data().expiresAt||0)<Date.now())return redirect(origin+'/teacher-dashboard.html?google=expired');
  const tutorId=snap.data().tutorId;
  await stateRef.delete();
  const tokenRes=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:process.env.GOOGLE_REDIRECT_URI,grant_type:'authorization_code'})});
  const tokens=await tokenRes.json();
  if(!tokenRes.ok||!tokens.refresh_token)throw new Error('Google did not return a refresh token. Please reconnect and grant calendar access.');
  await store.collection('tutorGoogleConnections'+suffix).doc(tutorId).set({refreshToken:encryptToken(tokens.refresh_token),scope:tokens.scope||'',connectedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return redirect(origin+'/teacher-dashboard.html?google=connected');
 }catch(error){
  console.error('Google OAuth callback:',error.message);
  const origin=process.env.GOOGLE_REDIRECT_URI?new URL(process.env.GOOGLE_REDIRECT_URI).origin:'/';
  return redirect(origin+'/teacher-dashboard.html?google=error');
 }
};
