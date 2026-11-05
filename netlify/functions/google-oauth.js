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
function googleOAuthConfig(){const clientId=String(process.env.GOOGLE_CLIENT_ID||'').trim(),clientSecret=String(process.env.GOOGLE_CLIENT_SECRET||'').trim(),tokenKey=String(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY||'').trim(),redirectUri=String(process.env.GOOGLE_REDIRECT_URI||'').trim().replace(/\/+$/,'');const missing=[];if(!clientId)missing.push('GOOGLE_CLIENT_ID');if(!clientSecret)missing.push('GOOGLE_CLIENT_SECRET');if(!redirectUri)missing.push('GOOGLE_REDIRECT_URI');if(!/^[a-f0-9]{64}$/i.test(tokenKey))missing.push('GOOGLE_TOKEN_ENCRYPTION_KEY (64 hexadecimal characters)');if(missing.length)throw new Error('Google OAuth configuration is incomplete for this deploy. Missing: '+missing.join(', ')+'.');let parsed;try{parsed=new URL(redirectUri);}catch{throw new Error('GOOGLE_REDIRECT_URI must be a valid HTTPS URL.');}if(parsed.protocol!=='https:'||parsed.pathname!=='/.netlify/functions/google-oauth'||parsed.search||parsed.hash)throw new Error('GOOGLE_REDIRECT_URI must exactly end with /.netlify/functions/google-oauth and must not include a query string or trailing slash.');return {clientId,clientSecret,redirectUri,origin:parsed.origin};}
exports.handler=async event=>{
 const redirect=(url)=>({statusCode:302,headers:{Location:url,'Cache-Control':'no-store'}});
 try{
   const oauth=googleOAuthConfig(),query=event.queryStringParameters||{};
  const code=query.code,state=query.state;
   const origin=oauth.origin;
  if(query.error)return redirect(origin+'/teacher-dashboard.html?google=denied');
  if(!code||!state||!/^[a-f0-9]{64}$/.test(state))return redirect(origin+'/teacher-dashboard.html?google=error');
  const store=db(),suffix=process.env.CONTEXT==='production'?'':'Preview';
  const stateRef=store.collection('googleOAuthStates'+suffix).doc(state),snap=await stateRef.get();
  if(!snap.exists||Number(snap.data().expiresAt||0)<Date.now())return redirect(origin+'/teacher-dashboard.html?google=expired');
  const tutorId=snap.data().tutorId;
  await stateRef.delete();
   const tokenRes=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:oauth.clientId,client_secret:oauth.clientSecret,redirect_uri:oauth.redirectUri,grant_type:'authorization_code'})});
  const tokens=await tokenRes.json();
  if(!tokenRes.ok||!tokens.refresh_token)throw new Error('Google did not return a refresh token. Please reconnect and grant calendar access.');
  await store.collection('tutorGoogleConnections'+suffix).doc(tutorId).set({refreshToken:encryptToken(tokens.refresh_token),scope:tokens.scope||'',connectedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return redirect(origin+'/teacher-dashboard.html?google=connected');
 }catch(error){
  console.error('Google OAuth callback:',error.message);
   let origin='/';try{origin=process.env.GOOGLE_REDIRECT_URI?new URL(String(process.env.GOOGLE_REDIRECT_URI).trim()).origin:'/';}catch{}
   const result=/Google OAuth configuration/.test(error.message)||/GOOGLE_REDIRECT_URI/.test(error.message)?'configuration':'error';
   return redirect(origin+'/teacher-dashboard.html?google='+result);
 }
};
