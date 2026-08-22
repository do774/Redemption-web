# Redemption web

Official static website for the Redemption iOS app. It is designed for GitHub Pages and includes the public URLs commonly needed for an App Store submission.

## Pages

- `index.html` — marketing landing page
- `privacy.html` — privacy policy
- `terms.html` — terms of use
- `community.html` — community guidelines
- `support.html` — support contact
- `delete-account.html` — public account-deletion instructions
- `admin.html` — private Firebase-backed moderation dashboard (not linked publicly)

## GitHub Pages

In the repository on GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, select branch **main** and folder **/ (root)**, then click **Save**.

After the deployment completes, the public URLs will be:

- Marketing: `https://do774.github.io/Redemption-web/`
- Privacy Policy: `https://do774.github.io/Redemption-web/privacy.html`
- Support: `https://do774.github.io/Redemption-web/support.html`
- Account deletion: `https://do774.github.io/Redemption-web/delete-account.html`

## Before App Store submission

The website reflects the current app code: Firebase Authentication, Cloud Firestore, Sign in with Apple, public profiles, posts, comments, reactions and Circle requests. Confirm the final production build and Firebase configuration before completing App Store Connect’s App Privacy questionnaire.

Apple requires UGC/social apps to implement in the app itself: content filtering, working report controls with timely handling, a way to block abusive users, and an in-app account deletion flow. The current app has UI placeholders for reports and account deletion, so those backend and user-facing flows must be completed before submission. This website does not replace those in-app requirements.

This site is a product-policy draft, not legal advice. Keep the contact email, policy and App Store privacy responses current as the product changes.

## Moderation dashboard setup

The dashboard at `admin.html` is a Firebase web client for the `reports` collection. It uses the same Firebase project as the iOS app and its Firebase configuration is intentionally public; authorization comes from Firebase Authentication and Firestore Security Rules, never from hiding the URL.

Before using it:

1. In Firebase Authentication, add `do774.github.io` under **Settings → Authorized domains**.
2. Sign in once with the administrator email, then use a trusted server environment with the Firebase Admin SDK to set that user’s custom claim to `{ admin: true }`. Never put a service-account file or Admin SDK credential in this repository.
3. Configure Firestore Rules so regular users cannot read any report and only users whose token contains `admin: true` can read or update reports. The iOS report submission path currently writes reports directly, so it also needs a strictly validated create rule or, preferably, a callable Cloud Function.

Minimal administrative rule pattern (adapt and test it before deployment):

```firestore
function isAdmin() {
  return request.auth != null && request.auth.token.admin == true;
}

match /reports/{reportId} {
  allow read, update, delete: if isAdmin();
  // Do not use `if request.auth != null` alone in production.
  // Validate the reporting user and every accepted field, or use a callable Function.
  allow create: if request.auth != null
    && request.resource.data.reporter.uid == request.auth.uid
    && request.resource.data.status == 'open';
}
```

The panel writes `status`, `lastAction`, `assignedTo`, `updatedAt` and a new `auditLog` entry. `Remove content`, `Warn user`, `Suspend` and `Ban` currently record the moderation decision specified by `admin-report-data.md`; to enforce those actions against posts and Firebase Auth accounts, add a privileged Cloud Function and call it from the dashboard. Do not grant browser clients direct permission to disable users or delete arbitrary content.
