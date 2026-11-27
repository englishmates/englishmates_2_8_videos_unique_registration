(() => {
  'use strict';
  const config = { apiKey: 'AIzaSyCFuF2PBq09cKOHBuoLDoypEgrI1gSmm4c', authDomain: 'englishmates-ratangarh-933f1.firebaseapp.com', projectId: 'englishmates-ratangarh-933f1', storageBucket: 'englishmates-ratangarh-933f1.firebasestorage.app', messagingSenderId: '501474121790', appId: '1:501474121790:web:5097a43a6be4e7bc07996f6' };
  const ADMIN_EMAIL = 'bddayma12@gmail.com';
  const $ = id => document.getElementById(id);
  let auth, state = null, poll = null, agoraClient = null, microphone = null, remoteAudioTrack = null, muted = false, callPaused = false, joinedSessionId = null, lastChatKey = '', avatarPreviewUrl = null;

  function message(id, text, error = false) { const node = $(id); node.textContent = text || ''; node.className = `text-sm mt-3 ${error ? 'text-rose-300' : 'text-emerald-300'}`; if (text && window.EMUI && ['matchingMessage', 'profileMessage'].includes(id)) window.EMUI.toast(text, error ? 'error' : 'ok'); }
  function friendly(error) { const code = error?.code || ''; const map = { 'auth/email-already-in-use': 'This email already has an account. Please sign in.', 'auth/invalid-email': 'Enter a valid email address.', 'auth/weak-password': 'Choose a password with at least 6 characters.', 'auth/invalid-credential': 'The email or password is incorrect.', 'auth/unauthorized-domain': 'This website domain is not authorized in Firebase Authentication.', 'auth/popup-closed-by-user': 'Google sign-in was cancelled.' }; return map[code] || error?.message || 'Something went wrong. Please try again.'; }
  function show(id, visible) { $(id).classList.toggle('hidden', !visible); }
  function setAuthMode(register) { show('registerForm', register); show('loginForm', !register); $('registerTab').className = register ? 'btn primary flex-1' : 'btn flex-1 text-slate-300'; $('loginTab').className = register ? 'btn flex-1 text-slate-300' : 'btn primary flex-1'; message('authMessage', ''); }
  async function token() { return auth.currentUser.getIdToken(); }
  async function api(method, body) { const response = await fetch(Englishmates.api('calling-community'), { method, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); let data = {}; try { data = await response.json(); } catch (_) {} if (!response.ok || !data.ok) { const error = new Error(data.error || 'Request failed.'); error.status = response.status; throw error; } return data; }
  function isCommunityUser(user) { return !!(user && Array.isArray(user.providerData) && user.providerData.some(provider => ['google.com', 'password'].includes(provider.providerId))); }
  function setViews(user) { const supported = isCommunityUser(user); show('signedOut', !supported); show('verifyEmail', supported && !user.emailVerified); show('communityApp', supported && !!user.emailVerified); if (user && !supported) message('authMessage', 'Use Google or email and password to sign in.', true); }
  function checkedInterests() { return [...document.querySelectorAll('#interests input:checked')].map(input => input.value); }
  async function compressAvatar() {
    const file = $('avatarInput').files[0];
    if (!file) return null;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP image under 5 MB.');
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    let edge = 128;
    const draw = () => { const scale = Math.min(edge / bitmap.width, edge / bitmap.height, 1); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); };
    const encode = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
    draw();
    let blob = await encode('image/webp', 0.72);
    if (!blob) blob = await encode('image/jpeg', 0.72);
    if (blob.size > 20000) { edge = 96; draw(); blob = await encode('image/webp', 0.62) || await encode('image/jpeg', 0.62); }
    bitmap.close?.();
    if (!blob || blob.size > 20000) throw new Error('That picture is too detailed. Choose a smaller or simpler image.');
    return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('The picture could not be prepared.')); reader.readAsDataURL(blob); });
  }
  function statusCopy(status) { return { pending: 'Your profile is activating automatically. Refresh in a moment.', approved: 'Your profile is active. You can safely enter the partner-matching queue.', rejected: 'Community access is blocked. Contact Englishmates if you need help.', suspended: 'Community access is suspended. Please contact Englishmates if you need help.' }[status] || 'Complete your profile to start matching.'; }
  let profileDirty = false, wasQueued = false, queueExpiresAt = 0, queueTicker = null;
  let profileWizardStep = 0, profileWizardTouched = false;
  const profileWizardSteps = [
    ['First, what should we call you?', 'Your email and phone stay private. Learners see the speaking name you choose.'],
    ['A quick age check', 'Calling Community is a safe practice space for adults in India.'],
    ['Choose your comfort level', 'There is no test. Pick the level that feels right today; you can update it later.'],
    ['Choose your interests', 'Pick the conversation topics you would enjoy practising with another learner.'],
    ['Set a small speaking goal', 'A sentence is enough. This helps suggest more useful practice.'],
    ['Where do you practise from?', 'Your city and state help match preferences and are not shown on your learner card.'],
    ['Add a little personality', 'A photo and introduction are optional. You can finish without them.']
  ];
  function setProfileWizardStep(index, markTouched = true) {
    const steps = [...document.querySelectorAll('#profileForm [data-profile-step]')];
    profileWizardStep = Math.max(0, Math.min(steps.length - 1, index));
    if (markTouched) profileWizardTouched = true;
    steps.forEach((step, stepIndex) => step.classList.toggle('hidden', stepIndex !== profileWizardStep));
    $('profileStepHeading').textContent = profileWizardSteps[profileWizardStep][0];
    $('profileStepHelp').textContent = profileWizardSteps[profileWizardStep][1];
    $('profileStepCount').textContent = 'Step ' + (profileWizardStep + 1) + ' of ' + steps.length;
    const progress = Math.round(((profileWizardStep + 1) / steps.length) * 100);
    $('profileStepProgress').style.width = progress + '%';
    $('profileStepProgress').parentElement.setAttribute('aria-valuenow', String(profileWizardStep + 1));
    $('profileBack').disabled = profileWizardStep === 0;
    $('profileBack').classList.toggle('opacity-40', profileWizardStep === 0);
    $('profileNext').classList.toggle('hidden', profileWizardStep === steps.length - 1);
    $('saveProfile').classList.toggle('hidden', profileWizardStep !== steps.length - 1);
    $('saveProfile').textContent = state?.profile ? 'Save profile changes' : 'Finish profile';
    if (markTouched) $('profileStepHeading').focus();
  }
  function validateProfileStep(index, report = true) {
    const steps = [...document.querySelectorAll('#profileForm [data-profile-step]')];
    const panel = steps[index];
    if (!panel) return false;
    const controls = [...panel.querySelectorAll('input, select, textarea')].filter(control => !(control.type === 'checkbox' && control.id !== 'adultConfirm'));
    const invalid = controls.find(control => !control.checkValidity());
    if (invalid) {
      if (report) { invalid.reportValidity(); invalid.focus(); }
      return false;
    }
    if (index === 3 && checkedInterests().length === 0) {
      if (report) {
        message('profileMessage', 'Choose at least one topic you would like to practise.', true);
        panel.querySelector('input[type="checkbox"]')?.focus();
      }
      return false;
    }
    if (report) message('profileMessage', '');
    return true;
  }
  function renderProfile(profile) {
    const status = profile?.status || 'new'; show('statusBox', true); $('statusBox').textContent = statusCopy(status); $('statusBox').className = `rounded-2xl p-4 mt-6 text-sm ${status === 'approved' ? 'bg-emerald-500/10 text-emerald-100' : status === 'suspended' || status === 'rejected' ? 'bg-rose-500/10 text-rose-100' : 'bg-amber-500/10 text-amber-100'}`;
    show('matchingPanel', status === 'approved'); if (!profile) return;
    if (profileDirty) return; // the learner is editing: a background refresh must not reset their choices
    const fields = { fullName: 'fullName', alias: 'alias', age: 'age', city: 'city', state: 'state', level: 'level', preferredLanguage: 'language', locationPreference: 'locationPreference', goals: 'goals', intro: 'intro' };
    Object.entries(fields).forEach(([key, id]) => { if (profile[key] !== undefined) $(id).value = profile[key] || ''; });
    document.querySelectorAll('#interests input').forEach(input => { input.checked = (profile.interests || []).includes(input.value); }); $('adultConfirm').checked = true; $('saveProfile').textContent = status === 'approved' ? 'Update profile' : 'Save profile'; if (profile.avatarURL) { $('avatarPreview').src = profile.avatarURL; show('avatarPreviewWrap', true); }
  }
  function avatarInitial(name) { return Array.from(String(name || 'P').trim())[0]?.toUpperCase() || 'P'; }
  function setAvatar(id, name, url) { const node = $(id); node.replaceChildren(); const safe = /^data:image\/(?:webp|png|jpeg);base64,/i.test(url || '') || /^https:\/\/(?:[^/]+\.)?googleusercontent\.com\//i.test(url || '') || /^https:\/\/firebasestorage\.googleapis\.com\//i.test(url || ''); if (safe) { const image = document.createElement('img'); image.src = url; image.alt = ''; image.className = 'h-full w-full rounded-full object-cover'; node.append(image); } else node.textContent = avatarInitial(name); }
  function renderMessages(session) {
    const target = $('chatMessages');
    const items = Array.isArray(session?.messages) ? session.messages : [];
    const key = `${session?.id || ''}:${items.map(item => item.id).join(',')}`;
    if (key === lastChatKey) return;
    lastChatKey = key;
    target.replaceChildren();
    if (!items.length) { target.textContent = 'No messages yet.'; return; }
    for (const item of items) {
      const bubble = document.createElement('article');
      bubble.className = `rounded-xl px-3 py-2 max-w-[90%] ${item.fromMe ? 'ml-auto bg-violet-500/20' : 'mr-auto bg-white/10'}`;
      const sender = document.createElement('p');
      sender.className = 'text-[11px] font-bold text-violet-200';
      sender.textContent = item.fromMe ? 'You' : (session.partner?.alias || 'Partner');
      const body = document.createElement('p');
      body.className = 'text-sm text-slate-100 whitespace-pre-wrap break-words';
      body.textContent = item.text || '';
      bubble.append(sender, body);
      target.append(bubble);
    }
    target.scrollTop = target.scrollHeight;
  }
  function syncCallControls(session) {
    const joined = joinedSessionId === session.id && !!agoraClient;
    const ownPaused = !!session.pausedByMe, partnerPaused = !!session.pausedByPartner;
    callPaused = ownPaused || partnerPaused;
    if (microphone) microphone.setEnabled(!muted && !callPaused).catch(() => {});
    if (remoteAudioTrack) remoteAudioTrack.setVolume(callPaused ? 0 : 100);
    show('startAudio', !joined);
    show('muteCall', joined);
    show('pauseCall', joined);
    $('muteCall').textContent = muted ? 'Unmute microphone' : 'Mute microphone';
    $('muteCall').setAttribute('aria-pressed', String(muted));
    $('pauseCall').textContent = ownPaused ? 'Resume call' : partnerPaused ? 'Partner paused' : 'Pause call';
    $('pauseCall').disabled = partnerPaused && !ownPaused;
    $('callAudioStatus').textContent = ownPaused ? 'Call paused by you' : partnerPaused ? 'Your partner paused the call' : joined ? 'Connected · audio only' : 'Both accepted · audio only';
    $('voiceRing').classList.toggle('paused', callPaused);
  }
  function renderMatching(data) {
    $('onlineCount').textContent = `${data.onlineLearners || 0} learner${data.onlineLearners === 1 ? '' : 's'} currently waiting for a partner.`;
    const queue = data.queue, session = data.session;
    show('leaveQueue', !!queue);
    $('joinQueue').disabled = !!queue || !!session;
    $('joinQueue').classList.toggle('opacity-60', !!queue || !!session);
    $('joinQueue').textContent = queue ? 'Searching…' : 'Find a partner';
    show('queueStatus', !!queue);
    clearInterval(queueTicker);
    if (queue) {
      wasQueued = true; queueExpiresAt = Date.parse(queue.expiresAt) || (Date.now() + 300000);
      const tick = () => {
        const left = Math.min(300, Math.max(0, Math.round((queueExpiresAt - Date.now()) / 1000)));
        $('queueStatus').innerHTML = '<span class="em-spinner"></span> Looking for a partner who is online right now… <b>' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + '</b> left. Keep this page open — you will see the invitation here.';
      };
      tick(); queueTicker = setInterval(tick, 1000);
    } else if (wasQueued) {
      wasQueued = false;
      if (!session) message('matchingMessage', 'No compatible learner was online this time. Try again in a minute, or invite one of your connections.', true);
    }
    show('callCard', !!session);
    show('feedbackCard', !!data.recentSession);
    if (!session) {
      lastChatKey = '';
      $('chatMessages').replaceChildren();
      if (joinedSessionId) leaveAudio();
      return;
    }
    const partner = session.partner || {};
    const alias = partner.alias || 'Practice partner';
    const details = $('partnerDetails'); details.replaceChildren();
    const nameLine = document.createElement('span'); nameLine.textContent = alias + (partner.level ? ' · ' + partner.level : ''); details.appendChild(nameLine);
    const extra = [partner.introduction, (partner.interests || []).join(', ')].filter(Boolean).join(' — ');
    if (extra) { const line = document.createElement('span'); line.className = 'block text-xs font-normal text-slate-300 mt-1'; line.textContent = extra; details.appendChild(line); }
    setAvatar('partnerAvatar', alias, partner.avatarURL);
    setAvatar('callAvatar', alias, partner.avatarURL);
    $('callPartnerName').textContent = alias;
    const accepted = !!session.acceptedByMe, active = session.status === 'active';
    $('callTitle').textContent = active ? 'Your audio call is ready' : accepted ? 'Waiting for your partner to accept' : 'You have a practice invitation';
    $('callTiming').textContent = active ? 'You can pause or end the call at any time.' : 'Both learners must accept within 90 seconds.';
    show('partnerIdentity', !active);
    show('inviteActions', !active && ['invited', 'accepted'].includes(session.status) && !accepted);
    show('activeCallActions', active);
    if (active) { syncCallControls(session); renderMessages(session); }
  }
  async function refreshDashboard() {
    if (!auth?.currentUser?.emailVerified) return;
    try { state = await api('GET'); renderProfile(state.profile); if (state.profile?.status === 'approved') renderMatching(state); }
    catch (error) { if (error.status === 404) { state = { profile: null }; renderProfile(null); return; } message('profileMessage', error.message, true); }
  }
  async function pollDashboard() { if (!document.hidden) await refreshDashboard(); poll = setTimeout(pollDashboard, state?.session || state?.queue ? 4000 : 15000); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && auth?.currentUser?.emailVerified) { clearTimeout(poll); pollDashboard(); } });
  function startPolling() { clearTimeout(poll); pollDashboard(); }
  async function sendVerification(user) { await user.sendEmailVerification({ url: `${location.origin}/community-profile.html`, handleCodeInApp: false }); }
  async function signOut() { try { if (state?.session) await api('POST', { action: 'end-call' }); else if (state?.queue) await api('POST', { action: 'leave-queue' }); } catch (_) {} await leaveAudio(); clearTimeout(poll); await auth.signOut(); }
  async function action(actionName, extra = {}) { const result = await api('POST', { action: actionName, ...extra }); if (actionName !== 'pause-call') message('matchingMessage', result.message); await refreshDashboard(); return result; }
  async function loadAgora() { if (window.AgoraRTC) return window.AgoraRTC; await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://download.agora.io/sdk/release/AgoraRTC_N-4.23.2.js'; script.onload = resolve; script.onerror = () => reject(new Error('The audio service could not load.')); document.head.appendChild(script); }); return window.AgoraRTC; }
  async function leaveAudio() { if (microphone) { microphone.stop(); microphone.close(); microphone = null; } if (agoraClient) { await agoraClient.leave().catch(() => {}); agoraClient = null; } remoteAudioTrack = null; joinedSessionId = null; muted = false; callPaused = false; show('startAudio', true); show('muteCall', false); show('pauseCall', false); $('startAudio').disabled = false; $('startAudio').textContent = 'Join audio call'; $('muteCall').textContent = 'Mute microphone'; $('pauseCall').textContent = 'Pause call'; }
  async function audioCredentials(sessionId) { const response = await fetch(Englishmates.api('calling-token'), { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || 'Audio could not start.'); return data; }
  async function joinAudio() {
    try {
      const session = state?.session;
      if (!session || session.status !== 'active') throw new Error('The call is not ready yet.');
      if (joinedSessionId === session.id) return;
      $('startAudio').disabled = true;
      $('startAudio').textContent = 'Connecting…';
      const AgoraRTC = await loadAgora();
      const data = await audioCredentials(session.id);
      agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      agoraClient.on('user-published', async (remoteUser, mediaType) => {
        await agoraClient.subscribe(remoteUser, mediaType);
        if (mediaType === 'audio') {
          remoteAudioTrack = remoteUser.audioTrack;
          remoteAudioTrack.play();
          remoteAudioTrack.setVolume(callPaused ? 0 : 100);
        }
      });
      agoraClient.on('user-unpublished', (remoteUser, mediaType) => {
        if (mediaType === 'audio' && remoteAudioTrack === remoteUser.audioTrack) remoteAudioTrack = null;
      });
      agoraClient.on('user-left', () => { remoteAudioTrack = null; message('matchingMessage', 'Your partner disconnected. You can wait or end the call.'); });
      agoraClient.on('token-privilege-will-expire', async () => {
        try { const renewed = await audioCredentials(session.id); await agoraClient.renewToken(renewed.token); }
        catch (_) { message('matchingMessage', 'Audio token renewal failed. Please end the call and try again.', true); }
      });
      await agoraClient.join(data.appId, data.channel, data.token, null);
      microphone = await AgoraRTC.createMicrophoneAudioTrack();
      await agoraClient.publish([microphone]);
      joinedSessionId = session.id;
      $('startAudio').disabled = false;
      $('startAudio').textContent = 'Audio connected';
      syncCallControls(state?.session || session);
      message('matchingMessage', 'Audio call connected. Your microphone and speaker controls are ready.');
    } catch (error) {
      const failedSessionId = state?.session?.id;
      if (failedSessionId) {
        const category = error?.name === 'NotAllowedError' || /microphone|permission/i.test(error.message) ? 'microphone-permission' : /token/i.test(error.message) ? 'token' : /service|load/i.test(error.message) ? 'audio-service' : 'audio-network';
        fetch(Englishmates.api('calling-partners'), { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'record-call-failure', sessionId: failedSessionId, category }), keepalive: true }).catch(() => {});
      }
      await leaveAudio();
      $('startAudio').disabled = false;
      $('startAudio').textContent = 'Join audio call';
      message('matchingMessage', error.message, true);
    }
  }

  async function initialise() {
    try { if (!firebase.apps.length) firebase.initializeApp(config); auth = firebase.auth(); } catch (error) { message('authMessage', 'Firebase could not start. Please check the site configuration.', true); return; }
    $('registerTab').addEventListener('click', () => setAuthMode(true)); $('loginTab').addEventListener('click', () => setAuthMode(false));
    $('registerForm').addEventListener('submit', async event => { event.preventDefault(); try { const result = await auth.createUserWithEmailAndPassword($('registerEmail').value.trim(), $('registerPassword').value); await result.user.updateProfile({ displayName: $('registerName').value.trim() }); await sendVerification(result.user); message('authMessage', 'Account created. Check your inbox for the verification link.'); } catch (error) { message('authMessage', friendly(error), true); } });
    $('loginForm').addEventListener('submit', async event => { event.preventDefault(); try { await auth.signInWithEmailAndPassword($('loginEmail').value.trim(), $('loginPassword').value); } catch (error) { message('authMessage', friendly(error), true); } });
    $('googleSignIn').addEventListener('click', async () => { try { const provider = new firebase.auth.GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' }); await auth.signInWithPopup(provider); } catch (error) { message('authMessage', friendly(error), true); } });
    $('resetPassword').addEventListener('click', async () => { try { const email = $('loginEmail').value.trim(); if (!email) throw new Error('Enter your email address first.'); await auth.sendPasswordResetEmail(email); message('authMessage', 'Password reset email sent.'); } catch (error) { message('authMessage', friendly(error), true); } });
    $('resendVerification').addEventListener('click', async () => { try { await sendVerification(auth.currentUser); message('verifyMessage', 'A new verification email was sent.'); } catch (error) { message('verifyMessage', friendly(error), true); } });
    $('refreshVerification').addEventListener('click', async () => { try { await auth.currentUser.reload(); if (auth.currentUser.emailVerified) { setViews(auth.currentUser); await refreshDashboard(); } else message('verifyMessage', 'We cannot see verification yet. Open the link in your email, then try again.', true); } catch (error) { message('verifyMessage', friendly(error), true); } });
    document.querySelectorAll('.signOut').forEach(button => button.addEventListener('click', signOut));
    $('avatarInput').addEventListener('change', () => { const file = $('avatarInput').files[0]; if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl); if (!file) return; avatarPreviewUrl = URL.createObjectURL(file); $('avatarPreview').src = avatarPreviewUrl; show('avatarPreviewWrap', true); });
    ['input', 'change'].forEach(type => $('profileForm').addEventListener(type, () => { profileDirty = true; }));
    $('profileNext').addEventListener('click', () => {
      if (validateProfileStep(profileWizardStep)) setProfileWizardStep(profileWizardStep + 1);
    });
    $('profileBack').addEventListener('click', () => {
      message('profileMessage', '');
      setProfileWizardStep(profileWizardStep - 1);
    });
    $('profileForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (profileWizardStep < profileWizardSteps.length - 1) {
        if (validateProfileStep(profileWizardStep)) setProfileWizardStep(profileWizardStep + 1);
        return;
      }
      for (let index = 0; index < profileWizardSteps.length; index++) {
        if (!validateProfileStep(index, false)) {
          setProfileWizardStep(index);
          validateProfileStep(index, true);
          return;
        }
      }
      if (!$('adultConfirm').checked) { setProfileWizardStep(1); return message('profileMessage', 'Confirm that you are 18 or older and in India.', true); }
      const saveButton = $('saveProfile');
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      try {
        const profile = {
          fullName: $('fullName').value, alias: $('alias').value, age: $('age').value,
          city: $('city').value, state: $('state').value, level: $('level').value,
          preferredLanguage: $('language').value, locationPreference: $('locationPreference').value,
          interests: checkedInterests(), goals: $('goals').value, intro: $('intro').value
        };
        const avatarDataUrl = await compressAvatar();
        if (avatarDataUrl) profile.avatarDataUrl = avatarDataUrl;
        const result = await api('POST', { action: state?.profile ? 'update-profile' : 'register-profile', profile });
        message('profileMessage', result.message);
        profileDirty = false;
        profileWizardTouched = false;
        setProfileWizardStep(0, false);
        if (window.EMUI) window.EMUI.toast('Profile saved ✓');
        await refreshDashboard();
      } catch (error) { message('profileMessage', error.message, true); }
      finally {
        saveButton.disabled = false;
        saveButton.textContent = state?.profile ? 'Save profile changes' : 'Finish profile';
      }
    });
    $('joinQueue').addEventListener('click', () => action('join-queue').catch(error => message('matchingMessage', error.message, true)));
    $('leaveQueue').addEventListener('click', () => action('leave-queue').catch(error => message('matchingMessage', error.message, true)));
    $('acceptCall').addEventListener('click', () => action('accept-call').catch(error => message('matchingMessage', error.message, true)));
    $('declineCall').addEventListener('click', () => action('decline-call').catch(error => message('matchingMessage', error.message, true)));
    $('endCall').addEventListener('click', async () => { $('endCall').disabled = true; await leaveAudio(); try { await action('end-call'); } catch (error) { message('matchingMessage', error.message, true); } finally { $('endCall').disabled = false; } });
    $('startAudio').addEventListener('click', joinAudio);
    $('muteCall').addEventListener('click', async () => { muted = !muted; try { if (microphone) await microphone.setEnabled(!muted && !callPaused); $('muteCall').textContent = muted ? 'Unmute microphone' : 'Mute microphone'; $('muteCall').setAttribute('aria-pressed', String(muted)); message('matchingMessage', muted ? 'Microphone muted.' : 'Microphone on.'); } catch (error) { message('matchingMessage', error.message, true); } });
    $('pauseCall').addEventListener('click', () => { const session = state?.session; if (!session) return; action('pause-call', { paused: !session.pausedByMe }).catch(error => message('matchingMessage', error.message, true)); });
    $('chatForm').addEventListener('submit', async event => { event.preventDefault(); const input = $('chatInput'), text = input.value.trim(), button = $('sendChat'); if (!text) return; button.disabled = true; try { await api('POST', { action: 'send-message', message: text }); input.value = ''; message('chatStatus', 'Message sent.'); await refreshDashboard(); } catch (error) { message('chatStatus', error.message, true); } finally { button.disabled = false; input.focus(); } });
    $('blockPartner').addEventListener('click', async () => { if (confirm('Block this learner and end the call?')) { await leaveAudio(); action('block-current-partner').catch(error => message('matchingMessage', error.message, true)); } });
    $('reportPartner').addEventListener('click', () => action('report-current-partner', { reason: $('reportReason').value, details: $('reportDetails').value }).catch(error => message('matchingMessage', error.message, true)));
    $('sendFeedback').addEventListener('click', () => action('submit-feedback', { rating: $('feedbackRating').value, note: $('feedbackNote').value }).catch(error => message('matchingMessage', error.message, true)));
    auth.onAuthStateChanged(async user => { if (!user) { profileDirty = false; profileWizardTouched = false; setProfileWizardStep(0, false); } if (user) await user.reload(); if (user && !isCommunityUser(user)) { await auth.signOut(); setViews(null); message('authMessage', 'Use Google or email and password to sign in.', true); return; } setViews(user); if (!user) return; $('identity').textContent = user.emailVerified ? 'Verified Englishmates learner' : 'Email verification required'; if ((user.email || '').toLowerCase() === ADMIN_EMAIL) show('adminLink', true); if (user.emailVerified) { await refreshDashboard(); startPolling(); } });
  }
  initialise();
})();
