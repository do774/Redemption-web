const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');

initializeApp();

const database = getFirestore();

exports.adminDeleteAccount = onCall({ region: 'us-central1' }, async request => {
  if (request.auth?.token?.admin !== true) {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }

  const uid = String(request.data?.uid || '').trim();
  if (!uid) throw new HttpsError('invalid-argument', 'A user UID is required.');
  if (uid === request.auth.uid) throw new HttpsError('failed-precondition', 'Administrators cannot delete their own account from this panel.');

  const userRef = database.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) throw new HttpsError('not-found', 'The user profile no longer exists.');
  const user = userSnapshot.data();

  // Preserve a minimal audit record before deleting personally identifiable profile data.
  await database.collection('deletedAccounts').doc(uid).set({
    uid,
    displayName: user.displayName || 'Deleted user',
    username: user.username || '',
    email: user.email || '',
    profileImageURL: user.profileImageURL || '',
    deletedAt: FieldValue.serverTimestamp(),
    deletedBy: request.auth.uid,
    deletedByName: request.auth.token.name || request.auth.token.email || 'Administrator',
    deletionReason: 'Deleted by administrator'
  }, { merge: true });

  const posts = await database.collection('posts').where('authorUID', '==', uid).get();
  for (const post of posts.docs) await database.recursiveDelete(post.ref);

  const [sentRequests, receivedRequests, conversations] = await Promise.all([
    database.collection('circleRequests').where('fromUID', '==', uid).get(),
    database.collection('circleRequests').where('toUID', '==', uid).get(),
    database.collection('conversations').where('participantIDs', 'array-contains', uid).get()
  ]);
  const batch = database.batch();
  [...sentRequests.docs, ...receivedRequests.docs].forEach(requestSnapshot => batch.delete(requestSnapshot.ref));
  await batch.commit();
  for (const conversation of conversations.docs) await database.recursiveDelete(conversation.ref);

  // Keep comments on other posts readable but remove the deleted user's identity.
  const comments = await database.collectionGroup('comments').where('authorUID', '==', uid).get();
  const commentBatch = database.batch();
  comments.docs.forEach(comment => commentBatch.update(comment.ref, {
    authorUID: 'deleted-user', authorName: 'Deleted user', authorImageURL: '', updatedAt: Timestamp.now()
  }));
  if (!comments.empty) await commentBatch.commit();

  await userRef.delete();
  await getAuth().deleteUser(uid);
  return { deleted: true, uid };
});
