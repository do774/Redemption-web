const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { randomUUID } = require('crypto');

initializeApp();

const database = getFirestore();
const openAIKey = defineSecret('OPENAI_API_KEY');
// Keep generated content aligned with the languages exposed by the app UI.
const ENGINE_LANGUAGES = ['en', 'de', 'es', 'it', 'zh', 'hr', 'cs', 'pl'];

async function generateTranslations({ type, title, bodyText, options = [], explanation = '' }) {
  const apiKey = openAIKey.value();
  if (!apiKey) throw new HttpsError('failed-precondition', 'OPENAI_API_KEY is not configured for the Content Engine.');
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      translations: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(ENGINE_LANGUAGES.map(language => [language, {
          type: 'object', additionalProperties: false,
          properties: { title: { type: 'string' }, bodyText: { type: 'string' }, pollOptions: { type: 'array', items: { type: 'string' } }, explanation: { type: 'string' } },
          required: ['title', 'bodyText', 'pollOptions', 'explanation'],
        }])), required: ENGINE_LANGUAGES,
      },
      // One canonical answer index prevents a text answer (for example,
      // "Wolfram") being saved when it is not one of the offered choices.
      correctOptionIndex: { type: 'integer', minimum: 0, maximum: 3 },
    }, required: ['translations', 'correctOptionIndex'],
  };
  const prompt = `You are the safe editorial engine for a general-audience community app. ${title.startsWith('GENERATE:') ? 'Create a fresh, specific, discussion-worthy item from the instruction below.' : 'Rewrite and translate this item.'} Avoid politics, hate, sexual content, graphic violence, self-harm, medical claims, tragedy-as-entertainment, or unsupported facts. Preserve named people, clubs and brands. Return exactly the requested translations. Keep every option at its original array index across all languages. For trivia and guess-the-answer, make correctOptionIndex the zero-based index of an offered answer that is factually correct; never invent an answer outside Options, and make the explanation support that exact option. For non-quiz content, use 0. English title: ${title}\nEnglish body: ${bodyText}\nOptions: ${JSON.stringify(options)}\nExplanation: ${explanation}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-luna', reasoning: { effort: 'low' }, store: false, input: prompt, text: { format: { type: 'json_schema', name: 'content_translations', strict: true, schema } } }),
  });
  if (!response.ok) throw new HttpsError('internal', `Content generation failed (${response.status}).`);
  const payload = await response.json();
  const outputText = payload.output_text || payload.output
    ?.flatMap(item => item.content || [])
    .find(item => item.type === 'output_text')?.text;
  try {
    const parsed = JSON.parse(outputText);
    // The client expects translations keyed by stable option IDs. Normalising
    // here fixes future content while the client still reads the old array
    // format for previously generated items.
    const translations = Object.fromEntries(ENGINE_LANGUAGES.map(language => {
      const translation = parsed.translations[language] || {};
      const translatedOptions = Array.isArray(translation.pollOptions) ? translation.pollOptions : [];
      return [language, { ...translation, pollOptions: Object.fromEntries(options.map((_, index) => [`option-${index + 1}`, translatedOptions[index] || ''])) }];
    }));
    return { translations, correctOptionIndex: Number.isInteger(parsed.correctOptionIndex) ? parsed.correctOptionIndex : 0 };
  }
  catch { throw new HttpsError('internal', 'Content generation returned an invalid structured response.'); }
}

async function publishDueContent() {
  const settings = (await database.collection('adminContentSettings').doc('global').get()).data() || {};
  // Manual schedules must always be honoured. `autoPublish` only decides
  // whether newly generated AI drafts enter the schedule automatically.
  if (settings.enabled === false) return 0;
  const now = new Date();
  const scheduled = await database.collection('adminFeedItems').where('contentStatus', '==', 'SCHEDULED').get();
  const due = { docs: scheduled.docs.filter(item => item.data()?.publishAt?.toDate?.() <= now), empty: scheduled.docs.every(item => item.data()?.publishAt?.toDate?.() > now), size: scheduled.docs.filter(item => item.data()?.publishAt?.toDate?.() <= now).length };
  const batch = database.batch();
  due.docs.forEach(item => batch.update(item.ref, { contentStatus: 'PUBLISHED', autoPublished: true, updatedAt: FieldValue.serverTimestamp() }));
  const openPolls = await database.collection('adminFeedItems').where('contentStatus', '==', 'PUBLISHED').get();
  openPolls.docs.filter(item => item.data()?.poll?.closeAt?.toDate?.() <= now).forEach(item => batch.update(item.ref, { contentStatus: 'LOCKED', updatedAt: FieldValue.serverTimestamp() }));
  if (!due.empty || openPolls.size) await batch.commit();
  return due.size;
}

function evergreenSeed(type, ordinal) {
  const prompts = {
    QUOTE: 'a short original, uplifting quote about everyday personal growth',
    NEWS: 'a concise, clearly labelled sample community news update about a positive local initiative; do not present unverified real-world facts',
    POLL: 'a light, friendly two-option poll about an everyday preference',
    WHO_WILL_WIN: 'a playful two-option prediction question about a fictional friendly match, without claiming a real fixture exists',
    WHO_IS_BETTER: 'a light comparison between two universally recognisable, non-political cultural or sporting figures',
    DEBATE: 'a respectful, low-stakes statement that invites two-sided discussion',
    QUESTION_OF_THE_DAY: 'an open-ended, friendly question that encourages comments',
    WOULD_YOU_RATHER: 'a playful, concrete two-choice dilemma',
    TRIVIA: 'a verified general-knowledge multiple-choice question with four options and a short explanation',
    ON_THIS_DAY: 'a carefully worded, accurate historic "On this day" sample with a short explanation; do not invent dates or events',
    FACT_OF_THE_DAY: 'a verified, surprising general-knowledge fact',
    MORAL_DILEMMA: 'a safe, everyday ethical choice with two to four concrete options',
    PREDICTION: 'a playful two-option prediction about a fictional upcoming community outcome, without claiming a real event exists',
    STORY_OF_THE_DAY: 'a short, uplifting original micro-story about an everyday act of kindness',
    GUESS_THE_ANSWER: 'a casual, interesting four-option estimate or knowledge question with an explanation',
    RESULT: 'a concise, clearly labelled sample result recap for a fictional community challenge, without presenting it as a real event',
  };
  return prompts[type] ? `GENERATE: ${prompts[type]}. Make variation ${ordinal}.` : '';
}

async function replenishEvergreenContent() {
  const settings = (await database.collection('adminContentSettings').doc('global').get()).data() || {};
  if (settings.enabled === false) return 0;
  const enabledTypes = settings.enabledTypes || {};
  const evergreen = ['NEWS', 'POLL', 'QUOTE', 'WHO_WILL_WIN', 'WHO_IS_BETTER', 'DEBATE', 'QUESTION_OF_THE_DAY', 'WOULD_YOU_RATHER', 'TRIVIA', 'ON_THIS_DAY', 'FACT_OF_THE_DAY', 'MORAL_DILEMMA', 'PREDICTION', 'STORY_OF_THE_DAY', 'GUESS_THE_ANSWER', 'RESULT'];
  let made = 0;
  // Work in modest batches; Cloud Scheduler retries safely and avoids a large
  // burst of requests if an existing queue has been manually cleared.
  for (const type of evergreen) {
    if (enabledTypes[type] === false || settings.schedules?.[type]?.enabled === false || made >= 16) continue;
    const existing = await database.collection('adminFeedItems').where('contentType', '==', type).get();
    const queued = existing.docs.filter(item => ['DRAFT', 'SCHEDULED'].includes(item.data()?.contentStatus));
    if (queued.length >= 20) continue;
    await createGeneratedContent({ type, settings, ordinal: queued.length + 1, schedule: settings.autoPublish === true });
    made += 1;
  }
  return made;
}

async function backfillContentTranslations() {
  const snapshot = await database.collection('adminFeedItems').get();
  let updated = 0;
  for (const item of snapshot.docs) {
    const data = item.data() || {};
    const existing = data.translations || {};
    if (ENGINE_LANGUAGES.every(language => existing[language]?.title && existing[language]?.bodyText)) continue;
    const english = existing.en || {};
    const options = (data.poll?.options || data.pollOptions || []).map(option => option.text || '');
    const { translations } = await generateTranslations({ type: data.contentType || 'QUESTION_OF_THE_DAY', title: english.title || data.adminTitle || '', bodyText: english.bodyText || data.bodyText || '', options, explanation: english.explanation || data.poll?.explanation || '' });
    await item.ref.update({ translations: { ...existing, ...translations }, adminTitle: translations.en.title, bodyText: translations.en.bodyText, updatedAt: FieldValue.serverTimestamp() });
    updated += 1;
  }
  return updated;
}

const engineTypes = ['NEWS', 'POLL', 'QUOTE', 'WHO_WILL_WIN', 'WHO_IS_BETTER', 'DEBATE', 'QUESTION_OF_THE_DAY', 'WOULD_YOU_RATHER', 'TRIVIA', 'ON_THIS_DAY', 'FACT_OF_THE_DAY', 'MORAL_DILEMMA', 'PREDICTION', 'STORY_OF_THE_DAY', 'GUESS_THE_ANSWER', 'RESULT'];
const fourOptionTypes = ['TRIVIA', 'GUESS_THE_ANSWER'];
const twoOptionTypes = ['POLL', 'WHO_WILL_WIN', 'WHO_IS_BETTER', 'DEBATE', 'WOULD_YOU_RATHER', 'MORAL_DILEMMA', 'PREDICTION'];

function nextEngineSlot(settings, ordinal, type) {
  const typeTime = settings.schedules?.[type]?.time;
  const legacySlots = Object.values(settings.slots || {}).filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))).sort();
  const scheduledTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(typeTime)) ? typeTime : legacySlots[0] || '08:00';
  const [hour, minute] = String(scheduledTime).split(':').map(Number);
  // A type has one daily slot. Its queued items are placed on consecutive
  // days instead of competing with unrelated News/Poll/etc. slots.
  const dayOffset = Math.max(0, ordinal - 1);
  const now = new Date();
  const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  // Cloud Functions run in UTC. Shift the requested Zagreb wall-clock time
  // into UTC so the publishing scheduler honours the time shown in Admin.
  const zoned = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => Number(zoned.find(item => item.type === type)?.value || 0);
  const utcGuess = Date.UTC(part('year'), part('month') - 1, part('day'), hour, minute);
  const local = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utcGuess));
  const localPart = type => Number(local.find(item => item.type === type)?.value || 0);
  const offset = Date.UTC(localPart('year'), localPart('month') - 1, localPart('day'), localPart('hour'), localPart('minute')) - utcGuess;
  const result = new Date(utcGuess - offset);
  return result <= now ? new Date(result.getTime() + 24 * 60 * 60 * 1000) : result;
}

async function createGeneratedContent({ type, settings = {}, ordinal = 1, schedule = false, instruction = '' }) {
  if (!engineTypes.includes(type)) throw new HttpsError('invalid-argument', 'Unsupported content type.');
  const optionCount = fourOptionTypes.includes(type) ? 4 : twoOptionTypes.includes(type) ? 2 : 0;
  const seed = instruction.trim() ? `GENERATE: ${instruction.trim()}` : evergreenSeed(type, ordinal);
  const generated = await generateTranslations({ type, title: seed, bodyText: '', options: Array.from({ length: optionCount }, () => '') });
  const translations = generated.translations;
  const options = Array.from({ length: optionCount }, (_, index) => ({ id: `option-${index + 1}`, text: translations.en.pollOptions[`option-${index + 1}`] || `Option ${index + 1}` }));
  const ref = database.collection('adminFeedItems').doc();
  await ref.set({ id: ref.id, contentType: type, contentStatus: schedule ? 'SCHEDULED' : 'DRAFT', publishAt: schedule ? nextEngineSlot(settings, ordinal, type) : null, translations, adminTitle: translations.en.title, bodyText: translations.en.bodyText, kind: 'think', isAdminPost: true, sourceCollection: 'adminFeedItems', authorUID: 'content-engine', authorName: 'Redemption', authorImageURL: '', visibility: 'all', topicKey: type.toLowerCase(), aiGenerated: true, autoPublished: false, commentsEnabled: !['QUOTE', 'FACT_OF_THE_DAY', 'STORY_OF_THE_DAY', 'ON_THIS_DAY', 'RESULT'].includes(type), reactionsEnabled: optionCount === 0, poll: { enabled: optionCount > 0, options, correctOption: fourOptionTypes.includes(type) ? options[generated.correctOptionIndex]?.id || options[0]?.id || null : null, showResultsAfterVote: true, revealCorrectAnswerAfterVote: fourOptionTypes.includes(type), explanation: translations.en.explanation }, pollOptions: options, pollVotes: {}, positiveCount: 0, negativeCount: 0, positiveVoters: [], negativeVoters: [], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return ref.id;
}

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

// The administrator deliberately triggers regeneration from the review desk.
// The client never receives an AI key or makes an AI request.
exports.adminRegenerateContent = onCall({ region: 'us-central1', secrets: [openAIKey] }, async request => {
  await requireAdministrator(request);
  const itemID = String(request.data?.itemID || '').trim();
  if (!itemID) throw new HttpsError('invalid-argument', 'A content item ID is required.');
  const source = await database.collection('adminFeedItems').doc(itemID).get();
  if (!source.exists) throw new HttpsError('not-found', 'The content item no longer exists.');
  const item = source.data() || {};
  const english = item.translations?.en || {};
  const options = (item.poll?.options || item.pollOptions || []).map(option => option.text || '');
  const { translations } = await generateTranslations({ type: item.contentType || 'QUESTION_OF_THE_DAY', title: english.title || item.adminTitle || '', bodyText: english.bodyText || item.bodyText || '', options, explanation: english.explanation || item.poll?.explanation || '' });
  const nextRef = database.collection('adminFeedItems').doc();
  const normalizedPollOptions = (item.poll?.options || item.pollOptions || []).map((option, index) => ({ ...option, text: translations.en.pollOptions[option.id] || option.text }));
  await nextRef.set({
    ...item, id: nextRef.id, contentStatus: 'DRAFT', publishAt: null, translations,
    adminTitle: translations.en.title, bodyText: translations.en.bodyText,
    poll: item.poll ? { ...item.poll, options: normalizedPollOptions, explanation: translations.en.explanation || item.poll.explanation } : null,
    pollOptions: normalizedPollOptions, pollVotes: {}, positiveCount: 0, negativeCount: 0, positiveVoters: [], negativeVoters: [],
    aiGenerated: true, regeneratedFrom: itemID, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), generatedBy: request.auth.uid,
  });
  return { id: nextRef.id };
});

// A deliberate, administrator-only action for making one preview on demand.
// It uses the same server-side secret and validation as the automatic queue.
exports.adminGenerateContent = onCall({ region: 'us-central1', secrets: [openAIKey], timeoutSeconds: 120 }, async request => {
  await requireAdministrator(request);
  const type = String(request.data?.type || '').trim().toUpperCase();
  const instruction = String(request.data?.instruction || '').trim().slice(0, 600);
  const settings = (await database.collection('adminContentSettings').doc('global').get()).data() || {};
  const id = await createGeneratedContent({ type, settings, instruction, schedule: false });
  return { id };
});

// Runs independently of clients. It only advances already-reviewed scheduled
// content and locks voting at the configured close time.
exports.adminContentPublisher = onSchedule({ schedule: '* * * * *', timeZone: 'Europe/Zagreb' }, async () => {
  await publishDueContent();
});

// Monthly queue health check. Each run tops up the lowest queues in batches;
// generated content is stored with all translations before a user can see it.
exports.adminContentEvergreenPlanner = onSchedule({ schedule: '*/15 * * * *', timeZone: 'Europe/Zagreb', timeoutSeconds: 540, secrets: [openAIKey] }, async () => {
  await replenishEvergreenContent();
});

// Existing content is upgraded only when an app language is missing, so this
// weekly safety pass has no API cost once the library is fully localized.
exports.adminContentTranslationBackfill = onSchedule({ schedule: '0 3 * * 0', timeZone: 'Europe/Zagreb', timeoutSeconds: 540, secrets: [openAIKey] }, async () => {
  await backfillContentTranslations();
});
