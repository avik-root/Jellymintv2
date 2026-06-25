import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, collection, doc, setDoc, getDoc, getDocs, updateDoc } from './firebase.js';

// DOM Elements
const loadingScreen = document.getElementById('loading-screen');
const loginScreen = document.getElementById('login-screen');
const deniedScreen = document.getElementById('denied-screen');
const adminApp = document.getElementById('admin-app');
const adminEmailDisplay = document.getElementById('admin-email');

const loginBtn = document.getElementById('google-login-btn');
const logoutBtn = document.getElementById('logout-btn');
const sidebarLogoutBtn = document.getElementById('sidebar-logout');
const loginError = document.getElementById('login-error');

// Auth Flow
const SUPER_ADMIN = import.meta.env.VITE_ADMIN_EMAIL;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showScreen(loginScreen);
    return;
  }

  showScreen(loadingScreen);

  try {
    // Check if user is Super Admin or in admins collection
    let isAdmin = false;
    
    if (user.email === SUPER_ADMIN) {
      isAdmin = true;
      // Auto-add super admin to DB
      await setDoc(doc(db, 'admins', user.email), {
        addedAt: new Date(),
        role: 'superadmin'
      }, { merge: true });
    } else {
      const adminDoc = await getDoc(doc(db, 'admins', user.email));
      if (adminDoc.exists()) {
        isAdmin = true;
      }
    }

    if (isAdmin) {
      adminEmailDisplay.textContent = user.email;
      showScreen(adminApp);
      initDashboard();
    } else {
      showScreen(deniedScreen);
    }
  } catch (error) {
    console.error("Auth verification failed", error);
    showScreen(loginScreen);
    loginError.textContent = "Error verifying admin status.";
  }
});

// Login Handlers
loginBtn.addEventListener('click', async () => {
  try {
    loginError.textContent = '';
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    loginError.textContent = error.message;
  }
});

const handleLogout = async () => {
  await signOut(auth);
};
logoutBtn.addEventListener('click', handleLogout);
sidebarLogoutBtn.addEventListener('click', handleLogout);

// Screen Management
function showScreen(screen) {
  loadingScreen.style.display = 'none';
  loginScreen.style.display = 'none';
  deniedScreen.style.display = 'none';
  adminApp.style.display = 'none';
  screen.style.display = screen === adminApp ? 'flex' : 'flex';
}

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    e.currentTarget.classList.add('active');
    
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + e.currentTarget.dataset.target).classList.add('active');
  });
});

// --- Dashboard Logic ---
async function initDashboard() {
  loadSettings();
  loadUsers();
}

// Settings
async function loadSettings() {
  const settingsRef = doc(db, 'settings', 'global');
  const snap = await getDoc(settingsRef);
  if (snap.exists()) {
    const data = snap.data();
    document.getElementById('setting-free-for-all').checked = data.freeForAll || false;
    document.getElementById('setting-tier-free').value = data.limits?.free || 5000;
    document.getElementById('setting-tier-pro').value = data.limits?.pro || 50000;
    document.getElementById('setting-tier-advanced').value = data.limits?.advanced || 1000000;
  }
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-settings-btn');
  btn.textContent = 'Saving...';
  
  const settings = {
    freeForAll: document.getElementById('setting-free-for-all').checked,
    limits: {
      free: parseInt(document.getElementById('setting-tier-free').value),
      pro: parseInt(document.getElementById('setting-tier-pro').value),
      advanced: parseInt(document.getElementById('setting-tier-advanced').value)
    }
  };

  await setDoc(doc(db, 'settings', 'global'), settings, { merge: true });
  btn.textContent = 'Saved!';
  setTimeout(() => btn.textContent = 'Save Changes', 2000);
});

// Users
let currentUsers = [];

async function loadUsers() {
  const usersRef = collection(db, 'users');
  const snap = await getDocs(usersRef);
  
  const tbody = document.getElementById('users-table-body');
  tbody.innerHTML = '';
  
  let totalTokens = 0;
  currentUsers = [];

  snap.forEach(docSnap => {
    const data = docSnap.data();
    const uid = docSnap.id;
    currentUsers.push({ uid, ...data });
    
    const tokens = data.tokens || 0;
    totalTokens += tokens;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="font-weight: 600;">${data.name || 'Unknown'}</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">${data.email || 'No email'}</div>
      </td>
      <td>
        <div>${data.ip || 'Unknown IP'}</div>
      </td>
      <td>
        <span class="badge ${data.tier || 'free'}">${(data.tier || 'free').toUpperCase()}</span>
      </td>
      <td style="font-family: monospace; font-weight: bold;">
        ${tokens.toLocaleString()}
      </td>
      <td>
        ${data.lastActive ? new Date(data.lastActive.toDate()).toLocaleDateString() : 'Never'}
      </td>
      <td>
        <button class="action-btn edit-user" data-uid="${uid}">Edit</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('stat-users').textContent = currentUsers.length;
  // Tokens consumed would require tracking spent tokens, for now we just show current total held.
  document.getElementById('stat-tokens').textContent = 'N/A';

  // Attach edit handlers
  document.querySelectorAll('.edit-user').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const uid = e.target.dataset.uid;
      openEditModal(uid);
    });
  });
}

// Edit Modal
const modal = document.getElementById('edit-user-modal');

function openEditModal(uid) {
  const user = currentUsers.find(u => u.uid === uid);
  if (!user) return;
  
  document.getElementById('edit-uid').value = uid;
  document.getElementById('edit-name').value = user.name || user.email;
  document.getElementById('edit-tier').value = user.tier || 'free';
  document.getElementById('edit-tokens').value = user.tokens || 0;
  
  modal.style.display = 'flex';
}

document.getElementById('close-modal-btn').addEventListener('click', () => {
  modal.style.display = 'none';
});

document.getElementById('save-user-btn').addEventListener('click', async () => {
  const uid = document.getElementById('edit-uid').value;
  const tier = document.getElementById('edit-tier').value;
  const tokens = parseInt(document.getElementById('edit-tokens').value) || 0;
  
  document.getElementById('save-user-btn').textContent = 'Saving...';
  
  await updateDoc(doc(db, 'users', uid), {
    tier: tier,
    tokens: tokens
  });
  
  modal.style.display = 'none';
  document.getElementById('save-user-btn').textContent = 'Save';
  loadUsers();
});
