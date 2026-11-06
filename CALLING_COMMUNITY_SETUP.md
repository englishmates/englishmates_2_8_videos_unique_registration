# Calling Community — release checklist

This feature is intentionally server-mediated: browsers never read or write Community Firestore data directly. Netlify Functions validate Firebase ID tokens, enforce approval status, and create short-lived audio tokens.

## What is implemented locally

- Verified Email/Password and Google sign-in, password reset, and email-verification gating.
- Adult (18+), India-only learner profiles with full name, email, age, city, state, level, interests, language, goals, creation date, and approval status.
- Server-enforced `pending`, `approved`, `rejected`, and `suspended` states. Only the verified Englishmates owner email can change a status.
- Private administrator dashboard with search, all status views, report resolution, and audit history.
- Server-side matching queue, compatible level/topic matching, invitation timeout, mutual acceptance, a 15-minute session limit, end/leave, block, report, and post-call feedback.
- Agora audio-token endpoint. The Agora certificate never reaches the browser; tokens are scoped to the caller, the channel, and five minutes.

## Required Netlify environment variables

The project already needs these for its existing Netlify Functions:

- `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase Admin service-account JSON, stored only in Netlify.
- `FIREBASE_PROJECT_ID` — `englishmates-ratangarh-933f1`.

For live audio, create an Agora project configured for **App ID + Token** mode, then add these values to both Production and Deploy Preview contexts:

- `AGORA_APP_ID`
- `AGORA_APP_CERTIFICATE`

Never place `AGORA_APP_CERTIFICATE`, a Firebase service-account JSON, passwords, or API tokens in HTML, JavaScript, Git, or chat.

## Manual India review

Phone Authentication is deliberately not used, so the application does **not** claim SMS/phone verification. A learner self-confirms India and age 18+, then the administrator reviews and approves the profile. If phone verification becomes necessary later, add a properly consented and cost-reviewed verification provider before representing it as verified.

## Firebase rules

`firestore.rules` preserves the deployed course, operations, review, and tutor access rules, then explicitly denies all direct browser access to Calling Community collections. After peer review and approval, deploy only the rules with:

```powershell
firebase deploy --only firestore --project englishmates-ratangarh-933f1
```

## Deploy-preview finding (6 November 2026)

- PR #18 targets `clean-main` and has a successful preview: `https://deploy-preview-18--englishmates-ratangarh.netlify.app`.
- PR #19 also targets `clean-main`, is mergeable, but its head commit has no Netlify status at all. That means Netlify has not started a build; this is not a code build failure.

In Netlify, confirm the GitHub-connected site has **Deploy previews: Any pull request** enabled and that the GitHub App has access to `englishmates/englishmates_2_8_videos_unique_registration`. Then push a new commit to the PR #19 head branch (or trigger a deploy from Netlify). A successful status is required before claiming a preview URL. No production deploy has been performed.
