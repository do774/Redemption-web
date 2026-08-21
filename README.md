# Redemption web

Official static website for the Redemption iOS app. It is designed for GitHub Pages and includes the public URLs commonly needed for an App Store submission.

## Pages

- `index.html` — marketing landing page
- `privacy.html` — privacy policy
- `terms.html` — terms of use
- `community.html` — community guidelines
- `support.html` — support contact
- `delete-account.html` — public account-deletion instructions

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
