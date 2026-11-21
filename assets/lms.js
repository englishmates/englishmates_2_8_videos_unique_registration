(function () {
  'use strict';
  const config = {
    apiKey: 'AIzaSyCFuF2PBq09cKOHBuoLDoypEgrI1gSmm4c',
    authDomain: 'englishmates-ratangarh-933f1.firebaseapp.com',
    projectId: 'englishmates-ratangarh-933f1',
    storageBucket: 'englishmates-ratangarh-933f1.firebasestorage.app',
    messagingSenderId: '501474121790',
    appId: '1:501474121790:web:5097a43a6be4e7bc07996f6'
  };
  if (!firebase.apps.length) firebase.initializeApp(config);
  const auth = firebase.auth();
  const storage = firebase.storage();
  const $ = id => document.getElementById(id);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
  async function api(action, data) {
    const user = auth.currentUser;
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = 'Bearer ' + await user.getIdToken();
    const res = await fetch(Englishmates.api('lms-api'), {
      method: 'POST', headers,
      body: JSON.stringify(Object.assign({}, data || {}, { action })),
      cache: 'no-store'
    });
    let payload = {};
    try { payload = await res.json(); } catch (_) {}
    if (!res.ok || !payload.ok) throw new Error(payload.error || 'The request could not be completed.');
    return payload;
  }
  const previewHost = /^deploy-preview-\d+--englishmates-ratangarh\.netlify\.app$/.test(window.location.hostname);
  function storagePath(root, rest) { return root + (previewHost ? '-preview' : '') + '/' + rest; }
  function formatMoney(paise) {
    const value = Number(paise || 0) / 100;
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
  }
  function fileBase64(file, maxBytes) {
    if (!file || file.size > maxBytes) return Promise.reject(new Error('Choose a smaller image file.'));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read the selected image.'));
      reader.readAsDataURL(file);
    });
  }
  function youtubeId(value) {
    const match = String(value || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
    return match ? match[1] : '';
  }
  function setMessage(id, message, isError) {
    const target = $(id);
    if (!target) return;
    target.textContent = message || '';
    target.className = 'text-sm mt-3 ' + (isError ? 'text-rose-300' : 'text-emerald-300');
  }
  function bindAuth() {
    const signIn = $('signInBtn');
    const signUp = $('signUpBtn');
    const google = $('googleBtn');
    const signOut = $('signOutBtn');
    if (signIn) signIn.addEventListener('click', async () => {
      try {
        await auth.signInWithEmailAndPassword($('authEmail').value.trim(), $('authPassword').value);
        setMessage('authMessage', 'Signed in. Checking your account…', false);
      } catch (e) { setMessage('authMessage', e.message, true); }
    });
    if (signUp) signUp.addEventListener('click', async () => {
      try {
        const email = $('authEmail').value.trim();
        const password = $('authPassword').value;
        if (password.length < 8) throw new Error('Choose a password with at least 8 characters.');
        const result = await auth.createUserWithEmailAndPassword(email, password);
        await result.user.sendEmailVerification({ url: Englishmates.page('student-dashboard.html'), handleCodeInApp: false });
        setMessage('authMessage', 'Account created. Verify the link sent to your email, then return here.', false);
      } catch (e) { setMessage('authMessage', e.message, true); }
    });
    if (google) google.addEventListener('click', async () => {
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await auth.signInWithPopup(provider);
        setMessage('authMessage', 'Signed in with Google.', false);
      } catch (e) { setMessage('authMessage', e.message, true); }
    });
    if (signOut) signOut.addEventListener('click', async () => {
      await auth.signOut();
      setMessage('authMessage', 'You are signed out.', false);
    });
    auth.onAuthStateChanged(async user => {
      if (user) await user.reload().catch(() => {});
      const email = user && user.email ? user.email : '';
      const verified = !!(user && user.emailVerified);
      const identity = $('authIdentity');
      if (identity) identity.textContent = user ? (email + (verified ? ' · verified' : ' · verify email')) : 'Not signed in';
      if (signOut) signOut.classList.toggle('hidden', !user);
      document.dispatchEvent(new CustomEvent('lms-auth-changed', { detail: { user: user || null, verified } }));
    });
  }
  window.LMS = Object.freeze({ auth, storage, api, escape, formatMoney, youtubeId, storagePath, fileBase64, setMessage, bindAuth });
}());
