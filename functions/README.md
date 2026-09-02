# Redemption admin functions

`adminDeleteAccount` is a privileged callable Firebase function. It checks the
Firebase custom claim `admin: true`, then removes the target's Firebase Auth
account, profile, authored posts, Circle requests and conversations. Comments
on other users' posts are anonymised.

Deploy it from the repository root after authenticating the Firebase CLI:

```bash
npm --prefix functions install
npx firebase-tools deploy --only functions:adminDeleteAccount --project redemption-7c875
```

The browser dashboard calls the deployed function at the `us-central1` URL.
Do not replace this with client-side deletion: a browser must never receive
credentials capable of deleting arbitrary Firebase Auth users.
