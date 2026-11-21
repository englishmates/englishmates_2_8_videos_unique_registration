# YouTube videos + Workbook/PDF files (step1-booking-login branch)

## What changed
- **Admin → Add or edit a course:** now only Course name, Fee, Short description, Workbook, PDF file and Publish.
  Everything else is inside "More options (optional)".
- **Workbook / PDF file:** drag & drop (or click) — uploaded when you press *Save course*, max 25 MB each.
  Enrolled students see them under "Practice files" in the learning room.
- **YouTube videos (unlisted):** Admin → Add course videos → paste `Title | link | minutes(optional)`, one per line.
  The Cloudflare uploader is still there, collapsed, for later.
- **Login gate:** the existing login + enrollment check is used. The YouTube ID is sent to the browser only by
  `lesson-playback`, after login and an active enrollment (or a free-demo lesson).
- **Live feel:** `assets/ui-feedback.js` — spinner on any button that starts work, top progress bar, toasts,
  and explicit "Signing in…" states on sign-in / Google buttons.

## Deploy
1. `firebase deploy --only storage` (adds `course-materials` rules; nothing existing is changed).
2. Push the branch; Netlify rebuilds `lms-api`. No new environment variables are needed.

## Limits
Unlisted YouTube links are not secret: an enrolled student can copy the link from developer tools and share it.
Cloudflare Stream (already coded) is the strong option when you are ready for it.
