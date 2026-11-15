(() => {
  'use strict';
  const CONFIG = { apiKey: 'AIzaSyCFuF2PBq09cKOHBuoLDoypEgrI1gSmm4c', authDomain: 'englishmates-ratangarh-933f1.firebaseapp.com', projectId: 'englishmates-ratangarh-933f1', storageBucket: 'englishmates-ratangarh-933f1.firebasestorage.app', messagingSenderId: '501474121790', appId: '1:501474121790:web:5097a43a6be4e7bc07996f6' };
  const $ = id => document.getElementById(id);
  let auth, approved = false, availability = true, presenceTimer = null, profileTimer = null, hubTimer = null, cursor = null, directory = [], busy = false;

  function setMessage(text, error = false) {
    $('hubMessage').textContent = text || '';
    $('hubMessage').className = 'text-sm mt-4 ' + (error ? 'text-rose-300' : 'text-emerald-300');
  }
  function make(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = text;
    return item;
  }
  function clear(target, emptyText) {
    target.replaceChildren();
    if (emptyText) target.append(make('p', 'muted text-sm', emptyText));
  }
  function avatar(profile, size) {
    const box = make('div', (size || 'h-11 w-11') + ' shrink-0 rounded-full overflow-hidden grid place-items-center bg-violet-500/20 text-violet-100 font-black');
    const url = String(profile.avatarURL || '');
    if (/^data:image\/(?:webp|png|jpeg);base64,/i.test(url) || /^https:\/\/(?:[^/]+\.)?googleusercontent\.com\//i.test(url) || /^https:\/\/firebasestorage\.googleapis\.com\//i.test(url)) {
      const image = make('img', 'h-full w-full object-cover');
      image.src = url;
      image.alt = '';
      box.append(image);
    } else {
      box.textContent = Array.from(String(profile.alias || 'P').trim())[0]?.toUpperCase() || 'P';
    }
    return box;
  }
  function button(label, style, handler, disabled) {
    const control = make('button', 'btn ' + style, label);
    control.type = 'button';
    control.disabled = !!disabled;
    control.addEventListener('click', handler);
    return control;
  }
  async function api(method, payload) {
    const url = Englishmates.api('calling-partners') + (method === 'GET' ? '?' + new URLSearchParams(payload || {}).toString() : '');
    const response = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + await auth.currentUser.getIdToken(), 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'The community request could not be completed.');
    return result;
  }
  async function communityProfile() {
    const response = await fetch(Englishmates.api('calling-community'), { headers: { Authorization: 'Bearer ' + await auth.currentUser.getIdToken(), 'Content-Type': 'application/json' }, cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load your speaking profile.');
    return result.profile;
  }
  async function sendPresence() {
    if (!approved || !auth.currentUser) return;
    try { await api('POST', { action: 'heartbeat' }); } catch (_) {}
  }
  function renderPartnerCard(profile, requestHandler) {
    const card = make('article', 'rounded-2xl border border-slate-700 bg-slate-950/30 p-4');
    const heading = make('div', 'flex items-center gap-3');
    heading.append(avatar(profile));
    const identity = make('div', 'min-w-0');
    identity.append(make('h4', 'font-bold truncate', profile.alias || 'English learner'));
    identity.append(make('p', 'text-xs ' + (profile.online ? 'text-emerald-300' : 'muted'), (profile.online ? 'Online and available' : 'Offline') + ' · ' + (profile.level || '')));
    heading.append(identity);
    card.append(heading);
    card.append(make('p', 'text-sm text-slate-300 mt-3', profile.introduction || 'Ready to practise English with a new partner.'));
    const interests = make('div', 'flex flex-wrap gap-1.5 mt-3');
    (profile.interests || []).forEach(topic => interests.append(make('span', 'rounded-full bg-white/5 px-2 py-1 text-[11px] text-slate-300', topic)));
    card.append(interests);
    const connect = button('Send speaking request', 'primary w-full mt-4', requestHandler);
    card.append(connect);
    return card;
  }
  function renderDirectory(items, append) {
    const target = $('directoryResults');
    if (!append) { target.replaceChildren(); directory = []; }
    directory = directory.concat(items || []);
    if (!directory.length) {
      clear(target, 'No approved learners match these filters right now. Try another topic or search later.');
    } else {
      target.replaceChildren();
      directory.forEach(profile => target.append(renderPartnerCard(profile, async event => {
        event.currentTarget.disabled = true;
        try {
          const result = await api('POST', { action: 'send-request', peerUid: profile.uid });
          setMessage(result.message);
          await loadHub();
          await search(false);
        } catch (error) {
          event.currentTarget.disabled = false;
          setMessage(error.message, true);
        }
      })));
    }
    $('directoryNext').classList.toggle('hidden', !cursor);
  }
  async function search(append, random) {
    if (busy) return;
    busy = true;
    const target = $('directoryResults');
    if (!append) {
      cursor = null;
      directory = [];
      clear(target, random ? 'Finding an online compatible learner…' : 'Searching approved learners…');
    }
    try {
      const params = { view: 'directory' };
      if (random) params.random = '1';
      else {
        if ($('partnerSearch').value.trim()) params.q = $('partnerSearch').value.trim();
        if ($('partnerLevel').value) params.level = $('partnerLevel').value;
        if ($('partnerTopic').value) params.topic = $('partnerTopic').value;
        if ($('partnerOnline').checked) params.online = '1';
        if (append && cursor) params.cursor = cursor;
      }
      const result = await api('GET', params);
      if (random) {
        cursor = null;
        if (!result.partner) renderDirectory([], false);
        else renderDirectory([result.partner], false);
      } else {
        cursor = result.nextCursor || null;
        renderDirectory(result.partners || [], append);
      }
      $('directoryNext').classList.toggle('hidden', random || !cursor);
    } catch (error) {
      clear(target, error.message);
      $('directoryNext').classList.add('hidden');
    } finally { busy = false; }
  }
  function renderRequests(target, items, incoming) {
    target.replaceChildren();
    if (!items.length) { clear(target, 'No pending requests.'); return; }
    items.forEach(item => {
      const card = make('article', 'rounded-xl border border-slate-700 p-3');
      const row = make('div', 'flex items-center gap-2');
      row.append(avatar(item.partner, 'h-9 w-9'));
      const label = make('div');
      label.append(make('p', 'font-bold text-sm', item.partner.alias));
      label.append(make('p', 'muted text-xs', incoming ? 'wants to practise with you' : 'waiting for your reply'));
      row.append(label); card.append(row);
      const controls = make('div', 'flex gap-2 mt-3');
      if (incoming) {
        controls.append(button('Accept', 'green flex-1', () => requestAction('accept-request', item.id)));
        controls.append(button('Decline', 'red', () => requestAction('reject-request', item.id)));
      } else controls.append(button('Cancel request', 'border border-slate-600 w-full', () => requestAction('cancel-request', item.id)));
      card.append(controls); target.append(card);
    });
  }
  async function requestAction(action, requestId) {
    try { const result = await api('POST', { action, requestId }); setMessage(result.message); await loadHub(); }
    catch (error) { setMessage(error.message, true); }
  }
  function renderUpdates(items) {
    const target = $('requestUpdates'); target.replaceChildren();
    if (!items.length) { clear(target, 'Updates will appear here.'); return; }
    const labels = { accepted: 'Accepted · you are connected', rejected: 'Declined', cancelled: 'Cancelled', expired: 'Expired' };
    items.forEach(item => { const row = make('article', 'rounded-xl border border-slate-700 p-3'); row.append(make('p', 'font-bold text-sm', item.partner.alias)); row.append(make('p', 'muted text-xs mt-1', (labels[item.status] || item.status) + (item.createdAt ? ' · ' + new Date(item.createdAt).toLocaleDateString() : ''))); target.append(row); });
  }
  function renderConnections(items) {
    const target = $('partnerConnections');
    target.replaceChildren();
    if (!items.length) { clear(target, 'Accepted speaking partners will appear here.'); return; }
    items.forEach(item => {
      const card = make('article', 'rounded-xl border border-slate-700 p-3');
      const row = make('div', 'flex items-center gap-2');
      row.append(avatar(item.partner, 'h-10 w-10'));
      const label = make('div');
      label.append(make('p', 'font-bold', item.partner.alias));
      label.append(make('p', 'text-xs ' + (item.partner.online ? 'text-emerald-300' : 'muted'), (item.partner.online ? 'Online' : 'Offline') + ' · ' + (item.partner.level || '')));
      row.append(label); card.append(row);
      const actions = make('div', 'flex flex-wrap gap-2 mt-3');
      actions.append(button(item.partner.online ? 'Invite to audio call' : 'Call when online', 'green flex-1', () => connectionCall(item.id), !item.partner.online));
      actions.append(button('Block', 'border border-rose-400/40 text-rose-200', () => blockPartner(item.peerId)));
      actions.append(button('Report', 'border border-amber-400/40 text-amber-100', () => reportPartner(item.peerId)));
      card.append(actions); target.append(card);
    });
  }
  async function connectionCall(connectionId) {
    try { const result = await api('POST', { action: 'start-partner-call', connectionId }); setMessage(result.message); await loadHub(); }
    catch (error) { setMessage(error.message, true); }
  }
  async function blockPartner(peerUid) {
    if (!confirm('Block this learner and prevent future requests or calls?')) return;
    try { const result = await api('POST', { action: 'block-partner', peerUid }); setMessage(result.message); await loadHub(); await search(false); }
    catch (error) { setMessage(error.message, true); }
  }
  async function reportPartner(peerUid) {
    const reason = prompt('Why are you reporting this learner?');
    if (!reason) return;
    const details = prompt('Optional details. Do not include contact information.') || '';
    try { const result = await api('POST', { action: 'report-partner', peerUid, reason, details }); setMessage(result.message); }
    catch (error) { setMessage(error.message, true); }
  }
  function renderHistory(items) {
    const target = $('callHistory'); target.replaceChildren();
    if (!items.length) { clear(target, 'Completed calls of at least one minute appear here.'); return; }
    items.forEach(item => {
      const row = make('article', 'flex justify-between gap-3 rounded-xl border border-slate-700 p-3');
      const summary = make('div');
      summary.append(make('p', 'font-bold', item.partner.alias));
      summary.append(make('p', 'muted text-xs mt-1', item.completedAt ? new Date(item.completedAt).toLocaleString() : 'Completed call'));
      row.append(summary);
      row.append(make('p', 'text-sm text-violet-200', Math.floor((item.durationSeconds || 0) / 60) + ' min'));
      target.append(row);
    });
  }
  async function loadHub() {
    if (!approved || busy) return;
    try {
      const data = await api('GET', { view: 'hub' });
      availability = data.availability !== false;
      $('availabilityButton').textContent = availability ? 'Go offline' : 'Go online';
      $('availabilityButton').className = availability ? 'btn border border-amber-400/40 text-amber-100' : 'btn border border-emerald-400/40 text-emerald-100';
      $('statTotalCalls').textContent = String(data.stats?.totalCalls || 0);
      $('statCalls').textContent = String(data.stats?.completedCalls || 0);
      $('statMinutes').textContent = String(Math.floor((data.stats?.speakingSeconds || 0) / 60));
      $('statAverage').textContent = Math.round((data.stats?.averageSeconds || 0) / 60) + ' min';
      $('statConnections').textContent = String((data.connections || []).length);
      renderRequests($('incomingRequests'), data.incoming || [], true);
      renderRequests($('outgoingRequests'), data.outgoing || [], false);
      renderUpdates(data.updates || []);
      renderConnections(data.connections || []);
      renderHistory(data.history || []);
    } catch (error) { setMessage(error.message, true); }
  }
  async function syncProfile() {
    if (!auth.currentUser || !auth.currentUser.emailVerified) return;
    try {
      const profile = await communityProfile();
      approved = profile?.status === 'approved';
      if (approved) {
        await sendPresence();
        await loadHub();
        if (!presenceTimer) presenceTimer = setInterval(sendPresence, 60000);
        clearInterval(profileTimer); profileTimer = null;
      }
    } catch (error) { approved = false; setMessage(error.message, true); }
  }
  function bind() {
    $('refreshHub').addEventListener('click', loadHub);
    $('partnerSearchForm').addEventListener('submit', event => { event.preventDefault(); search(false, false); });
    $('directoryNext').addEventListener('click', () => search(true, false));
    $('randomPartner').addEventListener('click', async () => { await sendPresence(); await search(false, true); });
    $('availabilityButton').addEventListener('click', async () => {
      try {
        const result = await api('POST', { action: 'set-availability', available: !availability });
        setMessage(result.message); availability = !availability; await loadHub();
      } catch (error) { setMessage(error.message, true); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { sendPresence(); loadHub(); } });
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(CONFIG);
    auth = firebase.auth();
  } catch (_) { return; }
  bind();
  auth.onAuthStateChanged(async user => {
    clearInterval(presenceTimer); clearInterval(profileTimer); clearInterval(hubTimer); presenceTimer = null; profileTimer = null; hubTimer = null; approved = false;
    if (!user) return;
    await user.reload().catch(() => {});
    if (!user.emailVerified) return;
    await syncProfile();
    if (approved) hubTimer = setInterval(loadHub, 60000);
    else profileTimer = setInterval(syncProfile, 60000);
  });
})();