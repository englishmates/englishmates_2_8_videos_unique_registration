# Tutor profile photo and intro video

Approved tutors can upload a profile photo and a one-minute introduction video from the Teacher Dashboard. Students see the tutor's profile photo in the booking card; selecting it, or **Watch introduction**, opens the video.

The browser uploads directly to the existing Firebase Storage bucket. The included `storage.rules` restrict uploads to the signed-in tutor's own `tutor-media/<uid>/...` path and allow only JPEG, PNG, WebP, MP4, WebM, and MOV files up to 50 MB.

Before the first upload, deploy the included Storage rules to the `englishmates-ratangarh-933f1` Firebase project. For example, from an authenticated Firebase CLI session:

```powershell
firebase deploy --only storage --project englishmates-ratangarh-933f1
```

Do not use test-mode Storage rules. The live upload form also enforces a 5 MB photo limit, a 50 MB video limit, and a 60-second maximum duration.
