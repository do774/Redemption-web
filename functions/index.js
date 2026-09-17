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

function cleanGeneratedCopy(value) {
  let copy = String(value || '').trim();
  // Model instructions must never leak into reader-facing copy. This also
  // cleans legacy-style labels if a model returns one despite the schema.
  copy = copy.replace(/^(?:(?:generate(?:d|d content| content)?|generation|example|sample|variant|variation|varijanta|primjer|naslov|title|tekst|text|body)\s*\d*\s*[:\-–—]\s*)+/i, '');
  copy = copy.replace(/^(?:(?:variant|variation|varijanta|primjer|example|sample)\s*\d+\s*[.\-–—:]?\s*)+/i, '');
  return copy.trim();
}

async function generateTranslations({ type, title, bodyText, options = [], explanation = '', generationInstruction = '' }) {
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
  const isNewContent = Boolean(generationInstruction.trim());
  const prompt = `You are the safe editorial engine for a general-audience community app. ${isNewContent ? 'Create one fresh, specific, discussion-worthy item using the internal direction below.' : 'Rewrite and translate this item.'} Avoid politics, hate, sexual content, graphic violence, self-harm, medical claims, tragedy-as-entertainment, or unsupported facts. Preserve named people, clubs and brands. The title and body are reader-facing copy: write a natural standalone title and normal body text only. Never include labels or meta language such as "Generate", "Generated", "Example", "Sample", "Variant", "Variation", "Primjer", "Varijanta", "Title", "Body", prompt wording, or numbering. Do not mention AI, instructions, generation, or translation. Return exactly the requested translations. Keep every option at its original array index across all languages. For trivia and guess-the-answer, make correctOptionIndex the zero-based index of an offered answer that is factually correct; never invent an answer outside Options, and make the explanation support that exact option. For non-quiz content, use 0. Internal direction (never repeat it): ${generationInstruction}\nEnglish title: ${title}\nEnglish body: ${bodyText}\nOptions: ${JSON.stringify(options)}\nExplanation: ${explanation}`;
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
      return [language, {
        ...translation,
        title: cleanGeneratedCopy(translation.title),
        bodyText: cleanGeneratedCopy(translation.bodyText),
        explanation: cleanGeneratedCopy(translation.explanation),
        pollOptions: Object.fromEntries(options.map((_, index) => [`option-${index + 1}`, cleanGeneratedCopy(translatedOptions[index])])),
      }];
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
    NEWS: 'a concise community news update about a positive local initiative; do not present unsupported real-world facts',
    POLL: 'a light, friendly two-option poll about an everyday preference',
    WHO_WILL_WIN: 'a playful two-option prediction question about a fictional friendly match, without claiming a real fixture exists',
    WHO_IS_BETTER: 'a light comparison between two universally recognisable, non-political cultural or sporting figures',
    DEBATE: 'a respectful, low-stakes statement that invites two-sided discussion',
    QUESTION_OF_THE_DAY: 'an open-ended, friendly question that encourages comments',
    WOULD_YOU_RATHER: 'a playful, concrete two-choice dilemma',
    TRIVIA: 'a verified general-knowledge multiple-choice question with four options and a short explanation',
    ON_THIS_DAY: 'a carefully worded, accurate historic "On this day" item with a short explanation; do not invent dates or events',
    FACT_OF_THE_DAY: 'a verified, surprising general-knowledge fact',
    MORAL_DILEMMA: 'a safe, everyday ethical choice with two to four concrete options',
    PREDICTION: 'a playful two-option prediction about a fictional upcoming community outcome, without claiming a real event exists',
    STORY_OF_THE_DAY: 'a short, uplifting original micro-story about an everyday act of kindness',
    GUESS_THE_ANSWER: 'a casual, interesting four-option estimate or knowledge question with an explanation',
    RESULT: 'a concise result recap for a fictional community challenge, without presenting it as a real event',
  };
  return prompts[type] ? `${prompts[type]}. Use a distinct angle for internal sequence ${ordinal}.` : '';
}

async function replenishEvergreenContent() {
  const settings = (await database.collection('adminContentSettings').doc('global').get()).data() || {};
  // The legacy queue is opt-in. The AI Schedule tab is the canonical source
  // for ongoing generation, so it never creates unwanted drafts for types
  // the administrator did not explicitly schedule.
  if (settings.enabled === false || settings.autoPublish !== true) return 0;
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

function nextEngineSlot(settings, ordinal, type, timeOverride = '', referenceTime = new Date()) {
  const typeTime = timeOverride || settings.schedules?.[type]?.time;
  const legacySlots = Object.values(settings.slots || {}).filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))).sort();
  const scheduledTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(typeTime)) ? typeTime : legacySlots[0] || '08:00';
  const [hour, minute] = String(scheduledTime).split(':').map(Number);
  // A type has one daily slot. Its queued items are placed on consecutive
  // days instead of competing with unrelated News/Poll/etc. slots.
  const dayOffset = Math.max(0, ordinal - 1);
  const now = referenceTime;
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

function recurringScheduleKey(type, time, publishAt) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(publishAt);
  const value = key => parts.find(part => part.type === key)?.value || '';
  return `${type}:${value('year')}-${value('month')}-${value('day')}:${time}`;
}

function zagrebWeekday(date) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zagreb', weekday: 'short' }).format(date);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[weekday];
}

function nextEngineSlotOnSelectedDay(settings, type, time, days, referenceTime = new Date()) {
  const allowedDays = Array.isArray(days) && days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  let candidate = nextEngineSlot(settings, 1, type, time, referenceTime);
  for (let attempt = 0; attempt < 7 && !allowedDays.includes(zagrebWeekday(candidate)); attempt += 1) candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  return candidate;
}

async function replenishRecurringAiSchedules() {
  const settings = (await database.collection('adminContentSettings').doc('global').get()).data() || {};
  if (settings.enabled === false) return 0;
  const configured = Object.entries(settings.aiSchedules || {}).flatMap(([type, entry]) => {
    if (!engineTypes.includes(type) || entry?.enabled !== true) return [];
    const times = Array.isArray(entry.times) ? entry.times : [];
    const days = Array.isArray(entry.days) ? [...new Set(entry.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))] : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) return [];
    return [...new Set(times.filter(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))))].map(time => ({ type, time, includeImage: entry.includeImage === true, days }));
  });
  if (!configured.length) return 0;
  const existing = await database.collection('adminFeedItems').get();
  const existingKeys = new Set(existing.docs.map(item => String(item.data()?.scheduleKey || '')).filter(Boolean));
  let made = 0;
  for (const entry of configured) {
    const publishAt = nextEngineSlotOnSelectedDay(settings, entry.type, entry.time, entry.days);
    const key = recurringScheduleKey(entry.type, entry.time, publishAt);
    if (existingKeys.has(key)) continue;
    await createGeneratedContent({ type: entry.type, settings, schedule: true, publishAt, includeImage: entry.includeImage, scheduleKey: key });
    existingKeys.add(key);
    made += 1;
  }
  return made;
}

async function generateContentImage(title, bodyText, type, postID) {
  const visualDirection = {
    NEWS: 'Use a credible editorial photograph style for the specific subject, but do not imply that an invented event is real.',
    POLL: 'Use a warm, inviting lifestyle image that makes the two-choice topic immediately understandable.',
    TRIVIA: 'Use a focused educational editorial illustration of the subject, never a graphic containing the answer.',
    FACT_OF_THE_DAY: 'Use a clear, visually informative editorial illustration of the fact’s real subject.',
    ON_THIS_DAY: 'Use a respectful archival-inspired editorial illustration; do not fabricate a historical photograph.',
    MORAL_DILEMMA: 'Use a subtle, everyday scene that conveys the decision without judging either choice.',
    WOULD_YOU_RATHER: 'Use a playful but polished editorial illustration of the actual alternatives.',
    QUESTION_OF_THE_DAY: 'Use a natural, human-centred editorial image related directly to the question.',
  }[type] || 'Choose the most natural treatment: a credible editorial photograph style for concrete real-world subjects, or a polished editorial illustration when that communicates the topic more clearly.';
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${openAIKey.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: `Create one original, high-quality visual for a general-audience community ${type.toLowerCase().replaceAll('_', ' ')} post. It must be immediately and specifically relevant to the title and context, showing the main subject or action rather than a generic glow, abstract background, stock-style people, or unrelated decoration. ${visualDirection} Keep the composition clean enough for a feed card. No words, letters, numbers, logos, watermarks, UI, celebrities, unsafe content, or misleading factual claims. Title: ${title}. Context: ${bodyText}`.slice(0, 3000), size: '1024x1024', quality: 'low', output_format: 'jpeg' }),
  });
  if (!response.ok) throw new Error(`Image generation failed (${response.status}).`);
  const payload = await response.json();
  const base64 = payload?.data?.[0]?.b64_json;
  if (!base64) throw new Error('Image generation returned no image.');
  const path = `officialFeed/${postID}/ai-${Date.now()}.jpg`;
  const token = randomUUID();
  const file = getStorage().bucket().file(path);
  await file.save(Buffer.from(base64, 'base64'), { resumable: false, contentType: 'image/jpeg', metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
  const bucket = getStorage().bucket().name;
  return { path, imageURL: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media&token=${token}` };
}

async function createGeneratedContent({ type, settings = {}, ordinal = 1, schedule = false, publishAt = null, instruction = '', includeImage = false, scheduleKey = '' }) {
  if (!engineTypes.includes(type)) throw new HttpsError('invalid-argument', 'Unsupported content type.');
  const optionCount = fourOptionTypes.includes(type) ? 4 : twoOptionTypes.includes(type) ? 2 : 0;
  const generationInstruction = instruction.trim() || evergreenSeed(type, ordinal);
  const generated = await generateTranslations({ type, title: '', bodyText: '', options: Array.from({ length: optionCount }, () => ''), generationInstruction });
  const translations = generated.translations;
  const options = Array.from({ length: optionCount }, (_, index) => ({ id: `option-${index + 1}`, text: translations.en.pollOptions[`option-${index + 1}`] || `Option ${index + 1}` }));
  const ref = database.collection('adminFeedItems').doc();
  let image = { path: '', imageURL: '' };
  if (includeImage) {
    try { image = await generateContentImage(translations.en.title, translations.en.bodyText, type, ref.id); }
    catch (error) { console.error('Optional AI image failed', error); }
  }
  await ref.set({ id: ref.id, contentType: type, contentStatus: schedule ? 'SCHEDULED' : 'DRAFT', publishAt: schedule ? publishAt || nextEngineSlot(settings, ordinal, type) : null, scheduleKey: scheduleKey || null, translations, adminTitle: translations.en.title, bodyText: translations.en.bodyText, adminImageURL: image.imageURL, adminImagePath: image.path, kind: 'think', isAdminPost: true, sourceCollection: 'adminFeedItems', authorUID: 'content-engine', authorName: 'Redemption', authorImageURL: '', visibility: 'all', topicKey: type.toLowerCase(), aiGenerated: true, autoPublished: false, commentsEnabled: !['QUOTE', 'FACT_OF_THE_DAY', 'STORY_OF_THE_DAY', 'ON_THIS_DAY', 'RESULT'].includes(type), reactionsEnabled: optionCount === 0, poll: { enabled: optionCount > 0, options, correctOption: fourOptionTypes.includes(type) ? options[generated.correctOptionIndex]?.id || options[0]?.id || null : null, showResultsAfterVote: true, revealCorrectAnswerAfterVote: fourOptionTypes.includes(type), explanation: translations.en.explanation }, pollOptions: options, pollVotes: {}, positiveCount: 0, negativeCount: 0, positiveVoters: [], negativeVoters: [], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
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
  const sourceCollection = request.data?.sourceCollection === 'adminFeedItems' ? 'adminFeedItems' : 'posts';
  if (!postID) throw new HttpsError('invalid-argument', 'A post ID is required.');

  const postRef = database.collection(sourceCollection).doc(postID);
  const post = await postRef.get();
  if (!post.exists) throw new HttpsError('not-found', 'The post no longer exists.');

  const comments = await postRef.collection('comments').get();
  await commitInBatches([
    ...comments.docs.map(comment => ({ type: 'delete', ref: comment.ref })),
    { type: 'delete', ref: postRef },
  ]);
  return { deleted: true, postID, sourceCollection };
});

exports.adminDeleteComment = onCall({ region: 'us-central1' }, async request => {
  await requireAdministrator(request);

  const postID = String(request.data?.postID || '').trim();
  const commentID = String(request.data?.commentID || '').trim();
  const sourceCollection = request.data?.sourceCollection === 'adminFeedItems' ? 'adminFeedItems' : 'posts';
  if (!postID || !commentID) throw new HttpsError('invalid-argument', 'A post ID and comment ID are required.');

  const postRef = database.collection(sourceCollection).doc(postID);
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
  return { deleted: true, postID, commentID, deletedCount: idsToDelete.size, sourceCollection };
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

// The Admin AI Schedule tab explicitly creates only the entries selected by an
// administrator. Each supplied time becomes its own scheduled post.
exports.adminGenerateScheduledContent = onCall({ region: 'us-central1', secrets: [openAIKey], timeoutSeconds: 540 }, async request => {
  await requireAdministrator(request);
  const rawEntries = Array.isArray(request.data?.entries) ? request.data.entries : [];
  const entries = rawEntries.flatMap(entry => {
    const type = String(entry?.type || '').trim().toUpperCase();
    if (!engineTypes.includes(type)) return [];
    const times = Array.isArray(entry?.times) ? entry.times : [];
    const days = Array.isArray(entry?.days) ? [...new Set(entry.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))] : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) return [];
    return [...new Set(times.map(time => String(time || '').trim()).filter(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))].map(time => ({ type, time, includeImage: entry?.includeImage === true, days }));
  }).slice(0, 16);
  if (!entries.length) throw new HttpsError('invalid-argument', 'Select at least one content type and publishing time.');

  const settings = (await database.collection('adminContentSettings').doc('global').get()).data() || {};
  const scheduled = [];
  // Generating a full schedule can take several minutes. Resolve all target
  // slots at the instant the administrator clicks Generate, so later entries
  // do not silently roll over to tomorrow while earlier entries publish today.
  const schedulingStartedAt = new Date();
  for (const [index, entry] of entries.entries()) {
    const publishAt = nextEngineSlotOnSelectedDay(settings, entry.type, entry.time, entry.days, schedulingStartedAt);
    const scheduleKey = recurringScheduleKey(entry.type, entry.time, publishAt);
    const id = await createGeneratedContent({ type: entry.type, settings, ordinal: index + 1, schedule: true, publishAt, includeImage: entry.includeImage, scheduleKey });
    scheduled.push({ id, type: entry.type, time: entry.time, publishAt: publishAt.toISOString() });
  }
  return { scheduled };
});

// Runs independently of clients. It only advances already-reviewed scheduled
// content and locks voting at the configured close time.
exports.adminContentPublisher = onSchedule({ schedule: '* * * * *', timeZone: 'Europe/Zagreb' }, async () => {
  await publishDueContent();
});

// Monthly queue health check. Each run tops up the lowest queues in batches;
// generated content is stored with all translations before a user can see it.
exports.adminContentEvergreenPlanner = onSchedule({ schedule: '*/15 * * * *', timeZone: 'Europe/Zagreb', timeoutSeconds: 540, secrets: [openAIKey] }, async () => {
  await replenishRecurringAiSchedules();
  await replenishEvergreenContent();
});

// Existing content is upgraded only when an app language is missing, so this
// weekly safety pass has no API cost once the library is fully localized.
exports.adminContentTranslationBackfill = onSchedule({ schedule: '0 3 * * 0', timeZone: 'Europe/Zagreb', timeoutSeconds: 540, secrets: [openAIKey] }, async () => {
  await backfillContentTranslations();
});
