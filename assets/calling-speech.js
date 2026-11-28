(() => {
  'use strict';
  let active = null;
  const SEGMENT_MS = 8000;
  function signal(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail })); }
  function toBase64(blob) {
    return blob.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(start, Math.min(start + 0x8000, bytes.length)));
      return btoa(binary);
    });
  }
  function stop(contextType) {
    if (!active || (contextType && active.contextType !== contextType)) return;
    const current = active;
    active = null;
    current.stopped = true;
    clearTimeout(current.timer);
    try { if (current.recorder && current.recorder.state !== 'inactive') current.recorder.stop(); } catch (_) {}
  }
  async function sendSegment(current, blob, sequence) {
    try {
      if (!firebase.auth().currentUser) throw new Error('Sign in again to continue audio moderation.');
      const audioBase64 = await toBase64(blob);
      const response = await fetch(Englishmates.api('calling-transcription'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + await firebase.auth().currentUser.getIdToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(current.contextType === 'session' ? { sessionId: current.contextId } : { roomId: current.contextId }),
          sequence, durationSeconds: 8, mimeType: blob.type || 'audio/webm', audioBase64
        }), cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        signal('calling-billing-status', {
          usedSeconds: data.paidActive ? 0 : Math.max(0, 600 - Number(data.remainingSeconds || 0)),
          remainingSeconds: data.remainingSeconds, paidActive: data.paidActive
        });
        if (data.message && current.onStatus) current.onStatus(data.message);
        if (data.blocked) {
          stop(current.contextType);
          signal('calling-speech-blocked', { contextType: current.contextType, contextId: current.contextId, message: data.message });
        } else if (!data.paidActive && Number(data.remainingSeconds) <= 0) {
          stop(current.contextType);
          signal('calling-quota-exhausted', { contextType: current.contextType, contextId: current.contextId, message: 'Today’s 10 free audio minutes are used. Activate a 30-day pass to continue.' });
        }
        return;
      }
      if (response.status === 402) {
        stop(current.contextType);
        signal('calling-quota-exhausted', { contextType: current.contextType, contextId: current.contextId, message: data.error || 'Today’s free audio minutes are used. Activate a pass to continue.' });
        return;
      }
      throw new Error(data.error || 'Live language moderation is unavailable. Audio was stopped for safety.');
    } catch (error) {
      if (active === current) stop(current.contextType);
      signal('calling-speech-error', { contextType: current.contextType, contextId: current.contextId, message: error.message || 'Live speech moderation stopped.' });
    }
  }
  function startSegment(current) {
    if (active !== current || current.stopped || current.track.readyState === 'ended') return;
    try {
      const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : { mimeType: 'audio/webm' };
      const recorder = new MediaRecorder(current.stream, options);
      current.recorder = recorder;
      current.parts = [];
      recorder.ondataavailable = event => { if (event.data && event.data.size) current.parts.push(event.data); };
      recorder.onerror = () => {
        if (active === current) stop(current.contextType);
        signal('calling-speech-error', { contextType: current.contextType, contextId: current.contextId, message: 'Your browser could not capture the short audio segment required for language moderation.' });
      };
      recorder.onstop = () => {
        const blob = new Blob(current.parts, { type: recorder.mimeType || 'audio/webm' });
        const sequence = current.sequence++;
        if (blob.size && !current.stopped) void sendSegment(current, blob, sequence);
        if (active === current && !current.stopped) startSegment(current);
      };
      recorder.start();
      current.timer = setTimeout(() => { if (active === current && recorder.state === 'recording') recorder.stop(); }, SEGMENT_MS);
    } catch (_) {
      stop(current.contextType);
      signal('calling-speech-error', { contextType: current.contextType, contextId: current.contextId, message: 'Live language moderation is unsupported by this browser. Audio was stopped.' });
    }
  }
  function start(track, context, onStatus) {
    stop();
    if (!track || !window.MediaRecorder || !window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus') && !window.MediaRecorder.isTypeSupported('audio/webm')) {
      signal('calling-speech-error', { contextType: context?.roomId ? 'room' : 'session', contextId: context?.roomId || context?.sessionId || '', message: 'This browser cannot provide the required private speech moderation, so audio cannot start.' });
      return;
    }
    const contextType = context?.roomId ? 'room' : 'session';
    const contextId = context?.roomId || context?.sessionId;
    try {
      active = { contextType, contextId, track, stream: new MediaStream([track]), sequence: 0, recorder: null, timer: null, stopped: false, parts: [], onStatus };
      startSegment(active);
    } catch (_) {
      signal('calling-speech-error', { contextType, contextId, message: 'Live language moderation could not start. Audio was stopped.' });
    }
  }
  window.CallingSpeech = { start, stop };
})();
