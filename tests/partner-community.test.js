const test = require('node:test');
const assert = require('node:assert/strict');
const cors = require('../netlify/lib/cors');
const {
  LEVELS, hasContactDetails, isOnline, matchingScore, pairId,
  publicPartner, safeAvatar, timestampMs
} = require('../netlify/lib/partner-community');

const approvedProfile = overrides => ({
  status: 'approved',
  countryStatus: 'approved',
  moderationStatus: 'active',
  availableForRequests: true,
  availability: 'available',
  lastSeenAt: 99500,
  level: 'Intermediate',
  preferredLanguage: 'English',
  interests: ['Daily conversation'],
  ...overrides
});

test('pair identifiers do not depend on request direction', () => {
  assert.equal(pairId('learner-a', 'learner-b'), pairId('learner-b', 'learner-a'));
  assert.match(pairId('learner-a', 'learner-b'), /^[a-f0-9]{64}$/);
  assert.notEqual(pairId('learner-a', 'learner-b'), pairId('learner-a', 'learner-c'));
});

test('contact detail detection catches email and Indian mobile numbers', () => {
  assert.equal(hasContactDetails('write to learner@example.com'), true);
  assert.equal(hasContactDetails('Call me at +91 98765 43210'), true);
  assert.equal(hasContactDetails('I enjoy public speaking'), false);
});

test('only trusted HTTPS profile image hosts are accepted', () => {
  assert.equal(safeAvatar('https://lh3.googleusercontent.com/photo'), 'https://lh3.googleusercontent.com/photo');
  assert.equal(safeAvatar('https://firebasestorage.googleapis.com/v0/b/bucket/o/avatar'), 'https://firebasestorage.googleapis.com/v0/b/bucket/o/avatar');
  assert.equal(safeAvatar('http://lh3.googleusercontent.com/photo'), null);
  assert.equal(safeAvatar('data:image/webp;base64,QUJDRA=='), 'data:image/webp;base64,QUJDRA==');
  assert.equal(safeAvatar('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(safeAvatar('https://googleusercontent.com.evil.invalid/photo'), null);
});

test('online presence expires after five minutes and requires approval and availability', () => {
  assert.equal(isOnline(approvedProfile(), 100000), true);
  assert.equal(isOnline(approvedProfile(), 100000 + 5 * 60 * 1000 + 1), false);
  assert.equal(isOnline(approvedProfile({ status: 'pending' }), 100000), false);
  assert.equal(isOnline(approvedProfile({ availability: 'in_call' }), 100000), false);
  assert.equal(isOnline(approvedProfile({ availableForRequests: false }), 100000), false);
});

test('public partner projection excludes email, phone, location and auth data', () => {
  const result = publicPartner(approvedProfile({
    alias: 'Priya',
    email: 'private@example.com',
    phone: '9876543210',
    city: 'Private city',
    uid: 'private-uid',
    age: 30,
    intro: 'I like practising interviews.',
    avatarURL: 'https://lh3.googleusercontent.com/avatar'
  }), 100000);
  assert.deepEqual(Object.keys(result).sort(), ['alias', 'avatarURL', 'available', 'interests', 'introduction', 'level', 'online'].sort());
  assert.equal(result.alias, 'Priya');
  assert.equal(result.introduction, 'I like practising interviews.');
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
  assert.equal(JSON.stringify(result).includes('9876543210'), false);
  assert.equal(JSON.stringify(result).includes('Private city'), false);
  const unsafeAlias = publicPartner(approvedProfile({ alias: 'me@example.com' }), 100000);
  assert.equal(unsafeAlias.alias, 'English learner');
});

test('unsafe contact details are not returned in an introduction', () => {
  const result = publicPartner(approvedProfile({ intro: 'Email me at person@example.com' }), 100000);
  assert.equal(result.introduction, '');
});

test('all five requested proficiency levels are supported', () => {
  assert.deepEqual(LEVELS, ['Beginner', 'Elementary', 'Intermediate', 'Upper Intermediate', 'Advanced']);
  assert.equal(matchingScore(approvedProfile({ level: 'Intermediate' }), approvedProfile({ level: 'Upper Intermediate' })) > 0, true);
});

test('matching rejects distant levels and missing common interests', () => {
  assert.equal(matchingScore(approvedProfile({ level: 'Beginner' }), approvedProfile({ level: 'Advanced' })), -1);
  assert.equal(matchingScore(approvedProfile(), approvedProfile({ interests: ['Interview'] })), -1);
});

test('timestamp values accept Firestore-like timestamps and ISO strings', () => {
  assert.equal(timestampMs({ toMillis: () => 1234 }), 1234);
  assert.equal(timestampMs('2026-11-14T00:00:00.000Z'), Date.parse('2026-11-14T00:00:00.000Z'));
});

test('CORS allows only the configured preview origin pattern', () => {
  const preview = cors.headers({ headers: { origin: 'https://deploy-preview-21--englishmates-ratangarh.netlify.app' } });
  const production = cors.headers({ headers: { origin: 'https://englishmates-ratangarh.netlify.app' } });
  const attacker = cors.headers({ headers: { origin: 'https://deploy-preview-21--other-site.netlify.app' } });
  assert.equal(preview['Access-Control-Allow-Origin'], 'https://deploy-preview-21--englishmates-ratangarh.netlify.app');
  assert.equal(production['Access-Control-Allow-Origin'], 'https://englishmates-ratangarh.netlify.app');
  assert.equal(attacker['Access-Control-Allow-Origin'], undefined);
});