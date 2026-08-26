import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import { getFirestore, collection, onSnapshot, orderBy, query, doc, runTransaction, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

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
let selectedID = null;
let unsubscribeReports = null;
let unsubscribeUsers = null;
let unsubscribeDeletedAccounts = null;
let currentAdmin = null;
let activeView = 'reports';
let activeUserList = 'users';

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
$('#deleted-users-card').addEventListener('click', () => { activeUserList = 'deleted'; renderUsers(); });

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

function stopData() {
  [unsubscribeReports, unsubscribeUsers, unsubscribeDeletedAccounts].forEach(unsubscribe => {
    if (unsubscribe) unsubscribe();
  });
  unsubscribeReports = null;
  unsubscribeUsers = null;
  unsubscribeDeletedAccounts = null;
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
  $('#deleted-users-count').textContent = deletedAccounts.length;
  $('#total-users-card').classList.toggle('active', activeUserList === 'users');
  $('#deleted-users-card').classList.toggle('active', activeUserList === 'deleted');

  const isDeleted = activeUserList === 'deleted';
  const rows = (isDeleted ? deletedAccounts : users)
    .slice()
    .sort((a, b) => {
      if (isDeleted) return dateValue(b.deletedAt) - dateValue(a.deletedAt);
      return String(a.username || a.displayName || a.email || '').localeCompare(String(b.username || b.displayName || b.email || ''));
    });

  $('#user-table-title').textContent = isDeleted ? 'Deleted accounts' : 'Total users';
  $('#user-table-count').textContent = `${rows.length} account${rows.length === 1 ? '' : 's'}`;
  const table = $('#user-table');
  table.replaceChildren();
  if (!rows.length) {
    table.innerHTML = `<div class="empty-list">No ${isDeleted ? 'deleted accounts' : 'users'} yet.</div>`;
    return;
  }

  rows.forEach(account => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'user-row';
    row.innerHTML = `<div><b>${escapeHTML(account.username ? `@${String(account.username).replace(/^@+/, '')}` : account.displayName || 'No username')}</b><span>${escapeHTML(account.email || 'No email')}</span></div><small>${escapeHTML(isDeleted ? dateText(account.deletedAt) : account.displayName || account.uid || account.id)}</small>`;
    table.append(row);
  });
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
function actionsSection(report) { const wrapper = document.createElement('section'); wrapper.className = 'detail-section'; wrapper.innerHTML = '<h3>Moderation decision</h3><div class="actions-grid"></div><textarea class="action-note" maxlength="1000" placeholder="Optional note for the audit log"></textarea><p class="save-state" aria-live="polite"></p>'; const actions = wrapper.querySelector('.actions-grid'); const allowed = report.adminActions || ['dismiss', 'removeContent', 'warnUser', 'suspend', 'ban']; const labels = { dismiss: 'Dismiss', removeContent: 'Remove content', warnUser: 'Warn user', suspend: 'Suspend', ban: 'Ban' }; allowed.forEach(action => { const button = document.createElement('button'); button.type = 'button'; button.className = `moderation-action ${['suspend', 'ban', 'removeContent'].includes(action) ? 'danger' : ''}`; button.textContent = labels[action] || action; button.addEventListener('click', () => resolveReport(report, action, wrapper)); actions.append(button); }); return wrapper; }
function auditSection(log = []) { const container = document.createElement('section'); container.className = 'detail-section'; const title = document.createElement('h3'); title.textContent = 'Audit log'; container.append(title); const audit = document.createElement('div'); audit.className = 'audit'; if (!log.length) audit.innerHTML = '<div class="audit-item"><b>No audit entries</b><span>—</span></div>'; [...log].sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt)).forEach(entry => { const item = document.createElement('div'); item.className = 'audit-item'; item.innerHTML = `<b>${escapeHTML(entry.action || 'Update')} · ${escapeHTML(entry.actorName || 'Unknown')}</b><span>${escapeHTML(dateText(entry.createdAt))}</span>${entry.note ? `<p>${escapeHTML(entry.note)}</p>` : ''}`; audit.append(item); }); container.append(audit); return container; }

async function resolveReport(report, action, wrapper) {
  if (!currentAdmin) return;
  const note = wrapper.querySelector('.action-note').value.trim();
  const state = wrapper.querySelector('.save-state');
  const label = { dismiss: 'dismissed', removeContent: 'actioned', warnUser: 'actioned', suspend: 'actioned', ban: 'actioned' }[action] || 'actioned';
  state.textContent = 'Saving decision…';
  wrapper.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    await runTransaction(db, async transaction => {
      const ref = doc(db, 'reports', report.id);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('This report no longer exists.');
      const existingLog = snapshot.data().auditLog || [];
      transaction.update(ref, {
        status: label,
        lastAction: action,
        assignedTo: { uid: currentAdmin.uid, displayName: currentAdmin.name, email: currentAdmin.email },
        auditLog: [...existingLog, { action, actorUID: currentAdmin.uid, actorName: currentAdmin.name, note: note || `Admin action: ${action}.`, createdAt: Timestamp.now() }],
        updatedAt: serverTimestamp()
      });
    });
    state.textContent = 'Decision saved to the audit log.';
  } catch (exception) {
    console.error(exception);
    state.textContent = `Could not save: ${exception.message}`;
    wrapper.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

function dateValue(value) { if (!value) return 0; return typeof value.toDate === 'function' ? value.toDate().getTime() : new Date(value).getTime() || 0; }
function dateText(value) { const timestamp = dateValue(value); return timestamp ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)) : 'Just now'; }
function initials(name) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?'; }
function escapeHTML(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function friendlyAuthError(error) { if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') return 'Incorrect email or password.'; if (error.code === 'auth/too-many-requests') return 'Too many attempts. Try again later.'; return error.message || 'Could not sign in.'; }
