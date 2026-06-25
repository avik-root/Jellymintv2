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
    // Timeout helper for Firestore hangs
    const withTimeout = (promise, ms) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('FIRESTORE_TIMEOUT')), ms))
    ]);

    let isAdmin = false;
    
    // Normalize both emails for comparison (trim whitespace, lowercase)
    const userEmail = (user.email || '').trim().toLowerCase();
    const superAdminEmail = (SUPER_ADMIN || '').trim().toLowerCase();

    if (userEmail && superAdminEmail && userEmail === superAdminEmail) {
      isAdmin = true;
      // Auto-add super admin to DB with timeout — non-blocking
      try {
        await withTimeout(setDoc(doc(db, 'admins', user.email), {
          addedAt: new Date(),
          role: 'superadmin'
        }, { merge: true }), 5000);
      } catch (dbError) {
        console.warn("Could not write super admin to Firestore (non-fatal):", dbError);
        // Super admin is still allowed in even if DB write fails
      }
    } else {
      try {
        const adminDoc = await withTimeout(getDoc(doc(db, 'admins', user.email)), 5000);
        if (adminDoc.exists()) {
          isAdmin = true;
        }
      } catch (dbError) {
        console.error("Firestore admin check failed:", dbError);
        // If Firestore is down, fall through to denied
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
    if (error.message === 'FIRESTORE_TIMEOUT') {
      loginError.innerHTML = "<strong>Firestore Database not found!</strong><br>You MUST create the Firestore Database in the Firebase Console and then download your `serviceAccountKey.json` into the `backend/` folder before continuing.";
    } else {
      loginError.textContent = "Error verifying admin status: " + error.message;
    }
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
let activityChartInstance = null;
let tiersChartInstance = null;
let apiBaseUrl = '';

async function initDashboard() {
  await loadSettings();
  await loadUsers();
  
  if (apiBaseUrl) {
    fetchSystemStats();
    fetchActiveModel();
    setInterval(fetchSystemStats, 3000);
    setInterval(fetchActiveModel, 10000);
  }
}

async function fetchSystemStats() {
  if (!apiBaseUrl) return;
  try {
    const res = await fetch(apiBaseUrl + '/api/sysinfo', {
      headers: { 'ngrok-skip-browser-warning': 'true' }
    });
    if (res.ok) {
      const data = await res.json();
      document.getElementById('stat-cpu').textContent = `${data.cpu}%`;
      document.getElementById('stat-ram').textContent = `${data.ram}%`;
    }
  } catch (e) {
    // Suppress warning
  }
}

async function fetchActiveModel() {
  if (!apiBaseUrl) return;
  try {
    const res = await fetch(apiBaseUrl + '/api/models', {
      headers: { 'ngrok-skip-browser-warning': 'true' }
    });
    if (res.ok) {
      const data = await res.json();
      const modelName = data.models?.[0]?.name || 'No model loaded';
      document.getElementById('stat-model').textContent = modelName;
    }
  } catch (e) {
    document.getElementById('stat-model').textContent = 'Offline';
  }
}

// Settings
async function loadSettings() {
  const settingsRef = doc(db, 'settings', 'global');
  const snap = await getDoc(settingsRef);
  if (snap.exists()) {
    const data = snap.data();
    apiBaseUrl = data.apiUrl || '';
    document.getElementById('setting-free-for-all').checked = data.freeForAll || false;
    document.getElementById('setting-tunnel-enabled').checked = data.tunnelEnabled !== false;
    document.getElementById('setting-ollama-host').value = data.ollamaHost || 'http://127.0.0.1:11434';
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
    tunnelEnabled: document.getElementById('setting-tunnel-enabled').checked,
    ollamaHost: document.getElementById('setting-ollama-host').value.trim() || 'http://127.0.0.1:11434',
    limits: {
      free: parseInt(document.getElementById('setting-tier-free').value) || 5000,
      pro: parseInt(document.getElementById('setting-tier-pro').value) || 50000,
      advanced: parseInt(document.getElementById('setting-tier-advanced').value) || 1000000
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
  let onlineCount = 0;
  currentUsers = [];
  
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  snap.forEach(docSnap => {
    const data = docSnap.data();
    const uid = docSnap.id;
    currentUsers.push({ uid, ...data });
    
    const tokens = data.tokens || 0;
    totalTokens += tokens;

    // Check if online (active within last 15 minutes)
    let isOnline = false;
    if (data.lastActive) {
      const activeDate = data.lastActive.toDate ? data.lastActive.toDate() : new Date(data.lastActive);
      if (activeDate >= fifteenMinutesAgo) {
        isOnline = true;
        onlineCount++;
      }
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="status-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online' : 'Offline'}"></span>
          <div>
            <div style="font-weight: 600;">${data.name || 'Unknown'}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">${data.email || 'No email'}</div>
          </div>
        </div>
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
        ${data.lastActive ? (data.lastActive.toDate ? data.lastActive.toDate() : new Date(data.lastActive)).toLocaleString() : 'Never'}
      </td>
      <td>
        <button class="action-btn edit-user" data-uid="${uid}">Edit</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('stat-users').textContent = currentUsers.length;
  document.getElementById('stat-online').textContent = onlineCount;
  document.getElementById('stat-tokens').textContent = totalTokens.toLocaleString();

  // Attach edit handlers
  document.querySelectorAll('.edit-user').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const uid = e.target.dataset.uid;
      openEditModal(uid);
    });
  });

  // Render Charts
  updateCharts(currentUsers);
}

function updateCharts(users) {
  updateTiersChart(users);
  updateActivityChart(users);
}

function updateTiersChart(users) {
  const tiers = { free: 0, pro: 0, advanced: 0 };
  users.forEach(u => {
    const tier = (u.tier || 'free').toLowerCase();
    if (tiers[tier] !== undefined) {
      tiers[tier]++;
    } else {
      tiers.free++;
    }
  });

  const canvas = document.getElementById('tiers-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (tiersChartInstance) {
    tiersChartInstance.destroy();
  }

  tiersChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Free', 'PRO', 'Advanced'],
      datasets: [{
        data: [tiers.free, tiers.pro, tiers.advanced],
        backgroundColor: [
          'rgba(255, 255, 255, 0.15)',
          'rgba(59, 130, 246, 0.4)',
          'rgba(20, 184, 166, 0.4)'
        ],
        borderColor: [
          'rgba(255, 255, 255, 0.3)',
          'rgba(59, 130, 246, 0.8)',
          'rgba(20, 184, 166, 0.8)'
        ],
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#94a3b8',
            font: { family: 'Outfit', size: 11 }
          }
        }
      }
    }
  });
}

function updateActivityChart(users) {
  const dates = [];
  const counts = [];
  
  // Create last 7 days labels and count active users
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    
    const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    
    let activeCount = 0;
    users.forEach(u => {
      if (u.lastActive) {
        const activeDate = u.lastActive.toDate ? u.lastActive.toDate() : new Date(u.lastActive);
        if (activeDate >= startOfDay && activeDate <= endOfDay) {
          activeCount++;
        }
      }
    });
    counts.push(activeCount);
  }

  const canvas = document.getElementById('activity-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (activityChartInstance) {
    activityChartInstance.destroy();
  }

  activityChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        label: 'Active Users',
        data: counts,
        borderColor: '#14b8a6',
        backgroundColor: 'rgba(20, 184, 166, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#94a3b8',
            font: { family: 'Outfit' },
            stepSize: 1,
            precision: 0
          }
        },
        x: {
          grid: { display: false },
          ticks: {
            color: '#94a3b8',
            font: { family: 'Outfit' }
          }
        }
      }
    }
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
