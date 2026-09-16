# Admin Content Engine setup

The engine stores all new official content in `adminFeedItems`. Existing `posts`
News and Poll items are deliberately left unchanged.

1. Deploy Firestore rules and Functions from this directory:

   ```sh
   firebase deploy --only firestore:rules,functions
   ```

2. Configure the backend-only OpenAI secret, then redeploy Functions:

   ```sh
   firebase functions:secrets:set OPENAI_API_KEY
   firebase deploy --only functions
   ```

3. In Admin → AI Content, enable **Auto Content** and, when you want the
publisher to release approved scheduled work, **Auto publish**.

`adminContentPublisher` runs every five minutes to publish due scheduled
items and lock polls at `poll.closeAt`. `adminContentEvergreenPlanner` checks
the evergreen queue monthly and creates reviewable multilingual content. All
AI content is generated server-side and saved before the feed reads it.

Dynamic News and sports require a verified news/sports provider before being
enabled in production; do not route unverified external data into the engine.
