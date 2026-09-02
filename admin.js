import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import { getFirestore, collection, onSnapshot, orderBy, query, doc, runTransaction, serverTimestamp, Timestamp, where, getDocs, writeBatch } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

// Firebase web configuration is public by design. Database access is protected by Auth + Firestore Security Rules.
const firebaseConfig = {
  apiKey: 'AIzaSyDzaPiUdCCa9fsIx8XFmP3kRFOGlDBX23g',
  authDomain: 'redemption-7c875.firebaseapp.com',
  projectId: 'redemption-7c875',
  storageBucket: 'redemption-7c875.firebasestorage.app',
  messagingSenderId: '759576893648'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = selector => document.querySelector(selector);
const loginScreen = $('#login-screen');
const deniedScreen = $('#access-denied');
const dashboard = $('#dashboard');
const list = $('#report-list');
const detail = $('#detail-panel');
const loginButton = $('#login-submit');
const loginStatus = $('#login-status');
const filters = { status: 'open', type: 'all', priority: 'all', search: '' };
let reports = [];
let users = [];
let deletedAccounts = [];
let moderationWarnings = [];
let selectedID = null;
let unsubscribeReports = null;
let unsubscribeUsers = null;
let unsubscribeDeletedAccounts = null;
let unsubscribeWarnings = null;
let currentAdmin = null;
let activeView = 'reports';
let activeUserList = 'users';
let messageRecipient = null;

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#login-error');
  error.hidden = true;
  loginButton.disabled = true;
  loginButton.textContent = 'Signing in…';
  loginStatus.textContent = 'Contacting Firebase…';
  try {
    await signInWithEmailAndPassword(auth, $('#email').value.trim(), $('#password').value);
  } catch (exception) {
    error.textContent = friendlyAuthError(exception);
    error.hidden = false;
    loginStatus.textContent = 'Sign-in was not completed.';
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Sign in securely';
  }
});

$('#google-login').addEventListener('click', async () => {
  const error = $('#login-error'); error.hidden = true;
  const button = $('#google-login'); button.disabled = true;
  loginStatus.textContent = 'Opening Google sign-in…';
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (exception) { error.textContent = friendlyAuthError(exception); error.hidden = false; loginStatus.textContent = 'Sign-in was not completed.'; }
  finally { button.disabled = false; }
});

$('#signout').addEventListener('click', () => signOut(auth));
$('#denied-signout').addEventListener('click', () => signOut(auth));
$('#refresh').addEventListener('click', () => { if (currentAdmin) subscribeToData(); });
$('#search').addEventListener('input', event => { filters.search = event.target.value.trim().toLowerCase(); render(); });
$('#status-filter').addEventListener('change', event => { filters.status = event.target.value; render(); });
$('#type-filter').addEventListener('change', event => { filters.type = event.target.value; render(); });
$('#priority-filter').addEventListener('change', event => { filters.priority = event.target.value; render(); });
$('#open-filter').addEventListener('click', () => setQueue('open'));
$('#all-filter').addEventListener('click', () => setQueue('all'));
$('#users-filter').addEventListener('click', () => setView('users'));
$('#total-users-card').addEventListener('click', () => { activeUserList = 'users'; renderUsers(); });
$('#banned-users-card').addEventListener('click', () => { activeUserList = 'banned'; renderUsers(); });
$('#suspended-users-card').addEventListener('click', () => { activeUserList = 'suspended'; renderUsers(); });
$('#warned-users-card').addEventListener('click', () => { activeUserList = 'warned'; renderUsers(); });
$('#deleted-users-card').addEventListener('click', () => { activeUserList = 'deleted'; renderUsers(); });
$('#close-admin-message').addEventListener('click', closeMessageComposer);
$('#admin-message-modal').addEventListener('click', event => { if (event.target === $('#admin-message-modal')) closeMessageComposer(); });
$('#admin-message-form').addEventListener('submit', sendAdminMessage);

onAuthStateChanged(auth, async user => {
  stopData();
  currentAdmin = null;
  if (!user) {
    loginStatus.textContent = 'Ready to sign in.';
    return showScreen(loginScreen);
  }
  try {
    const token = await user.getIdTokenResult(true);
    if (token.claims.admin !== true) return showScreen(deniedScreen);
    currentAdmin = { uid: user.uid, name: user.displayName || user.email || 'Administrator', email: user.email || '' };
    $('#admin-email').textContent = currentAdmin.email;
    showScreen(dashboard);
    subscribeToData();
  } catch (exception) {
    console.error(exception);
    showScreen(deniedScreen);
  }
});

loginButton.disabled = false;
loginStatus.textContent = 'Ready to sign in.';

function showScreen(screen) {
  [loginScreen, deniedScreen, dashboard].forEach(element => { element.hidden = element !== screen; });
}

function subscribeToData() {
  subscribeToReports();
  subscribeToUsers();
  subscribeToDeletedAccounts();
  subscribeToWarnings();
}

function subscribeToReports() {
  if (unsubscribeReports) {
    unsubscribeReports();
    unsubscribeReports = null;
  }
  $('#load-message').textContent = 'Loading reports…';
  unsubscribeReports = onSnapshot(query(collection(db, 'reports'), orderBy('createdAt', 'desc')), snapshot => {
    reports = snapshot.docs.map(documentSnapshot => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
    $('#load-message').textContent = reports.length ? `${reports.length} report${reports.length === 1 ? '' : 's'} loaded` : 'No reports yet.';
    if (selectedID && !reports.some(report => report.id === selectedID)) selectedID = null;
    render();
  }, error => {
    console.error(error);
    $('#load-message').textContent = error.code === 'permission-denied' ? 'Permission denied. Confirm the admin claim and Firestore Rules.' : `Could not load reports: ${error.message}`;
  });
}

function subscribeToUsers() {
  if (unsubscribeUsers) {
    unsubscribeUsers();
    unsubscribeUsers = null;
  }
  unsubscribeUsers = onSnapshot(collection(db, 'users'), snapshot => {
    users = snapshot.docs.map(documentSnapshot => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
    renderUsers();
  }, error => {
    console.error(error);
    $('#user-table').innerHTML = `<div class="empty-list">Could not load users: ${escapeHTML(error.message)}</div>`;
  });
}

function subscribeToDeletedAccounts() {
  if (unsubscribeDeletedAccounts) {
    unsubscribeDeletedAccounts();
    unsubscribeDeletedAccounts = null;
  }
  unsubscribeDeletedAccounts = onSnapshot(collection(db, 'deletedAccounts'), snapshot => {
    deletedAccounts = snapshot.docs.map(documentSnapshot => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
    renderUsers();
  }, error => {
    console.error(error);
    $('#user-table').innerHTML = `<div class="empty-list">Could not load deleted accounts: ${escapeHTML(error.message)}</div>`;
  });
}

function subscribeToWarnings() {
  if (unsubscribeWarnings) {
    unsubscribeWarnings();
    unsubscribeWarnings = null;
  }
  unsubscribeWarnings = onSnapshot(collection(db, 'moderationWarnings'), snapshot => {
    moderationWarnings = snapshot.docs.map(documentSnapshot => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
    renderUsers();
  }, error => {
    console.error(error);
    // User data still works if a legacy project has not yet granted the warning collection permission.
  });
}

function stopData() {
  [unsubscribeReports, unsubscribeUsers, unsubscribeDeletedAccounts, unsubscribeWarnings].forEach(unsubscribe => {
    if (unsubscribe) unsubscribe();
  });
  unsubscribeReports = null;
  unsubscribeUsers = null;
  unsubscribeDeletedAccounts = null;
  unsubscribeWarnings = null;
}

function setQueue(status) {
  setView('reports');
  filters.status = status;
  $('#status-filter').value = status;
  $('#open-filter').classList.toggle('active', status === 'open');
  $('#all-filter').classList.toggle('active', status === 'all');
  render();
}

function setView(view) {
  activeView = view;
  $('#users-filter').classList.toggle('active', view === 'users');
  $('#open-filter').classList.toggle('active', view === 'reports' && filters.status === 'open');
  $('#all-filter').classList.toggle('active', view === 'reports' && filters.status === 'all');
  $('.content-top .eyebrow').textContent = view === 'users' ? 'Admin overview' : 'Trust & safety';
  $('.content-top h1').textContent = view === 'users' ? 'User insights' : 'Review reports';
  $('.filters').hidden = view === 'users';
  $('#load-message').hidden = view === 'users';
  $('#report-list').hidden = view === 'users';
  $('#user-insights').hidden = view !== 'users';
  detail.hidden = view === 'users';
  if (view === 'users') renderUsers();
  render();
}

function filteredReports() {
  return reports.filter(report => {
    const text = [report.target?.title, report.target?.excerpt, report.reporter?.displayName, report.reporter?.username, report.reporter?.email, report.reportedUser?.displayName, report.reportedUser?.username, report.reportedUser?.email, report.reason, report.details].filter(Boolean).join(' ').toLowerCase();
    return (filters.status === 'all' || report.status === filters.status)
      && (filters.type === 'all' || report.type === filters.type)
      && (filters.priority === 'all' || (report.priority || 'normal') === filters.priority)
      && (!filters.search || text.includes(filters.search));
  });
}

function render() {
  $('#users-count').textContent = users.length;
  if (activeView === 'users') {
    renderUsers();
    return;
  }
  const visible = filteredReports();
  const openCount = reports.filter(report => report.status === 'open').length;
  $('#open-count').textContent = openCount;
  $('#all-count').textContent = reports.length;
  list.replaceChildren();
  if (!visible.length) {
    list.innerHTML = '<div class="empty-list">No reports match these filters.</div>';
  } else {
    const template = $('#report-template');
    visible.forEach(report => {
      const node = template.content.cloneNode(true);
      const row = node.querySelector('.report-row');
      row.classList.toggle('selected', report.id === selectedID);
      const button = node.querySelector('.report-select');
      button.addEventListener('click', () => { selectedID = report.id; render(); });
      const priority = report.priority || 'normal';
      const dot = node.querySelector('.priority-dot'); dot.classList.add(priority);
      node.querySelector('.report-type').textContent = `${report.type || 'report'} · ${priority}`;
      node.querySelector('time').textContent = dateText(report.createdAt);
      node.querySelector('h2').textContent = report.target?.title || 'Untitled report';
      node.querySelector('.report-excerpt').textContent = report.target?.excerpt || report.details || 'No submitted context.';
      node.querySelector('.reason').textContent = report.reason || 'No reason';
      node.querySelector('.reported-name').textContent = `Reported: ${report.reportedUser?.displayName || 'Unknown user'}`;
      list.append(node);
    });
  }
  renderDetail(reports.find(report => report.id === selectedID));
}

function renderUsers() {
  $('#users-count').textContent = users.length;
  $('#total-users-count').textContent = users.length;
  const bannedUsers = users.filter(user => user.moderationStatus === 'banned');
  const suspendedUsers = users.filter(user => user.moderationStatus === 'suspended' && !suspensionExpired(user));
  const warnedUserIDs = new Set(moderationWarnings.filter(warning => warning.status !== 'rescinded').map(warning => warning.recipientUID).filter(Boolean));
  const warnedUsers = users.filter(user => warnedUserIDs.has(user.uid || user.id));
  $('#banned-users-count').textContent = bannedUsers.length;
  $('#suspended-users-count').textContent = suspendedUsers.length;
  $('#warned-users-count').textContent = warnedUsers.length;
  $('#deleted-users-count').textContent = deletedAccounts.length;
  $('#total-users-card').classList.toggle('active', activeUserList === 'users');
  $('#banned-users-card').classList.toggle('active', activeUserList === 'banned');
  $('#suspended-users-card').classList.toggle('active', activeUserList === 'suspended');
  $('#warned-users-card').classList.toggle('active', activeUserList === 'warned');
  $('#deleted-users-card').classList.toggle('active', activeUserList === 'deleted');

  const isDeleted = activeUserList === 'deleted';
  const listByState = activeUserList === 'banned' ? bannedUsers : activeUserList === 'suspended' ? suspendedUsers : activeUserList === 'warned' ? warnedUsers : users;
  const rows = (isDeleted ? deletedAccounts : listByState)
    .slice()
    .sort((a, b) => {
      if (isDeleted) return dateValue(b.deletedAt) - dateValue(a.deletedAt);
      return String(a.username || a.displayName || a.email || '').localeCompare(String(b.username || b.displayName || b.email || ''));
    });

  const titles = { users: 'Total users', banned: 'Banned users', suspended: 'Suspended users', warned: 'Warned users', deleted: 'Deleted accounts' };
  $('#user-table-title').textContent = titles[activeUserList] || 'Users';
  $('#user-table-count').textContent = `${rows.length} account${rows.length === 1 ? '' : 's'} · use Actions to manage an account`;
  const table = $('#user-table');
  table.replaceChildren();
  if (!rows.length) {
    table.innerHTML = `<div class="empty-list">No ${titles[activeUserList].toLowerCase()} yet.</div>`;
    return;
  }

  rows.forEach(account => {
    const row = document.createElement('div');
    row.className = 'user-row';
    const status = userStatus(account, warnedUserIDs, isDeleted);
    const statusInfo = isDeleted ? dateText(account.deletedAt) : moderationSummary(account, status);
    row.innerHTML = `<div><b>${escapeHTML(account.username ? `@${String(account.username).replace(/^@+/, '')}` : account.displayName || 'No username')}</b><span>${escapeHTML(account.email || 'No email')}</span>${!isDeleted ? `<em class="user-status ${status}">${escapeHTML(status)}</em>` : ''}</div><div class="user-row-actions"><small>${escapeHTML(statusInfo)}</small></div>`;
    const actions = row.querySelector('.user-row-actions');
    const menu = !isDeleted ? createUserActionMenu(account) : null;
    if (menu) actions.append(menu);
    if (!isDeleted && (status === 'banned' || status === 'suspended')) {
      addMenuAction(menu, status === 'banned' ? 'Unban account' : 'Unsuspend account', 'restore-user', button => restoreModeration(account, status, button));
    }
    if (!isDeleted && (status === 'active' || status === 'warned')) {
      addMenuAction(menu, 'Suspend account', 'suspend-user', button => directModeration(account, 'suspend', button));
      addMenuAction(menu, 'Ban account', 'ban-user', button => directModeration(account, 'ban', button));
    }
    if (!isDeleted && status === 'warned') {
      addMenuAction(menu, 'Clear warnings', 'restore-user warning', button => clearWarning(account, button));
    }
    if (!isDeleted) {
      addMenuAction(menu, 'Send message', 'message-user', () => openMessageComposer(account));
      addMenuAction(menu, 'Delete account', 'delete-user', button => deleteAccountFromAdmin(account, button));
    }
    table.append(row);
  });
}

function createUserActionMenu(account) {
  const menu = document.createElement('details');
  menu.className = 'user-action-menu';
  menu.innerHTML = `<summary aria-label="Actions for ${escapeHTML(account.displayName || account.email || 'user')}" title="Actions">•••</summary><div class="user-action-popover"></div>`;
  return menu;
}

function addMenuAction(menu, label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label;
  button.addEventListener('click', async event => {
    event.preventDefault();
    await onClick(button);
    if (!button.disabled) menu.open = false;
  });
  menu.querySelector('.user-action-popover').append(button);
}

function suspensionExpired(user) {
  return user.moderationStatus === 'suspended' && user.moderationUntil && dateValue(user.moderationUntil) <= Date.now();
}

function userStatus(user, warnedUserIDs, isDeleted) {
  if (isDeleted) return 'deleted';
  if (user.moderationStatus === 'banned') return 'banned';
  if (user.moderationStatus === 'suspended' && !suspensionExpired(user)) return 'suspended';
  if (warnedUserIDs.has(user.uid || user.id)) return 'warned';
  return 'active';
}

function moderationSummary(user, status) {
  if (status === 'suspended') return user.moderationUntil ? `Until ${dateText(user.moderationUntil)}` : 'Indefinite suspension';
  if (status === 'banned') return user.moderationReason || 'Banned by moderation';
  if (status === 'warned') return 'Warning on record';
  if (user.moderationStatus === 'suspended' && suspensionExpired(user)) return 'Suspension expired';
  return user.moderationReason || 'No moderation action';
}

async function restoreModeration(account, status, button) {
  if (!currentAdmin) return;
  const label = status === 'banned' ? 'unban this account' : 'unsuspend this account';
  if (!window.confirm(`Are you sure you want to ${label}? The user will immediately regain access to Redemption.`)) return;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await runTransaction(db, async transaction => {
      transaction.set(doc(db, 'users', account.id || account.uid), {
        moderationStatus: 'active',
        moderationReason: null,
        moderationUntil: null,
        moderatedAt: serverTimestamp(),
        moderatedBy: currentAdmin.uid,
        lastModerationAction: status === 'banned' ? 'unban' : 'unsuspend',
        lastModerationNote: `Account restored by ${currentAdmin.name}.`
      }, { merge: true });
    });
    button.disabled = false;
    button.textContent = 'Restored';
  } catch (exception) {
    console.error(exception);
    button.disabled = false;
    button.textContent = status === 'banned' ? 'Unban' : 'Unsuspend';
    window.alert(`Could not restore account: ${exception.message}`);
  }
}

async function directModeration(account, action, button) {
  if (!currentAdmin) return;
  const name = account.displayName || account.username || account.email || account.id;
  const reason = window.prompt(`Reason for ${action === 'ban' ? 'banning' : 'suspending'} ${name}:`, 'Moderation decision');
  if (reason === null) return;
  if (!reason.trim()) { window.alert('A moderation reason is required.'); return; }

  let moderationUntil = null;
  if (action === 'suspend') {
    const rawDays = window.prompt('Suspend for how many days? Use 1, 7, 30, or 0 for indefinitely.', '7');
    if (rawDays === null) return;
    const days = Number(rawDays);
    if (!Number.isFinite(days) || days < 0) { window.alert('Enter a positive number of days, or 0 for indefinitely.'); return; }
    moderationUntil = days ? Timestamp.fromDate(new Date(Date.now() + days * 86400000)) : null;
  }

  const confirmation = action === 'ban'
    ? `Ban ${name}? They will immediately lose access to Redemption.`
    : `Suspend ${name}${moderationUntil ? ` until ${dateText(moderationUntil)}` : ' indefinitely'}?`;
  if (!window.confirm(confirmation)) return;

  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const uid = account.id || account.uid;
    await runTransaction(db, async transaction => {
      transaction.set(doc(db, 'users', uid), {
        moderationStatus: action === 'ban' ? 'banned' : 'suspended',
        moderationReason: reason.trim(),
        moderationUntil: action === 'ban' ? null : moderationUntil,
        moderatedAt: serverTimestamp(),
        moderatedBy: currentAdmin.uid,
        lastModerationAction: action,
        lastModerationNote: reason.trim()
      }, { merge: true });
    });
    // Existing warning records are not part of the access decision. A legacy
    // warning rule must never make an already-saved ban/suspension look failed.
    try { await markUnreadWarningsRead(uid); } catch (warningError) { console.warn('Could not mark old warnings read:', warningError); }
    button.disabled = false;
    button.textContent = action === 'ban' ? 'Banned' : 'Suspended';
  } catch (exception) {
    console.error(exception);
    button.disabled = false;
    button.textContent = action === 'ban' ? 'Ban' : 'Suspend';
    window.alert(`Could not ${action} account: ${exception.message}`);
  }
}

async function clearWarning(account, button) {
  if (!currentAdmin) return;
  if (!window.confirm('Clear all active warning records for this account? The account will remain active.')) return;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const userID = account.uid || account.id;
    const activeWarnings = moderationWarnings.filter(warning => warning.recipientUID === userID && warning.status !== 'rescinded');
    const batch = writeBatch(db);
    activeWarnings.forEach(warning => batch.update(doc(db, 'moderationWarnings', warning.id), {
      status: 'rescinded',
      rescindedAt: serverTimestamp(),
      rescindedBy: currentAdmin.uid,
      rescindedByName: currentAdmin.name
    }));
    await batch.commit();
    button.disabled = false;
    button.textContent = 'Warnings cleared';
  } catch (exception) {
    console.error(exception);
    button.disabled = false;
    button.textContent = 'Clear warning';
    window.alert(`Could not clear warning: ${exception.message}`);
  }
}

function openMessageComposer(account) {
  messageRecipient = account;
  $('#admin-message-recipient').textContent = `To ${account.displayName || account.username || account.email || account.id}`;
  $('#admin-message-text').value = '';
  $('#admin-message-type').value = 'warning';
  $('#admin-message-state').textContent = '';
  $('#send-admin-message').disabled = false;
  $('#send-admin-message').textContent = 'Send to app';
  $('#admin-message-modal').hidden = false;
  $('#admin-message-text').focus();
}

function closeMessageComposer() {
  messageRecipient = null;
  $('#admin-message-modal').hidden = true;
}

async function sendAdminMessage(event) {
  event.preventDefault();
  if (!currentAdmin || !messageRecipient) return;
  const message = $('#admin-message-text').value.trim();
  const noticeType = $('#admin-message-type').value;
  const state = $('#admin-message-state');
  if (!message) return;
  const button = $('#send-admin-message');
  button.disabled = true;
  state.textContent = 'Sending to the app…';
  try {
    await runTransaction(db, async transaction => {
      const warningRef = doc(collection(db, 'moderationWarnings'));
      transaction.set(warningRef, {
        id: warningRef.id,
        recipientUID: messageRecipient.uid || messageRecipient.id,
        recipient: {
          uid: messageRecipient.uid || messageRecipient.id,
          displayName: messageRecipient.displayName || '',
          username: messageRecipient.username || '',
          email: messageRecipient.email || '',
          profileImageURL: messageRecipient.profileImageURL || ''
        },
        reportID: null,
        reason: noticeType,
        message,
        noticeType,
        status: 'unread',
        createdAt: serverTimestamp(),
        createdBy: currentAdmin.uid,
        createdByName: currentAdmin.name
      });
    });
    state.textContent = 'Sent. It will appear as an in-app popup immediately.';
    window.setTimeout(closeMessageComposer, 700);
  } catch (exception) {
    console.error(exception);
    state.textContent = `Could not send: ${exception.message}`;
    button.disabled = false;
  }
}

async function deleteAccountFromAdmin(account, button) {
  if (!currentAdmin) return;
  const name = account.displayName || account.username || account.email || account.id;
  if (!window.confirm(`Delete ${name}'s account permanently? This removes their Firebase Authentication account, profile and authored content. This cannot be undone.`)) return;
  button.disabled = true;
  button.textContent = 'Deleting…';
  try {
    const response = await fetch('https://us-central1-redemption-7c875.cloudfunctions.net/adminDeleteAccount', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await auth.currentUser.getIdToken()}`
      },
      body: JSON.stringify({ data: { uid: account.id || account.uid } })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || 'The secure account deletion service is not available.');
  } catch (exception) {
    console.error(exception);
    button.disabled = false;
    button.textContent = 'Delete account';
    const message = exception instanceof TypeError && /load failed/i.test(exception.message)
      ? 'Account deletion is not deployed yet. The admin function must be deployed once before this action can work.'
      : `Could not delete account: ${exception.message}`;
    window.alert(message);
  }
}

function renderDetail(report) {
  if (!report) {
    detail.innerHTML = '<div class="empty-detail"><span>⌁</span><h2>Select a report</h2><p>Review the submitted context, then record a moderation decision.</p></div>';
    return;
  }
  detail.replaceChildren();
  const top = document.createElement('div'); top.className = 'detail-top';
  const title = document.createElement('div');
  title.innerHTML = `<h2>${escapeHTML(report.target?.title || 'Report')}</h2><span class="status-pill ${escapeHTML(report.status || 'open')}">${escapeHTML(report.status || 'open')}</span>`;
  const date = document.createElement('time'); date.className = 'detail-date'; date.textContent = dateText(report.createdAt);
  top.append(title, date); detail.append(top);
  detail.append(section('Reported content', targetCard(report)));
  const reason = document.createElement('p'); reason.className = 'reason-copy'; reason.innerHTML = `<strong>${escapeHTML(report.reason || 'No reason selected')}</strong>${report.details ? `<br>${escapeHTML(report.details)}` : ''}`;
  detail.append(section('Reason', reason));
  const people = document.createElement('div'); people.className = 'people'; people.append(person('Reporter', report.reporter), person('Reported user', report.reportedUser));
  detail.append(section('People', people));
  detail.append(actionsSection(report));
  detail.append(auditSection(report.auditLog));
}

function section(heading, content) { const element = document.createElement('section'); element.className = 'detail-section'; const h3 = document.createElement('h3'); h3.textContent = heading; element.append(h3, content); return element; }
function targetCard(report) { const card = document.createElement('div'); card.className = 'target-card'; card.innerHTML = `<b>${escapeHTML((report.target?.type || report.type || 'content').toUpperCase())}</b><p>${escapeHTML(report.target?.excerpt || 'No snapshot was stored for this report.')}</p>`; return card; }
function person(label, value) { const item = document.createElement('div'); item.className = 'person'; const avatar = document.createElement('div'); avatar.className = 'person-avatar'; const image = value?.profileImageURL; if (image && /^https:|^data:image\//.test(image)) { const img = document.createElement('img'); img.src = image; img.alt = ''; avatar.append(img); } else { avatar.textContent = initials(value?.displayName || '?'); } const copy = document.createElement('div'); copy.innerHTML = `<b>${escapeHTML(label)} · ${escapeHTML(value?.displayName || 'Unknown')}</b><span>${escapeHTML(value?.username || value?.email || 'No account details')}</span>`; item.append(avatar, copy); return item; }
function actionsSection(report) { const wrapper = document.createElement('section'); wrapper.className = 'detail-section'; wrapper.innerHTML = '<h3>Moderation decision</h3><label class="suspend-duration">Suspend for<select><option value="1">24 hours</option><option value="7">7 days</option><option value="30">30 days</option><option value="0">Indefinitely</option></select></label><div class="actions-grid"></div><textarea class="action-note" maxlength="1000" placeholder="Optional note for the audit log"></textarea><p class="save-state" aria-live="polite"></p>'; const actions = wrapper.querySelector('.actions-grid'); const allowed = report.adminActions || ['dismiss', 'removeContent', 'warnUser', 'suspend', 'ban']; const labels = { dismiss: 'Dismiss', removeContent: 'Remove content', warnUser: 'Warn user', suspend: 'Suspend', ban: 'Ban' }; allowed.forEach(action => { const button = document.createElement('button'); button.type = 'button'; button.className = `moderation-action ${['suspend', 'ban', 'removeContent'].includes(action) ? 'danger' : ''}`; button.textContent = labels[action] || action; button.addEventListener('click', () => resolveReport(report, action, wrapper)); actions.append(button); }); return wrapper; }
function auditSection(log = []) { const container = document.createElement('section'); container.className = 'detail-section'; const title = document.createElement('h3'); title.textContent = 'Audit log'; container.append(title); const audit = document.createElement('div'); audit.className = 'audit'; if (!log.length) audit.innerHTML = '<div class="audit-item"><b>No audit entries</b><span>—</span></div>'; [...log].sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt)).forEach(entry => { const item = document.createElement('div'); item.className = 'audit-item'; item.innerHTML = `<b>${escapeHTML(entry.action || 'Update')} · ${escapeHTML(entry.actorName || 'Unknown')}</b><span>${escapeHTML(dateText(entry.createdAt))}</span>${entry.note ? `<p>${escapeHTML(entry.note)}</p>` : ''}`; audit.append(item); }); container.append(audit); return container; }

async function resolveReport(report, action, wrapper) {
  if (!currentAdmin) return;
  const note = wrapper.querySelector('.action-note').value.trim();
  const state = wrapper.querySelector('.save-state');
  const label = { dismiss: 'dismissed', removeContent: 'actioned', warnUser: 'actioned', suspend: 'actioned', ban: 'actioned' }[action] || 'actioned';
  const reportedUID = reportedUserID(report);
  if (['ban', 'suspend'].includes(action) && !reportedUID) { state.textContent = 'Could not update account: this report has no reported user UID.'; return; }
  const durationDays = Number(wrapper.querySelector('.suspend-duration select')?.value || 0);
  const moderationUntil = durationDays ? Timestamp.fromDate(new Date(Date.now() + durationDays * 86400000)) : null;
  state.textContent = 'Saving decision…';
  wrapper.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const contentRefsToDelete = action === 'removeContent' ? await reportedContentRefs(report) : [];
    await runTransaction(db, async transaction => {
      const ref = doc(db, 'reports', report.id);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('This report no longer exists.');
      const existingLog = snapshot.data().auditLog || [];
      if (action === 'removeContent') deleteReportedContent(transaction, contentRefsToDelete);
      if (action === 'warnUser') createWarningNotice(transaction, report, note);
      transaction.update(ref, {
        status: label,
        lastAction: action,
        assignedTo: { uid: currentAdmin.uid, displayName: currentAdmin.name, email: currentAdmin.email },
        auditLog: [...existingLog, { action, actorUID: currentAdmin.uid, actorName: currentAdmin.name, note: note || `Admin action: ${action}.`, createdAt: Timestamp.now() }],
        updatedAt: serverTimestamp()
      });
      if (action === 'ban' || action === 'suspend') transaction.set(doc(db, 'users', reportedUID), { moderationStatus: action === 'ban' ? 'banned' : 'suspended', moderationReason: note || report.reason || 'Moderation decision', moderationUntil: action === 'ban' ? null : moderationUntil, moderatedAt: serverTimestamp(), moderatedBy: currentAdmin.uid }, { merge: true });
    });
    if (action === 'ban' || action === 'suspend') await markUnreadWarningsRead(reportedUID);
    state.textContent = 'Decision saved to the audit log.';
  } catch (exception) {
    console.error(exception);
    state.textContent = `Could not save: ${exception.message}`;
    wrapper.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

function createWarningNotice(transaction, report, note) {
  const reportedUID = reportedUserID(report);
  if (!reportedUID) throw new Error('Could not warn account: this report has no reported user UID.');

  const warningRef = doc(collection(db, 'moderationWarnings'));
  const message = note || `Your account received a warning for: ${report.reason || 'a moderation issue'}. Please review the community guidelines before posting again.`;

  transaction.set(warningRef, {
    id: warningRef.id,
    recipientUID: reportedUID,
    recipient: report.reportedUser || null,
    reportID: report.id,
    reason: report.reason || 'Moderation warning',
    message,
    status: 'unread',
    createdAt: serverTimestamp(),
    createdBy: currentAdmin.uid,
    createdByName: currentAdmin.name
  });
}

async function markUnreadWarningsRead(uid) {
  if (!uid) return;

  const snapshot = await getDocs(query(
    collection(db, 'moderationWarnings'),
    where('recipientUID', '==', uid),
    where('status', '==', 'unread')
  ));

  if (snapshot.empty) return;

  const batch = writeBatch(db);
  snapshot.forEach(documentSnapshot => {
    batch.update(documentSnapshot.ref, {
      status: 'read',
      readAt: serverTimestamp()
    });
  });
  await batch.commit();
}

function reportedUserID(report) {
  return report.reportedUser?.uid || report.target?.ownerUID || report.target?.userID || null;
}

async function reportedContentRefs(report) {
  const path = report.target?.path;
  if (!path) throw new Error('This report has no content path to remove.');

  const parts = path.split('/');
  if (parts[0] !== 'posts' || !['2', '4'].includes(String(parts.length))) throw new Error('Unsupported content path.');

  if (parts.length === 2) {
    const postRef = doc(db, 'posts', parts[1]);
    const comments = await getDocs(query(collection(db, 'posts', parts[1], 'comments')));
    return [...comments.docs.map(comment => comment.ref), postRef];
  }

  if (parts[2] !== 'comments') throw new Error('Unsupported content path.');
  return [doc(db, 'posts', parts[1], 'comments', parts[3])];
}

function deleteReportedContent(transaction, refs) {
  refs.forEach(ref => transaction.delete(ref));
}

function dateValue(value) { if (!value) return 0; return typeof value.toDate === 'function' ? value.toDate().getTime() : new Date(value).getTime() || 0; }
function dateText(value) { const timestamp = dateValue(value); return timestamp ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)) : 'Just now'; }
function initials(name) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?'; }
function escapeHTML(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function friendlyAuthError(error) { if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') return 'Incorrect email or password.'; if (error.code === 'auth/too-many-requests') return 'Too many attempts. Try again later.'; return error.message || 'Could not sign in.'; }
