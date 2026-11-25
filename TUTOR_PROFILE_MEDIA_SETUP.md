# Tutor profile photo and protected introduction video

Approved tutors can upload a profile photo and a one-minute introduction video from the Teacher Dashboard. Student tutor cards use an inline, signed Cloudflare Stream player instead of a profile photo. The signed playback token disables the download option and limits the video to the Englishmates site origin.

Profile photos upload to Firebase Storage under `tutor-media/<uid>/profile-photo/...`. Storage rules allow only the signed-in tutor to upload their own JPEG, PNG, or WebP photo (up to 5 MB). Intro videos no longer upload to Firebase Storage.

## Secure intro video requirements

Tutor intro videos use the same Cloudflare Stream settings as protected course lessons. Set these Netlify variables for both Deploy Previews and Production:

- `CLOUDFLARE_STREAM_ACCOUNT_ID`
- `CLOUDFLARE_STREAM_API_TOKEN`
- `CLOUDFLARE_STREAM_CUSTOMER_HOST`

The API token must include Stream Edit access. The Teacher Dashboard requests a one-time upload URL; the server stores only the Stream video UID and issues short-lived playback tokens with downloads disabled. Videos remain limited to 60 seconds and 50 MB.

Existing Firebase-hosted tutor intro videos are legacy uploads. Tutors must upload them again through the Teacher Dashboard to use the protected player. Until then, their cards show a video placeholder. Never put Cloudflare credentials in a web page or chat.

Browser streaming cannot prevent screen recording or filming the screen with another device.
