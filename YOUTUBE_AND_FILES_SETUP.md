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

## Fixes in the second round
- **Enroll error** ("Failed to construct 'FormData'") fixed on the student dashboard and the course page.
- **Links such as "View course"** now show a spinner, a fade and the top progress bar while the next page loads;
  course lists show placeholder cards while loading.
- **Calling Community**
- Learners can use Google or email/password; email accounts verify by email link. Profiles activate after submission without learner approval; admins can block or suspend access.
  - Level (and every other profile field) no longer resets while you edit: background refresh used to overwrite it.
  - "Find a partner" now also invites any active learner who is online right now (page open, not set to offline),
    and re-checks on every refresh (4 s while searching), so a partner who comes online later is found.
    Shared interests are no longer required; level must be within one step.
  - The invited learner sees the searcher's name, level, introduction and interests.
  - Inviting a connection while "Searching…" no longer fails; it cancels the search and sends the invite.
  - Live countdown while searching, a clear message when nobody was found, toasts for every action.
  - Requests / invitations reach the other learner within about 20 s (hub) or 4 s (while searching or in a call).
    Refresh runs only while the tab is visible, to keep Netlify function usage low.
