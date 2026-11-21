const crypto = require('crypto');

const LEVELS = ['Beginner', 'Elementary', 'Intermediate', 'Upper Intermediate', 'Advanced'];
const TOPICS = ['Daily conversation', 'Interview', 'Public speaking', 'Grammar', 'Vocabulary', 'Travel', 'Personality development'];
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function clean(value, max = 180) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}
function timestampMs(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
function hasContactDetails(value) {
  const text = String(value || '');
  const digits = text.replace(/\D/g, '');
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) || /0?[6-9]\d{9}/.test(digits);
}
function safeAvatar(value) {
  const text = String(value || '').trim();
  if (text.length <= 30000 && /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(text)) return text;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const allowed = host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com') || host === 'firebasestorage.googleapis.com';
    return url.protocol === 'https:' && allowed ? url.href.slice(0, 1000) : null;
  } catch (_) { return null; }
}
function pairId(firstUid, secondUid) {
  return crypto.createHash('sha256').update([String(firstUid), String(secondUid)].sort().join('|')).digest('hex');
}
function isOnline(profile, nowMs = Date.now()) {
  const lastSeen = timestampMs(profile?.lastSeenAt);
  return profile?.availableForRequests !== false
    && ['available', 'waiting'].includes(profile?.availability)
    && lastSeen > 0 && nowMs - lastSeen >= 0 && nowMs - lastSeen <= ONLINE_WINDOW_MS
    && profile?.status === 'approved' && profile?.countryStatus === 'approved'
    && profile?.moderationStatus !== 'suspended';
}
function publicPartner(profile, nowMs = Date.now()) {
  const online = isOnline(profile, nowMs);
  const alias = clean(profile?.alias, 32);
  return {
    alias: hasContactDetails(alias) ? 'English learner' : alias || 'English learner',
    avatarURL: safeAvatar(profile?.avatarURL),
    level: LEVELS.includes(profile?.level) ? profile.level : 'Beginner',
    introduction: hasContactDetails(profile?.intro) ? '' : clean(profile?.intro, 180),
    interests: Array.isArray(profile?.interests) ? [...new Set(profile.interests.filter(topic => TOPICS.includes(topic)))].slice(0, 7) : [],
    online,
    available: online
  };
}
function matchingScore(one, two) {
  const oneLevel = LEVELS.indexOf(one?.level);
  const twoLevel = LEVELS.indexOf(two?.level);
  const shared = (one?.interests || []).filter(topic => (two?.interests || []).includes(topic));
  if (oneLevel < 0 || twoLevel < 0 || Math.abs(oneLevel - twoLevel) > 1 || !shared.length) return -1;
  return shared.length * 10 + (one.preferredLanguage === two.preferredLanguage ? 3 : 0);
}

module.exports = { LEVELS, TOPICS, clean, hasContactDetails, isOnline, matchingScore, pairId, publicPartner, safeAvatar, timestampMs };