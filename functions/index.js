const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { randomUUID } = require('crypto');

initializeApp();

const database = getFirestore();

async function requireAdministrator(request) {
  if (!request.auth) {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }

  const adminProfile = await database.collection('users').doc(request.auth.uid).get();
  if (!adminProfile.exists || adminProfile.data()?.admin !== true) {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }
}

async function commitInBatches(entries) {
  for (let index = 0; index < entries.length; index += 450) {
    const batch = database.batch();
    entries.slice(index, index + 450).forEach(entry => {
      if (entry.type === 'delete') batch.delete(entry.ref);
      else batch.update(entry.ref, entry.data);
    });
    await batch.commit();
  }
}

function emailClaimID(email) {
  return Buffer.from(String(email || '').trim().toLowerCase()).toString('base64url');
}

async function releaseEmailClaim(email, uid) {
  if (!email) return;
  const claimRef = database.collection('accountEmails').doc(emailClaimID(email));
  const claim = await claimRef.get();
  if (claim.exists && claim.data()?.uid === uid) await claimRef.delete();
}

async function deleteAuthUserIfPresent(uid) {
  try {
    await getAuth().deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }
}

// Registration is deliberately completed on the server.  A profile is only
// created after the Auth email has been verified, and the email claim keeps a
// second active profile from being created for the same address.
exports.completeRegistration = onCall({ region: 'us-central1' }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to complete registration.');

  const uid = request.auth.uid;
  const account = await getAuth().getUser(uid);
  if (!account.email || !account.emailVerified) {
    throw new HttpsError('failed-precondition', 'EMAIL_NOT_VERIFIED');
  }

  const email = account.email.trim().toLowerCase();
  const displayName = String(request.data?.displayName || '').trim().slice(0, 80);
  const username = String(request.data?.username || '').trim().replace(/^@/, '').toLowerCase();
  const language = String(request.data?.language || 'en').trim().slice(0, 8) || 'en';
  if (!displayName) throw new HttpsError('invalid-argument', 'DISPLAY_NAME_REQUIRED');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    throw new HttpsError('invalid-argument', 'USERNAME_INVALID');
  }

  const profileRef = database.collection('users').doc(uid);
  const emailRef = database.collection('accountEmails').doc(emailClaimID(email));

  // Detect legacy profiles created before email claims were introduced as well.
  const [sameEmail, sameNormalizedEmail] = await Promise.all([
    database.collection('users').where('email', '==', email).get(),
    database.collection('users').where('emailLowercase', '==', email).get(),
  ]);
  if ([...sameEmail.docs, ...sameNormalizedEmail.docs].some(profile => profile.id !== uid)) {
    await deleteAuthUserIfPresent(uid);
    throw new HttpsError('already-exists', 'EMAIL_ALREADY_REGISTERED');
  }

  try {
    await database.runTransaction(async transaction => {
      const [emailClaim, usernameProfiles] = await Promise.all([
        transaction.get(emailRef),
        transaction.get(database.collection('users').where('username', '==', username)),
      ]);
      if (emailClaim.exists && emailClaim.data()?.uid !== uid) {
        throw new HttpsError('already-exists', 'EMAIL_ALREADY_REGISTERED');
      }
      if (usernameProfiles.docs.some(profile => profile.id !== uid)) {
        throw new HttpsError('already-exists', 'USERNAME_TAKEN');
      }
      transaction.set(emailRef, { uid, email, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.set(profileRef, {
        uid,
        email,
        emailLowercase: email,
        displayName,
        username,
        profileImageURL: account.photoURL || '',
        profileSearchable: true,
        allowCircleRequests: true,
        showInfo: true,
        showEmail: true,
        showCircleCount: true,
        prioritizeCirclePosts: true,
        language,
        lastSignInPlatform: 'web',
        platforms: FieldValue.arrayUnion('web'),
        lastSignInAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        registrationCompleted: true,
        termsAcceptedAt: FieldValue.serverTimestamp(),
        privacyAcceptedAt: FieldValue.serverTimestamp(),
        communityGuidelinesAcceptedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  } catch (error) {
    if (error instanceof HttpsError && error.message === 'EMAIL_ALREADY_REGISTERED') {
      await deleteAuthUserIfPresent(uid);
    }
    throw error;
  }
  return { completed: true };
});

exports.deleteOwnAccount = onCall({ region: 'us-central1' }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to delete your account.');

  const uid = request.auth.uid;
  const profileSnapshot = await database.collection('users').doc(uid).get();
  const profile = profileSnapshot.data() || {};
  const ownPosts = await database.collection('posts').where('authorUID', '==', uid).get();
  const ownPostIDs = new Set(ownPosts.docs.map(post => post.id));
  const deleteEntries = [];

  // Remove a person's posts and every discussion attached to those posts.
  for (const post of ownPosts.docs) {
    const comments = await post.ref.collection('comments').get();
    comments.docs.forEach(comment => deleteEntries.push({ type: 'delete', ref: comment.ref }));
    deleteEntries.push({ type: 'delete', ref: post.ref });
  }
  await commitInBatches(deleteEntries);

  // Keep comments made on other people's posts so the conversation still
  // makes sense, but remove every identifying field.
  const authoredComments = await database.collectionGroup('comments').where('authorUID', '==', uid).get();
  const anonymizeEntries = authoredComments.docs
    .filter(comment => !ownPostIDs.has(comment.ref.parent.parent?.id || ''))
    .map(comment => ({
      type: 'update',
      ref: comment.ref,
      data: {
        authorUID: 'deleted',
        authorName: 'Deleted user',
        authorImageURL: '',
        authorDeletedAt: FieldValue.serverTimestamp(),
      },
    }));
  await commitInBatches(anonymizeEntries);

  await database.collection('deletedAccounts').doc(uid).set({
    uid,
    displayName: String(profile.displayName || ''),
    username: String(profile.username || ''),
    email: String(profile.email || request.auth.token.email || ''),
    deletedAt: FieldValue.serverTimestamp(),
    deletedBy: uid,
    deletedByEmail: String(request.auth.token.email || profile.email || ''),
    deletionReason: 'Deleted by account owner',
  }, { merge: true });
  await releaseEmailClaim(profile.email || request.auth.token.email || '', uid);
  await profileSnapshot.ref.delete();

  await deleteAuthUserIfPresent(uid);
  return { deleted: true };
});

exports.adminDeleteAccount = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);

  const uid = String(request.data?.uid || '').trim();
  if (!uid) throw new HttpsError('invalid-argument', 'A user UID is required.');
  if (uid === request.auth.uid) throw new HttpsError('failed-precondition', 'Administrators cannot delete their own account from this panel.');

  const userRef = database.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) throw new HttpsError('not-found', 'The user profile no longer exists.');

  // Administrators follow the same deletion policy as a user deleting their
  // own account: posts and their discussions disappear, while comments left
  // on somebody else's post remain without identifying information.
  const ownPosts = await database.collection('posts').where('authorUID', '==', uid).get();
  const ownPostIDs = new Set(ownPosts.docs.map(post => post.id));
  const deleteEntries = [];
  for (const post of ownPosts.docs) {
    const comments = await post.ref.collection('comments').get();
    comments.docs.forEach(comment => deleteEntries.push({ type: 'delete', ref: comment.ref }));
    deleteEntries.push({ type: 'delete', ref: post.ref });
  }
  await commitInBatches(deleteEntries);

  const authoredComments = await database.collectionGroup('comments').where('authorUID', '==', uid).get();
  const anonymizeEntries = authoredComments.docs
    .filter(comment => !ownPostIDs.has(comment.ref.parent.parent?.id || ''))
    .map(comment => ({
      type: 'update',
      ref: comment.ref,
      data: {
        authorUID: 'deleted',
        authorName: 'Deleted user',
        authorImageURL: '',
        authorDeletedAt: FieldValue.serverTimestamp(),
      },
    }));
  await commitInBatches(anonymizeEntries);

  await database.collection('deletedAccounts').doc(uid).set({
    uid,
    displayName: String(userSnapshot.data()?.displayName || ''),
    username: String(userSnapshot.data()?.username || ''),
    email: String(userSnapshot.data()?.email || ''),
    deletedAt: FieldValue.serverTimestamp(),
    deletedBy: request.auth.uid,
    deletedByEmail: String(request.auth.token.email || ''),
    deletionReason: 'Deleted by administrator',
    deletedPostCount: ownPosts.size,
  }, { merge: true });
  await releaseEmailClaim(userSnapshot.data()?.email || '', uid);
  await deleteAuthUserIfPresent(uid);
  await userRef.delete();
  return { deleted: true, uid };
});

exports.adminGetUserAccountDetails = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);

  const uid = String(request.data?.uid || '').trim();
  if (!uid) throw new HttpsError('invalid-argument', 'A user UID is required.');

  try {
    const account = await getAuth().getUser(uid);
    return {
      createdAt: account.metadata.creationTime || null,
      lastSignInAt: account.metadata.lastSignInTime || null,
      emailVerified: account.emailVerified === true,
      disabled: account.disabled === true,
      providers: account.providerData.map(provider => provider.providerId),
    };
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      return { createdAt: null, lastSignInAt: null, emailVerified: false, disabled: false, providers: [] };
    }
    throw error;
  }
});

exports.adminWarnUser = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);

  const uid = String(request.data?.uid || '').trim();
  const reason = String(request.data?.reason || '').trim().slice(0, 1000);
  if (!uid || !reason) throw new HttpsError('invalid-argument', 'A user UID and warning message are required.');
  if (uid === request.auth.uid) throw new HttpsError('failed-precondition', 'Administrators cannot warn themselves from this panel.');

  const userRef = database.collection('users').doc(uid);
  if (!(await userRef.get()).exists) throw new HttpsError('not-found', 'The user profile no longer exists.');

  const warningRef = database.collection('moderationWarnings').doc();
  const batch = database.batch();
  batch.set(warningRef, {
    recipientUID: uid,
    reason,
    status: 'unread',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: request.auth.uid,
  });
  batch.update(userRef, {
    moderationStatus: 'warned',
    moderationReason: reason,
    moderatedAt: FieldValue.serverTimestamp(),
    moderatedBy: request.auth.uid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { warned: true };
});

exports.adminDeletePost = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);

  const postID = String(request.data?.postID || '').trim();
  if (!postID) throw new HttpsError('invalid-argument', 'A post ID is required.');

  const postRef = database.collection('posts').doc(postID);
  const post = await postRef.get();
  if (!post.exists) throw new HttpsError('not-found', 'The post no longer exists.');

  const comments = await postRef.collection('comments').get();
  await commitInBatches([
    ...comments.docs.map(comment => ({ type: 'delete', ref: comment.ref })),
    { type: 'delete', ref: postRef },
  ]);
  return { deleted: true, postID };
});

exports.adminDeleteComment = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);

  const postID = String(request.data?.postID || '').trim();
  const commentID = String(request.data?.commentID || '').trim();
  if (!postID || !commentID) throw new HttpsError('invalid-argument', 'A post ID and comment ID are required.');

  const postRef = database.collection('posts').doc(postID);
  const commentRef = postRef.collection('comments').doc(commentID);
  if (!(await commentRef.get()).exists) throw new HttpsError('not-found', 'The comment no longer exists.');

  const comments = await postRef.collection('comments').get();
  const idsToDelete = new Set([commentID]);
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    comments.docs.forEach(comment => {
      const parentID = String(comment.data().parentCommentID || comment.data().parentID || '');
      if (parentID && idsToDelete.has(parentID) && !idsToDelete.has(comment.id)) {
        idsToDelete.add(comment.id);
        foundDescendant = true;
      }
    });
  }
  await commitInBatches(comments.docs
    .filter(comment => idsToDelete.has(comment.id))
    .map(comment => ({ type: 'delete', ref: comment.ref })));
  return { deleted: true, postID, commentID, deletedCount: idsToDelete.size };
});

exports.adminUploadOfficialImage = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);

  const postID = String(request.data?.postID || '').trim();
  const contentType = String(request.data?.contentType || '').toLowerCase();
  const encoded = String(request.data?.base64 || '');
  const filename = String(request.data?.filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '-').slice(-90);
  if (!postID || !encoded || !contentType.startsWith('image/')) {
    throw new HttpsError('invalid-argument', 'A post ID and image are required.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
    throw new HttpsError('invalid-argument', 'Images must be no larger than 5 MB.');
  }
  const path = `officialFeed/${postID}/${Date.now()}-${filename}`;
  const token = randomUUID();
  const file = getStorage().bucket().file(path);
  await file.save(bytes, {
    resumable: false,
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  const bucket = getStorage().bucket().name;
  return {
    path,
    imageURL: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media&token=${token}`,
  };
});

exports.adminDeleteOfficialImage = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);
  const path = String(request.data?.path || '').trim();
  if (!path.startsWith('officialFeed/')) throw new HttpsError('invalid-argument', 'Invalid official image path.');
  try {
    await getStorage().bucket().file(path).delete();
  } catch (error) {
    if (error?.code !== 404) throw error;
  }
  return { deleted: true };
});
