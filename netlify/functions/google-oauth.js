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
function googleOAuthConfig(){const clientId=String(process.env.GOOGLE_CLIENT_ID||'').trim(),clientSecret=String(process.env.GOOGLE_CLIENT_SECRET||'').trim(),tokenKey=String(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY||'').trim(),configuredRedirectUri=String(process.env.GOOGLE_REDIRECT_URI||'').trim(),netlifyOrigin=String(process.env.CONTEXT==='production'?process.env.URL:(process.env.DEPLOY_PRIME_URL||process.env.URL)||'').trim(),redirectSource=configuredRedirectUri||netlifyOrigin;const missing=[];if(!clientId)missing.push('GOOGLE_CLIENT_ID');if(!clientSecret)missing.push('GOOGLE_CLIENT_SECRET');if(!redirectSource)missing.push('GOOGLE_REDIRECT_URI (or Netlify URL)');if(!/^[a-f0-9]{64}$/i.test(tokenKey))missing.push('GOOGLE_TOKEN_ENCRYPTION_KEY (64 hexadecimal characters)');if(missing.length)throw new Error('Google OAuth configuration is incomplete for this deploy. Missing: '+missing.join(', ')+'.');let parsed;try{parsed=new URL(redirectSource);}catch{throw new Error('GOOGLE_REDIRECT_URI must be a valid HTTPS site URL.');}if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('GOOGLE_REDIRECT_URI must use an HTTPS site URL without credentials.');const redirectUri=parsed.origin+'/.netlify/functions/google-oauth';return {clientId,clientSecret,redirectUri,origin:parsed.origin};}
function dashboardUrl(value){
 try{
  const target=new URL(String(value||'')),path=target.pathname.replace(/\/+$/,'');
  const githubPages=target.origin==='https://englishmates.github.io'&&path==='/englishmates_2_8_videos_unique_registration/teacher-dashboard.html';
  const netlifyDashboard=/^https:\/\/(?:englishmates-?ratangarh|deploy-preview-\d+--englishmates-?ratangarh)\.netlify\.app$/i.test(target.origin)&&path==='/teacher-dashboard.html';
  if(!githubPages&&!netlifyDashboard)return '';
  return target.origin+path;
 }catch{return '';}
}
exports.handler=async event=>{
 const redirect=url=>({statusCode:302,headers:{Location:url,'Cache-Control':'no-store'}});
 let errorRedirect='';
 try{
  const oauth=googleOAuthConfig(),query=event.queryStringParameters||{},state=String(query.state||'');
  const fallback=result=>oauth.origin+'/teacher-dashboard.html?google='+result;
  if(!/^[a-f0-9]{64}$/.test(state))return redirect(fallback(query.error?'denied':'error'));
  const store=db(),preferred=process.env.CONTEXT==='production'?'':'Preview';
  const suffixes=preferred?['Preview','']:['','Preview'];
  let stateRef=null,snap=null,stateSuffix='';
  for(const candidate of suffixes){
   const ref=store.collection('googleOAuthStates'+candidate).doc(state),result=await ref.get();
   if(result.exists){stateRef=ref;snap=result;stateSuffix=candidate;break;}
  }
  if(!snap)return redirect(fallback('expired'));
  const data=snap.data(),returnUrl=dashboardUrl(data.returnUrl);
  const dashboard=result=>{
   if(!returnUrl)return fallback(result);
   const target=new URL(returnUrl);target.searchParams.set('google',result);return target.toString();
  };
  errorRedirect=dashboard('error');
  if(query.error){await stateRef.delete();return redirect(dashboard('denied'));}
  if(Number(data.expiresAt||0)<Date.now()){await stateRef.delete();return redirect(dashboard('expired'));}
  if(!query.code){await stateRef.delete();return redirect(dashboard('error'));}
  const tutorId=data.tutorId;
  await stateRef.delete();
  const tokenRes=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:query.code,client_id:oauth.clientId,client_secret:oauth.clientSecret,redirect_uri:oauth.redirectUri,grant_type:'authorization_code'})});
  const tokens=await tokenRes.json();
  if(!tokenRes.ok||!tokens.refresh_token)throw new Error('Google did not return a refresh token. Please reconnect and grant calendar access.');
  await store.collection('tutorGoogleConnections'+stateSuffix).doc(tutorId).set({refreshToken:encryptToken(tokens.refresh_token),scope:tokens.scope||'',connectedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return redirect(dashboard('connected'));
 }catch(error){
  console.error('Google OAuth callback:',error.message);
  const result=/Google OAuth configuration|GOOGLE_REDIRECT_URI/.test(error.message)?'configuration':'error';
  if(errorRedirect)return redirect(errorRedirect);
  let fallbackUrl='/teacher-dashboard.html?google='+result;
  try{const configured=String(process.env.GOOGLE_REDIRECT_URI||'');if(configured)fallbackUrl=new URL(configured).origin+'/teacher-dashboard.html?google='+result;}catch{}
  return redirect(errorRedirect||fallbackUrl);
 }
};
