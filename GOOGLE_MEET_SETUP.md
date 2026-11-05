# Google Meet integration setup

The tutor booking flow creates a Google Calendar event with a Google Meet conference when an approved tutor confirms a pending 30-minute booking. The student is added as an attendee, so Google Calendar sends the invitation to the student's email address. The Meet URL is also shown in the tutor dashboard.

## Netlify environment variables

Configure these in the Netlify site environment for the deploy context being tested:

- `GOOGLE_CLIENT_ID`: OAuth 2.0 Web application client ID.
- `GOOGLE_CLIENT_SECRET`: OAuth 2.0 client secret. Keep private.
- `GOOGLE_REDIRECT_URI`: exact callback URL, for example `https://englishmates-ratangarh.netlify.app/.netlify/functions/google-oauth`.
- `GOOGLE_TOKEN_ENCRYPTION_KEY`: 32-byte key encoded as 64 hexadecimal characters. Generate with `openssl rand -hex 32`. Keep private and back it up securely.
- Existing Firebase variables are also required: `FIREBASE_SERVICE_ACCOUNT_JSON` and `FIREBASE_PROJECT_ID`.

Never commit secrets or paste them into chat. Set variables separately for deploy previews and production as appropriate. Changing the encryption key makes previously stored tutor refresh tokens unreadable; do not rotate it without a migration plan.

## Google Cloud configuration

1. Select the Google Cloud project that owns the OAuth client and enable **Google Calendar API**.
2. Configure the OAuth consent screen and add the Calendar events scope: `https://www.googleapis.com/auth/calendar.events`.
3. Create an OAuth client of type **Web application**.
4. Add the exact value of `GOOGLE_REDIRECT_URI` to **Authorized redirect URIs**.
5. Add the deployed site origin (for example, `https://englishmates-ratangarh.netlify.app`) to **Authorized JavaScript origins** if requested by the OAuth client setup.
6. Add tutor Google accounts as test users while the consent screen is in Testing. For a public tutor marketplace, complete Google's applicable verification/publishing requirements before broad rollout.

## Fixing OAuth redirect errors

For the production site, the only callback URI to register in the Google Cloud OAuth **Web application** client is:

`https://englishmates-ratangarh.netlify.app/.netlify/functions/google-oauth`

The Netlify `GOOGLE_REDIRECT_URI` variable must be exactly the same value: HTTPS, no query string, and no trailing slash. Give all four Google variables the **Production** deploy context and **Functions** scope in Netlify, then redeploy. If Google displays `Error 400: redirect_uri_mismatch`, the failure occurs before Englishmates receives the request; it is fixed by adding this exact URI under **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs → Authorized redirect URIs**.

## Tutor flow

1. Tutor signs in to the Englishmates teacher dashboard.
2. Tutor clicks **Connect Google Calendar** and grants calendar event access to their Google account.
3. Englishmates stores the refresh token encrypted in Firestore using the server-side encryption key.
4. Student requests an available 30-minute slot.
5. Tutor clicks **Confirm & create Meet**.
6. The function creates a Calendar event with a Meet conference, adds the student's email as an attendee, and stores the Meet URL with the booking.

The tutor must reconnect if Google revokes access. Calendar invitations are sent by Google to the student's submitted email. Confirmed sessions are fixed at 30 minutes in Asia/Kolkata time.

## Preview-first verification

- Set the environment variables for the Netlify deploy-preview context.
- Register the callback URI for that preview host if testing OAuth on the preview host; alternatively use the production callback URI only after the production OAuth client is configured and the app is intentionally being tested there.
- Connect a test tutor Google account.
- Submit a student booking using a test student email.
- Confirm the booking and verify that the event appears in the tutor's primary Google Calendar, the Meet URL appears in the dashboard, and the student receives the calendar invitation.
- Verify that declining a booking does not create a calendar event.

Do not merge the feature into production until preview verification succeeds.
