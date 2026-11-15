# Secure course video setup

Englishmates course lessons use Cloudflare Stream instead of YouTube links. Lesson upload URLs are one-time, video playback requires a short-lived signed token, and each uploaded video is restricted to the website hostname for the deploy context. Tokens are issued by the LMS server only after it verifies an active enrollment.

## One-time Cloudflare setup

1. Create or open a Cloudflare account and enable Stream.
2. In Cloudflare, create an API token scoped to the account with **Stream: Edit** permissions. Keep the token private.
3. Copy the Cloudflare account ID and the Stream customer hostname (for example, `customer-xxxx.cloudflarestream.com`).
4. In Netlify, open the Englishmates site’s environment variables. Add the following values to the **Deploy previews** context:
   - `CLOUDFLARE_STREAM_ACCOUNT_ID`
   - `CLOUDFLARE_STREAM_API_TOKEN`
   - `CLOUDFLARE_STREAM_CUSTOMER_HOST`
5. Trigger a fresh Deploy Preview after saving the variables. The current Preview 21 will not read newly added settings until Netlify rebuilds its functions.
6. Upload a short test lesson from **Admin → Protected lesson videos**, then enroll a test student, approve that student’s payment, and test playback while signed in.

Never put the Cloudflare API token in a web page, browser storage, or a chat message. The browser receives only a one-time upload URL and a temporary playback URL.

## Uploading a lesson

Choose the course and module, enter the lesson title and length, select a video file up to 200 MB, and press **Upload & save secure lesson**. Uploads larger than 200 MB must be compressed or split before using this form. Cloudflare processes the uploaded video before playback becomes available.

Preview uploads are restricted to the exact Preview hostname. They do not automatically become playable on the live hostname; upload the final course videos again from the live Admin page after production is approved and configured.

## Protection and limits

Signed URLs require a token, and Cloudflare’s allowed-origin setting restricts playback manifests and segments to the configured Englishmates domain. This blocks ordinary link forwarding to another site. A student who is already watching can still use screen recording or another device; browser video cannot promise zero copying.

Cloudflare currently lists Stream at **$5 per 1,000 stored video minutes per month** and **$1 per 1,000 delivered video minutes**. Cloudflare Pro and Business plans include 100 stored minutes and 10,000 delivered minutes. Actual charges depend on storage and how much students watch. Recheck the [Cloudflare Stream pricing page](https://www.cloudflare.com/plans/) before scaling.

If the requirement later changes to DRM-based screen-capture deterrence, that requires a different provider and additional costs; do not enable that without reviewing the price first.
