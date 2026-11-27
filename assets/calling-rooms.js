(() => {
  'use strict';
  const cfg = { apiKey: 'AIzaSyCFuF2PBq09cKOHBuoLDoypEgrI1gSmm4c', authDomain: 'englishmates-ratangarh-933f1.firebaseapp.com', projectId: 'englishmates-ratangarh-933f1', storageBucket: 'englishmates-ratangarh-933f1.firebasestorage.app', messagingSenderId: '501474121790', appId: '1:501474121790:web:5097a43a6be4e7bc07996f6' };
  const $ = id => document.getElementById(id);
  let auth, data = null, timer = null, countdownTimer = null, working = false;
  let rtcClient = null, microphone = null, remoteTracks = new Map(), muted = false, joinedRoomId = null;
  const apiUrl = Englishmates.api('calling-rooms');

  function note(text, error) {
    const node = $('roomMessage');
    node.textContent = text || '';
    node.className = 'text-sm mt-4 ' + (error ? 'text-rose-300' : 'text-emerald-300');
  }
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function button(label, className, handler, disabled) {
    const node = make('button', 'btn ' + className, label);
    node.type = 'button';
    node.disabled = !!disabled;
    node.addEventListener('click', handler);
    return node;
  }
  async function call(method, payload) {
    const url = method === 'GET' ? apiUrl : apiUrl;
    const response = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + await auth.currentUser.getIdToken(), 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'The room request could not be completed.');
    return result;
  }
  function renderRooms(rooms) {
    const target = $('roomList');
    target.replaceChildren();
    const items = (rooms || []).filter(room => !data?.myRoom || room.id !== data.myRoom.id);
    if (!items.length) {
      target.append(make('p', 'muted text-sm', 'No open rooms right now. Start a room above, or check back in a moment.'));
      return;
    }
    items.forEach(room => {
      const card = make('article', 'rounded-xl border border-slate-700 bg-slate-900/50 p-4');
      const top = make('div', 'flex flex-wrap justify-between gap-2 items-start');
      const titleWrap = make('div', 'min-w-0');
      titleWrap.append(make('p', 'text-[11px] uppercase tracking-wider text-cyan-200 font-black', room.topic || 'Speaking room'));
      titleWrap.append(make('h4', 'font-bold mt-1 break-words', room.title || room.topic || 'Speaking room'));
      top.append(titleWrap, make('span', 'tag text-xs', String(room.seatsLeft) + ' seat' + (room.seatsLeft === 1 ? '' : 's') + ' left'));
      card.append(top);
      card.append(make('p', 'muted text-xs mt-2', 'Hosted by ' + (room.hostAlias || 'English learner') + ' · ' + (room.level || 'All levels') + ' · ' + room.durationMinutes + ' min'));
      if (room.prompt) card.append(make('p', 'text-sm text-slate-200 mt-3', room.prompt));
      card.append(make('p', 'muted text-xs mt-2', String(room.memberCount) + '/' + String(room.capacity) + ' people · audio only'));
      const levelMismatch = room.level !== 'All levels' && data?.profileLevel && room.level !== data.profileLevel;
      card.append(button(levelMismatch ? 'For ' + room.level + ' learners' : room.seatsLeft ? 'Join room' : 'Room full', room.seatsLeft && !levelMismatch && !data?.myRoom ? 'green w-full mt-3' : 'border border-slate-600 w-full mt-3', () => joinRoom(room.id), !room.seatsLeft || !!levelMismatch || !!data?.myRoom));
      target.append(card);
    });
  }
  function renderMembers(room) {
    const target = $('roomMembers');
    target.replaceChildren();
    const me = (room.members || []).find(member => member.isYou);
    const isHost = me?.role === 'Host';
    (room.members || []).forEach(member => {
      const item = make('div', 'flex flex-wrap items-center gap-2 rounded-xl border border-slate-600 bg-slate-950/50 px-3 py-2');
      item.append(make('span', 'font-bold text-sm', member.alias + (member.isYou ? ' (you)' : '')));
      item.append(make('span', 'muted text-xs', member.role + ' · ' + member.level));
      if (!member.isYou) {
        if (isHost) item.append(button('Remove', 'border border-rose-400/40 text-rose-200 text-xs px-2 py-1', async () => {
          if (!confirm('Remove this learner from the room?')) return;
          await runAction({ action: 'remove-member', roomId: room.id, memberId: member.memberId });
        }));
        item.append(button(isHost ? 'Block' : 'Block + leave', 'border border-amber-400/30 text-amber-100 text-xs px-2 py-1', async () => {
          if (!confirm(isHost ? 'Block and remove this learner from the room?' : 'Block this learner and leave the shared room?')) return;
          await runAction({ action: 'block-member', roomId: room.id, memberId: member.memberId });
        }));
        item.append(button('Report', 'border border-slate-600 text-xs px-2 py-1', () => reportRoom(member.memberId)));
      }
      target.append(item);
    });
  }
  function setRoomControls(room) {
    const host = (room.members || []).some(member => member.isYou && member.role === 'Host');
    $('endRoomButton').classList.toggle('hidden', !host);
    $('endRoomButton').textContent = 'End room for everyone';
    $('connectRoomAudio').classList.toggle('hidden', joinedRoomId === room.id && !!rtcClient);
    $('muteRoomAudio').classList.toggle('hidden', !(joinedRoomId === room.id && !!rtcClient));
    $('leaveRoomButton').textContent = host ? 'Leave and end room' : 'Leave room';
    $('muteRoomAudio').textContent = muted ? 'Unmute microphone' : 'Mute microphone';
    $('muteRoomAudio').setAttribute('aria-pressed', String(muted));
  }
  function render(dataFromServer) {
    data = dataFromServer;
    $('roomCreateForm').classList.toggle('opacity-50', !!data.myRoom);
    $('createRoomButton').disabled = !!data.myRoom;
    $('activeRoomCard').classList.toggle('hidden', !data.myRoom);
    if (data.myRoom) {
      const room = data.myRoom;
      $('activeRoomTitle').textContent = room.title || room.topic;
      $('activeRoomMeta').textContent = room.topic + ' · Hosted by ' + room.hostAlias + ' · ' + room.memberCount + '/' + room.capacity + ' people · ' + room.level + ' · ' + room.durationMinutes + ' minutes';
      $('activeRoomPrompt').textContent = room.prompt ? 'Opening prompt: ' + room.prompt : 'Choose a simple question and give everyone a chance to speak.';
      renderMembers(room);
      setRoomControls(room);
      updateCountdown(room);
    } else {
      $('activeRoomPrompt').textContent = '';
      if (joinedRoomId) disconnectAudio();
      $('roomCountdown').textContent = '';
    }
    renderRooms(data.rooms || []);
  }
  function updateCountdown(room) {
    const left = Math.max(0, Math.ceil((Date.parse(room.expiresAt || '') - Date.now()) / 1000));
    $('roomCountdown').textContent = left ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' left' : 'Ending…';
  }
  async function refresh() {
    if (!auth?.currentUser || !auth.currentUser.emailVerified || working || document.hidden) return;
    working = true;
    try {
      const previousId = data?.myRoom?.id || null;
      const result = await call('GET');
      render(result);
      if (previousId && !result.myRoom && joinedRoomId) await disconnectAudio();
    } catch (error) {
      if (error.message !== 'Complete your speaking profile first.') note(error.message, true);
      else note('Complete your speaking profile to create or join rooms.', false);
    } finally { working = false; }
  }
  async function runAction(payload) {
    if (!auth?.currentUser || working) return;
    working = true;
    try {
      const result = await call('POST', payload);
      note(result.message || 'Done.');
      await refreshAfterAction();
    } catch (error) {
      note(error.message, true);
      await refreshAfterAction();
    } finally { working = false; }
  }
  async function refreshAfterAction() {
    try {
      const result = await call('GET');
      render(result);
    } catch (_) {}
  }
  async function loadAgora() {
    if (window.AgoraRTC) return window.AgoraRTC;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://download.agora.io/sdk/release/AgoraRTC_N-4.23.2.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('The audio service could not load.'));
      document.head.appendChild(script);
    });
    return window.AgoraRTC;
  }
  async function audioToken(roomId) {
    const response = await fetch(Englishmates.api('calling-token'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + await auth.currentUser.getIdToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Room audio could not start.');
    return result;
  }
  async function disconnectAudio() {
    if (microphone) { microphone.stop(); microphone.close(); microphone = null; }
    if (rtcClient) { await rtcClient.leave().catch(() => {}); rtcClient = null; }
    remoteTracks.clear();
    joinedRoomId = null;
    muted = false;
    $('connectRoomAudio').textContent = 'Join room audio';
    $('roomAudioStatus').textContent = 'Your microphone stays off until you choose “Join room audio”.';
    if (data?.myRoom) setRoomControls(data.myRoom);
  }
  async function connectAudio() {
    const room = data?.myRoom;
    if (!room || joinedRoomId === room.id) return;
    const buttonNode = $('connectRoomAudio');
    buttonNode.disabled = true;
    buttonNode.textContent = 'Connecting…';
    try {
      const AgoraRTC = await loadAgora();
      const credentials = await audioToken(room.id);
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      rtcClient = client;
      client.on('user-published', async (remoteUser, mediaType) => {
        if (client !== rtcClient) return;
        await client.subscribe(remoteUser, mediaType);
        if (mediaType === 'audio' && remoteUser.audioTrack) {
          remoteTracks.set(remoteUser.uid, remoteUser.audioTrack);
          remoteUser.audioTrack.play();
          remoteUser.audioTrack.setVolume(100);
        }
      });
      client.on('user-unpublished', (remoteUser, mediaType) => {
        if (mediaType === 'audio') remoteTracks.delete(remoteUser.uid);
      });
      client.on('user-left', remoteUser => {
        remoteTracks.delete(remoteUser.uid);
        $('roomAudioStatus').textContent = 'A learner left the audio room.';
      });
      client.on('token-privilege-will-expire', async () => {
        try {
          const fresh = await audioToken(room.id);
          if (client === rtcClient) await client.renewToken(fresh.token);
        } catch (error) { $('roomAudioStatus').textContent = error.message + ' Leave and rejoin the room audio.'; }
      });
      await client.join(credentials.appId, credentials.channel, credentials.token, credentials.uid);
      microphone = await AgoraRTC.createMicrophoneAudioTrack();
      await client.publish([microphone]);
      joinedRoomId = room.id;
      $('roomAudioStatus').textContent = 'Connected to the topic room · audio only.';
      buttonNode.textContent = 'Audio connected';
      buttonNode.disabled = false;
      setRoomControls(room);
    } catch (error) {
      await disconnectAudio();
      buttonNode.disabled = false;
      buttonNode.textContent = 'Join room audio';
      $('roomAudioStatus').textContent = error.message;
      note(error.message, true);
    }
  }
  async function joinRoom(roomId) {
    try {
      const result = await call('POST', { action: 'join-room', roomId });
      note(result.message);
      await refreshAfterAction();
      if (data?.myRoom?.id === roomId) await connectAudio();
    } catch (error) { note(error.message, true); }
  }
  async function createRoom(event) {
    event.preventDefault();
    const buttonNode = $('createRoomButton');
    if (buttonNode.disabled) return;
    buttonNode.disabled = true;
    try {
      const result = await call('POST', {
        action: 'create-room',
        topic: $('roomTopic').value,
        title: $('roomTitle').value.trim(),
        prompt: $('roomPrompt').value.trim(),
        level: $('roomLevel').value,
        durationMinutes: Number($('roomDuration').value),
        capacity: Number($('roomCapacity').value)
      });
      $('roomCreateForm').reset();
      $('roomLevel').value = 'All levels';
      $('roomDuration').value = '15';
      $('roomCapacity').value = '3';
      note(result.message);
      await refreshAfterAction();
      if (data?.myRoom?.id === result.roomId) await connectAudio();
    } catch (error) { note(error.message, true); }
    finally { buttonNode.disabled = !!data?.myRoom; }
  }
  async function reportRoom(memberId) {
    const reason = prompt('What happened in this room? Choose or describe a reason.');
    if (!reason) return;
    const details = prompt('Optional details. Do not include contact information.') || '';
    await runAction({ action: 'report-room', roomId: data?.myRoom?.id, memberId: memberId || '', reason, details });
  }
  function bind() {
    $('roomCreateForm').addEventListener('submit', createRoom);
    $('refreshRooms').addEventListener('click', refresh);
    $('connectRoomAudio').addEventListener('click', connectAudio);
    $('muteRoomAudio').addEventListener('click', async () => {
      if (!microphone) return;
      muted = !muted;
      try {
        await microphone.setEnabled(!muted);
        $('muteRoomAudio').textContent = muted ? 'Unmute microphone' : 'Mute microphone';
        $('muteRoomAudio').setAttribute('aria-pressed', String(muted));
        $('roomAudioStatus').textContent = muted ? 'Your microphone is muted.' : 'Your microphone is on.';
      } catch (error) { note(error.message, true); }
    });
    $('leaveRoomButton').addEventListener('click', async () => {
      if (!data?.myRoom) return;
      await disconnectAudio();
      await runAction({ action: 'leave-room', roomId: data.myRoom.id });
    });
    $('endRoomButton').addEventListener('click', async () => {
      if (!data?.myRoom || !confirm('End this room for everyone?')) return;
      await disconnectAudio();
      await runAction({ action: 'end-room', roomId: data.myRoom.id });
    });
    $('reportRoomButton').addEventListener('click', () => reportRoom(''));
    auth.onAuthStateChanged(async user => {
      clearInterval(timer); clearInterval(countdownTimer); timer = null; countdownTimer = null;
      if (!user || !user.emailVerified) { data = null; render({ rooms: [], myRoom: null }); return; }
      await refresh();
      timer = setInterval(async () => {
        if (document.hidden) return;
        if (data?.myRoom) {
          try { await call('POST', { action: 'heartbeat', roomId: data.myRoom.id }); } catch (_) {}
        }
        await refresh();
      }, 12000);
      countdownTimer = setInterval(() => { if (data?.myRoom) updateCountdown(data.myRoom); }, 1000);
    });
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    auth = firebase.auth();
    bind();
  } catch (_) {
    if ($('roomMessage')) note('The room service could not start. Refresh this page and try again.', true);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();