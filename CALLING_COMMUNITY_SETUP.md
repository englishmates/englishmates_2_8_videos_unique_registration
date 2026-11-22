# Calling Community and Find Your Partner

## Included in this preview branch

- Verified Google sign-in and automatic learner profile activation; admins can block or suspend access when needed.
- Searchable directory of active learners, proficiency and topic filters, online-only filtering, compatible random matching, and paginated results.
- Speaking requests with duplicate protection, recipient accept/reject, sender cancellation, and 14-day expiration.
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

All these collections are explicitly denied to browser clients in firestore.rules; requests, profiles, calls and moderation actions go through authenticated Netlify functions. Profile-picture bytes are stored only in the matching preview/live profile collection and are included only in authenticated partner responses. Current queries use Firestore single-field indexes only, so no composite index file is required. No production Firestore rule deployment or production database write was performed.

## Required Netlify settings

The existing service variables are required in the Deploy Preview context:

- FIREBASE_SERVICE_ACCOUNT_JSON
- FIREBASE_PROJECT_ID (englishmates-ratangarh-933f1)
- AGORA_APP_ID
- AGORA_APP_CERTIFICATE

The Agora certificate stays in Netlify and is used only to mint a five-minute, session-scoped audio token. If a required variable is absent, the preview shows a configuration error. A learner profile activates automatically after Google sign-in and submission of the required profile fields. Existing pending profiles are automatically activated when the learner loads their profile or an administrator opens the dashboard. Preview API calls use preview-suffixed collections. The code has not been published to the production website.

Agora RTC provides the existing managed real-time audio transport. This branch does not add a separate TURN vendor, SFU, or group rooms. Agora's browser SDK uses WebRTC; its relay/network path is provider-managed rather than Firebase ICE signaling. No camera or video track is initialized. Reusing the existing audio token endpoint avoids adding another paid media service.

## Automated checks

Run npm test and node --check on the changed JavaScript files. Unit coverage includes deterministic pair ids, privacy projection, email/phone filtering, safe avatar hosts, online expiry, level compatibility, and timestamp conversion. API integration and Firebase authorization should be tested in a Firebase Emulator or isolated test project.

The call must also be checked manually with two separate active Google learner accounts and two browser sessions to confirm both users can hear each other, mute, pause, end, and recover after a refresh or network interruption. A successful build alone is not evidence that the audio call works.

## Operating-cost estimate

Illustrative Agora estimate in USD; this is not a quote and uses the current public starting price of $0.59 per 1,000 RTC minutes after 10,000 combined free RTC minutes monthly. Assumptions: 25% of registered users are active each month; each active learner joins four 15-minute one-to-one calls; Agora usage is counted per participant, so the estimate uses two participant-minutes per call-minute. Actual Agora billing, quality tiers, region, taxes, and account terms may change.

| Registered learners | Monthly active (25%) | One-to-one call minutes | RTC participant-minutes | Approx. Agora RTC |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 25 | 1,500 | 3,000 | $0 within 10,000 free minutes |
| 500 | 125 | 7,500 | 15,000 | $2.95 |
| 1,000 | 250 | 15,000 | 30,000 | $11.80 |
| 5,000 | 1,250 | 75,000 | 150,000 | $82.60 |

Firebase Authentication uses Google sign-in only for the community and does not use SMS verification. Firestore Standard currently includes per-project no-cost allowances of 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, 1 GiB stored data, and 10 GiB monthly egress. The existing site's usage shares that project allowance, so actual Firebase charges depend on existing project usage and region. Netlify hosting/functions are also shared with the existing site; no separate fixed charge is attributed here. Review actual usage and Agora billing in their consoles before enabling broader access.

Pricing references: Agora RTC pricing https://www.agora.io/en/pricing/ and Firebase pricing https://firebase.google.com/pricing.

## Manual verification checklist

- Create two learner accounts with Google in the same Deploy Preview; each profile should become active immediately after submission.
- Search each other by name/topic/level and verify email, phone, age, and location do not appear.
- Send a request, receive it in the second session, accept it, reject another, cancel an outgoing request, and confirm duplicates are rejected.
- Start an audio call from an accepted connection. Confirm the invitation requires acceptance and the microphone prompt appears only after a user clicks Join audio call.
- Confirm only audio connects, test mute/pause/end, and verify neither screen offers video or a camera permission.
- Refresh one browser during a call and verify the server session expires/cleans up safely.
- Verify calls under one minute or calls ended through block are not counted; completed sessions record duration for both participants.
- Try a blocked pair and a call invitation to an offline connection.
- Check mobile and desktop sizes and the browser console.
- Confirm the admin counts show aggregates and no private call messages.

This manual two-session check requires the Netlify Deploy Preview environment variables and two Google learner accounts; it cannot be claimed from static code checks.

## Rollback and production checklist

To roll this feature back, revert its commit on the preview branch or close the preview PR. Preview collections are isolated by suffix and can be left intact; no collection is deleted. The rules file in this PR has not been deployed.

Before any production release: review the complete PR diff (which also contains the earlier tutor and calendar work), configure Production secrets, complete the Deploy Preview checks with two real accounts, review Firebase billing and Agora RTC terms, deploy reviewed Firestore rules only after approval, and deploy the website only after explicit production approval. Never copy preview learner records into Production without verifying consent and ownership.