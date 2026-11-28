# Calling Community and Find Your Partner

## Included in this preview branch

- One-to-one calls and topic rooms display English conversation questions while audio is connected, rotating about every two minutes with a manual “Next question” control. Prompts are shown in the page and are not sent as chat messages.
- Clear English-practice and respectful-conduct reminders appear in calls and rooms. Call audio remains unrecorded and is not transcribed; the app does not automatically detect a learner’s spoken language or issue language-based blocks.

- Verified Google or email/password sign-in (email accounts verify by link, with no SMS OTP) and automatic learner profile activation; admins can block or suspend access when needed.
- Searchable directory of active learners, proficiency and topic filters, online-only filtering, compatible random matching, and paginated results.
- Speaking requests with duplicate protection, recipient accept/reject, sender cancellation, and 14-day expiration.
- Live, topic-based audio rooms: authenticated learners can host rooms for 3–8 total people, choose a conversation prompt, level, and 15/30/45-minute duration, and let other eligible learners join while seats remain. The room list enforces level selection on the server. No camera or recording is used.
- Mobile-first, seven-step learner profile setup with a progress indicator, one small group of questions per step, in-place validation, Back/Continue controls, and skippable photo/introduction fields. Existing profile fields and API payloads are preserved.
- Room host controls: end the room, remove a learner, and report or block a participant. Learners can mute, leave, report, or block. The admin dashboard lists active rooms and can end one. No live audio monitoring is available; room audio is not recorded.
- Presence heartbeats clean up abandoned rooms and seats; host loss or the time limit ends the room and releases participant availability. A learner can only be in one room or one-to-one call at a time.
- Accepted connections with an audio-call invitation flow. Calls use the existing Agora RTC token service and never create or publish a camera track.
- Audio mute, pause, end, private text, block, report, short-lived Agora tokens, and server-side state checks.
- Server-recorded completed-call duration and learner call history/statistics. A session counts after both learners accept, it runs at least 60 seconds, and a participant ends it or the server expires it.
- Admin summary counts for approved profiles, completed calls, active calls, and call-setup issues in the last 24 hours. Admin metrics do not include private messages or microphone data.
- A profile introduction and optional compressed profile-picture upload. PNG/JPEG/WebP images are resized to 128 px and capped at 20 KB before they are stored in the protected profile document; users without a photo see initials. A verified Google profile image is used when available.
- All private learner data is accessed through authenticated Netlify Functions. Firestore browser rules remain default-deny.

The five proficiency levels are Beginner, Elementary, Intermediate, Upper Intermediate, and Advanced. Partner directory cards show the chosen speaking name, profile image or initials, level, short introduction, interests, and availability. Calls show only speaking name and profile image or initials; email, phone, age, exact location, and private profile fields are not returned to the call partner.

## Data and deployment boundaries

Calling Community data uses the shared Firebase project but separates Netlify Production from Deploy Preview by collection suffix:

| Data | Production collection | Deploy Preview collection |
| --- | --- | --- |
| Learner profiles | callingProfiles | callingProfilesPreview |
| Matching queue | callingQueues | callingQueuesPreview |
| Audio sessions and private messages | callingSessions | callingSessionsPreview |
| Connection requests | callingPartnerRequests | callingPartnerRequestsPreview |
| Accepted connections | callingPartnerConnections | callingPartnerConnectionsPreview |
| Blocks and reports | callingBlocks, callingReports | callingBlocksPreview, callingReportsPreview |
| Rate limits and moderation audit | callingRateLimits, callingModerationAudit | callingRateLimitsPreview, callingModerationAuditPreview |
| Audio setup failures | callingFailures | callingFailuresPreview |
| Live topic rooms | callingRooms | callingRoomsPreview |

All these collections are explicitly denied to browser clients in firestore.rules; requests, profiles, calls and moderation actions go through authenticated Netlify functions. Profile-picture bytes are stored only in the matching preview/live profile collection and are included only in authenticated partner responses. Current queries use Firestore single-field indexes only, so no composite index file is required. No production Firestore rule deployment or production database write was performed.

## Required Netlify settings

The existing service variables are required in the Deploy Preview context:

- FIREBASE_SERVICE_ACCOUNT_JSON
- FIREBASE_PROJECT_ID (englishmates-ratangarh-933f1)
- AGORA_APP_ID
- AGORA_APP_CERTIFICATE

The Agora certificate stays in Netlify and is used only to mint five-minute, membership-scoped tokens for one-to-one calls and topic rooms. Group-room participant UIDs are unique per room membership; no extra environment variable is required. If a required variable is absent, the preview shows a configuration error. A learner profile activates automatically after Google sign-in and submission of the required profile fields. Existing pending profiles are automatically activated when the learner loads their profile or an administrator opens the dashboard. Preview API calls use preview-suffixed collections. The code has not been published to the production website.

Agora RTC provides the existing managed real-time audio transport for one-to-one calls and group rooms of up to eight participants. The existing browser SDK subscribes to each remote learner's audio stream; this branch does not add a separate media vendor. No camera or recording track is initialized. Group usage consumes audio participant-minutes for each person in a room, so actual billing depends on room size and duration.

## Verification before rollout

The room flow should be verified on the Deploy Preview with three signed-in learner accounts in separate browser sessions: create a room, fill its seats, confirm level restrictions, join audio, test each learner's mute/leave controls, have the host remove a learner and end the room, and test an admin end-room action. Also verify host disconnect and duration expiry release all account locks. API authorization and concurrent seat limits should be checked in a Firebase Emulator or isolated test project before production.

The call must also be checked manually with two active Google or email/password learner accounts and two browser sessions to confirm both users can hear each other, mute, pause, end, and recover after a refresh or network interruption. A successful build alone is not evidence that the audio call works.

## Operating-cost estimate

Illustrative Agora estimate in USD; this is not a quote and uses the current public starting price of $0.59 per 1,000 RTC minutes after 10,000 combined free RTC minutes monthly. Assumptions: 25% of registered users are active each month; each active learner joins four 15-minute one-to-one calls; Agora usage is counted per participant, so the estimate uses two participant-minutes per call-minute. Actual Agora billing, quality tiers, region, taxes, and account terms may change.

| Registered learners | Monthly active (25%) | One-to-one call minutes | RTC participant-minutes | Approx. Agora RTC |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 25 | 1,500 | 3,000 | $0 within 10,000 free minutes |
| 500 | 125 | 7,500 | 15,000 | $2.95 |
| 1,000 | 250 | 15,000 | 30,000 | $11.80 |
| 5,000 | 1,250 | 75,000 | 150,000 | $82.60 |

Firebase Authentication supports Google or email/password sign-in for the community and does not use SMS verification. Firestore Standard currently includes per-project no-cost allowances of 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, 1 GiB stored data, and 10 GiB monthly egress. The existing site's usage shares that project allowance, so actual Firebase charges depend on existing project usage and region. Netlify hosting/functions are also shared with the existing site; no separate fixed charge is attributed here. Review actual usage and Agora billing in their consoles before enabling broader access.

Pricing references: Agora RTC pricing https://www.agora.io/en/pricing/ and Firebase pricing https://firebase.google.com/pricing.

## Manual verification checklist

- Create two learner accounts in the same Deploy Preview, one with Google and one with email/password; verify the email link, complete the profile wizard forward/back, skip the optional photo/introduction, and confirm the profile becomes active after submission.
- Search each other by name/topic/level and verify email, phone, age, and location do not appear.
- Send a request, receive it in the second session, accept it, reject another, cancel an outgoing request, and confirm duplicates are rejected.
- Start an audio call from an accepted connection. Confirm the invitation requires acceptance and the microphone prompt appears only after a user clicks Join audio call.
- Confirm only audio connects, test mute/pause/end, and verify neither screen offers video or a camera permission.
- Open a topic room with three learners in separate browsers; test the capacity limit, level filter, join/leave, mute, report/block, host removal/end, and admin end-room. Confirm room audio is not recorded and that users cannot start a one-to-one call while in a room.
- Verify a stale host and a room time limit close the room, restore participant availability, and make the room disappear from the open-room list.
- Refresh one browser during a call and verify the server session expires/cleans up safely.
- Verify calls under one minute or calls ended through block are not counted; completed sessions record duration for both participants.
- Try a blocked pair and a call invitation to an offline connection.
- Check mobile and desktop sizes and the browser console.
- Confirm the admin counts show aggregates and no private call messages.

This manual two-session check requires the Netlify Deploy Preview environment variables and two Google/email learner accounts; it cannot be claimed from static code checks.

## Rollback and production checklist

To roll this feature back, revert its commit on the preview branch or close the preview PR. Preview collections are isolated by suffix and can be left intact; no collection is deleted. The rules file in this PR has not been deployed.

Before any production release: review the complete PR diff (which also contains the earlier tutor and calendar work), configure Production secrets, complete the Deploy Preview checks with two real accounts, review Firebase billing and Agora RTC terms, deploy reviewed Firestore rules only after approval, and deploy the website only after explicit production approval. Never copy preview learner records into Production without verifying consent and ownership.

## Live language moderation and Calling Community billing

The Deploy Preview implementation adds short, user-microphone-only speech segments for live language identification in 1:1 calls and topic rooms. A learner must accept the speech moderation consent before their profile can be saved; existing learners must opt in before they can join audio. The browser records independent WebM/Opus segments for up to eight seconds and sends them to the Netlify function, which calls Google Cloud Speech-to-Text V2 in `asia-southeast1` with the `chirp_2` model and Hindi/India English language codes. No raw audio is written to Firebase or the repository. English transcripts are discarded in memory. Hindi-flagged transcript excerpts and strike metadata are written to Firestore with a 30-day `deleteAt` value; the admin Calling dashboard shows only those flagged excerpts. Configure Firestore TTL for field `deleteAt` on these collection groups in the project's **preview and production** databases: `callingLanguageEvents`, `callingLanguageEventsPreview`, `callingLanguageModeration`, `callingLanguageModerationPreview`, `callingAudioChunkClaims`, `callingAudioChunkClaimsPreview`, `callingAudioUsage`, and `callingAudioUsagePreview`. TTL deletion runs asynchronously after the expiry time.

### Google Cloud

1. Enable **Cloud Speech-to-Text API** in the Firebase project's Google Cloud project.
2. In Google Cloud IAM, grant the service account stored in Netlify's existing `FIREBASE_SERVICE_ACCOUNT_JSON` the **Cloud Speech Client** role (`roles/speech.client`). Its private key stays in Netlify; never add it to source or paste it in chat.
3. Confirm the same Netlify function environment includes `FIREBASE_PROJECT_ID=englishmates-ratangarh-933f1`. The function uses the service account key to obtain a short-lived Google access token.
4. Keep Google Cloud Speech data logging disabled. Confirm billing alerts/quotas and test the preview with consenting accounts; automated language detection can misclassify accents, mixed-language phrases, or very short segments.
5. Firestore preview data is already suffix-isolated. Deploy the updated Firestore rules only after production rollout is approved.

### 10-minute daily allowance and ₹299 pass

Each learner receives 600 seconds of audio processing per India/IST calendar day, shared across 1:1 calls and rooms. The client stops audio when the allowance is used; the server also rejects new/renewed Agora tokens without an active pass or remaining free time. A verified pass adds 30 days from payment (or from the end of the current pass). It is a one-time payment and does not auto-renew. UPI uses the existing institute UPI address and admin review; the admin must manually check the UTR before approval.

For Razorpay, add these **Netlify environment variables** to the Deploy Preview context and redeploy the preview:
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`

Keep the secret server-side only. The function creates ₹299 Razorpay orders, checks the payment signature, and verifies the payment/order/amount/status through Razorpay's server API before enabling access. If these variables are absent, UPI review remains available but the Razorpay button shows a setup error. No auto-renewal or recurring mandate is configured.

### Rollout note

The branch changes do not update live Netlify, Google Cloud IAM/API settings, TTL policies, Razorpay settings, or live Firestore rules. Apply the external setup to the preview first, review all payment and consent flows, and deploy rules/variables separately only when production is approved.
