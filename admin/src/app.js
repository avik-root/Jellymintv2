import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, query, orderBy, limit } from './firebase.js';
import { Renderer, Triangle, Program, Mesh } from 'ogl';

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
let cleanupPrism = null;

// User Search listener
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('user-search-input');
  const searchBtn = document.getElementById('user-search-btn');
  if (searchInput && searchBtn) {
    const performSearch = () => {
      const queryStr = (searchInput.value || '').trim().toLowerCase();
      if (!queryStr) {
        renderUsersTable(currentUsers);
        return;
      }
      const filtered = currentUsers.filter(u => 
        (u.name || '').toLowerCase().includes(queryStr) || 
        (u.email || '').toLowerCase().includes(queryStr)
      );
      renderUsersTable(filtered);
    };
    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('input', performSearch);
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showScreen(loginScreen);
    if (!cleanupPrism) {
      const container = document.getElementById('prism-bg');
      if (container) {
        try {
          cleanupPrism = initPrism(container);
        } catch (e) {
          console.error("Failed to init WebGL on admin login:", e);
        }
      }
    }
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
        await withTimeout(setDoc(doc(db, 'admins', userEmail), {
          addedAt: new Date(),
          role: 'superadmin'
        }, { merge: true }), 5000);
      } catch (dbError) {
        console.warn("Could not write super admin to Firestore (non-fatal):", dbError);
        // Super admin is still allowed in even if DB write fails
      }
    } else {
      try {
        const adminDoc = await withTimeout(getDoc(doc(db, 'admins', userEmail)), 5000);
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

  if (screen !== loginScreen && cleanupPrism) {
    try {
      cleanupPrism();
    } catch (e) {
      console.warn("Error cleaning up WebGL prism:", e);
    }
    cleanupPrism = null;
  }
}

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    e.currentTarget.classList.add('active');
    
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    
    const target = e.currentTarget.dataset.target;
    const targetView = document.getElementById('view-' + target);
    if (targetView) {
      targetView.classList.add('active');
    }
    
    // Refresh/resize charts to prevent Chart.js 0-size collapse when container was hidden
    if (target === 'tokens-chart') {
      updateTokenUsageChart();
    } else if (target === 'analytics') {
      if (currentUsers && currentUsers.length > 0) {
        updateCharts(currentUsers);
      }
    } else if (target === 'monitor') {
      if (cpuChartInstance) cpuChartInstance.resize();
      if (ramChartInstance) ramChartInstance.resize();
      if (gpuChartInstance) gpuChartInstance.resize();
    }
  });
});

// --- Dashboard Logic ---
let activityChartInstance = null;
let tiersChartInstance = null;
let cpuChartInstance = null;
let ramChartInstance = null;
let gpuChartInstance = null;
let tokenUsageChartInstance = null;
let apiBaseUrl = '';

// Live system info datasets
const maxDataPoints = 15;
const sysLabels = Array(maxDataPoints).fill('');
const cpuData = Array(maxDataPoints).fill(0);
const ramData = Array(maxDataPoints).fill(0);
const gpuData = Array(maxDataPoints).fill(0);

function createSparkline(canvasId, label, data, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: sysLabels,
      datasets: [{
        label: label,
        data: data,
        borderColor: color,
        backgroundColor: color.replace('1)', '0.05)'),
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (context) => ` ${context.dataset.label}: ${context.raw}%`
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: {
            color: '#64748b',
            font: { family: 'Outfit', size: 9 },
            callback: value => value + '%'
          }
        },
        x: {
          grid: { display: false },
          ticks: { display: false }
        }
      }
    }
  });
}

function initSysinfoCharts() {
  cpuChartInstance = createSparkline('cpu-chart', 'CPU Usage', cpuData, 'rgba(16, 185, 129, 1)');
  ramChartInstance = createSparkline('ram-chart', 'RAM Usage', ramData, 'rgba(6, 182, 212, 1)');
  gpuChartInstance = createSparkline('gpu-chart', 'GPU Usage', gpuData, 'rgba(139, 92, 246, 1)');
}

async function updateTokenUsageChart() {
  const canvas = document.getElementById('token-usage-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  try {
    const usageRef = collection(db, 'token_usage');
    const q = query(usageRef, orderBy('date', 'desc'), limit(7));
    const snap = await getDocs(q);
    
    const dates = [];
    const tokensUsed = [];
    
    snap.forEach(docSnap => {
      const data = docSnap.data();
      dates.push(data.date || docSnap.id);
      tokensUsed.push(data.totalTokensUsed || 0);
    });
    
    dates.reverse();
    tokensUsed.reverse();
    
    const formattedDates = dates.map(d => {
      try {
        const dateObj = new Date(d);
        return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      } catch (e) {
        return d;
      }
    });
    
    if (tokenUsageChartInstance) {
      tokenUsageChartInstance.destroy();
    }
    
    tokenUsageChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: formattedDates,
        datasets: [{
          label: 'Tokens Used',
          data: tokensUsed,
          backgroundColor: 'rgba(20, 184, 166, 0.4)',
          borderColor: 'rgba(20, 184, 166, 0.8)',
          borderWidth: 1.5,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => ` Total Tokens: ${context.raw.toLocaleString()}`
            }
          }
        },
        scales: {
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: {
              color: '#94a3b8',
              font: { family: 'Outfit' },
              callback: value => value.toLocaleString()
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
  } catch (error) {
    console.error("Failed to load daily token usage:", error);
  }
}

async function initDashboard() {
  await loadSettings();
  await loadUsers();
  initSysinfoCharts();
  updateTokenUsageChart();
  
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
      
      const gpuStatEl = document.getElementById('stat-gpu');
      if (gpuStatEl) gpuStatEl.textContent = `${data.gpu}%`;
      
      // Update datasets
      cpuData.push(data.cpu || 0);
      cpuData.shift();
      ramData.push(data.ram || 0);
      ramData.shift();
      gpuData.push(data.gpu || 0);
      gpuData.shift();
      
      if (cpuChartInstance) cpuChartInstance.update('none');
      if (ramChartInstance) ramChartInstance.update('none');
      if (gpuChartInstance) gpuChartInstance.update('none');
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
  let defaultModelVal = '';
  
  if (snap.exists()) {
    const data = snap.data();
    apiBaseUrl = data.apiUrl || '';
    defaultModelVal = data.defaultModel || '';
    document.getElementById('setting-free-for-all').checked = data.freeForAll || false;
    document.getElementById('setting-tunnel-enabled').checked = data.tunnelEnabled !== false;
    document.getElementById('setting-maintenance-mode').checked = data.maintenanceMode || false;
    document.getElementById('setting-coming-soon-mode').checked = data.comingSoonMode || false;
    document.getElementById('setting-ollama-host').value = data.ollamaHost || 'http://127.0.0.1:11434';
    document.getElementById('setting-tier-free').value = data.limits?.free || 5000;
    document.getElementById('setting-tier-pro').value = data.limits?.pro || 50000;
    document.getElementById('setting-tier-advanced').value = data.limits?.advanced || 1000000;
  }

  // Populate dynamic model dropdown
  if (apiBaseUrl) {
    try {
      const res = await fetch(apiBaseUrl + '/api/models', {
        headers: { 'ngrok-skip-browser-warning': 'true' }
      });
      if (res.ok) {
        const data = await res.json();
        const select = document.getElementById('setting-default-model');
        if (select) {
          select.innerHTML = '<option value="">(Automatic / qwen)</option>';
          if (data.models && data.models.length > 0) {
            data.models.forEach(m => {
              const opt = document.createElement('option');
              opt.value = m.name;
              opt.textContent = m.name;
              select.appendChild(opt);
            });
          }
          select.value = defaultModelVal;
        }
      }
    } catch (e) {
      console.warn("Could not fetch models for settings:", e);
    }
  }
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-settings-btn');
  btn.textContent = 'Saving...';
  
  const settings = {
    freeForAll: document.getElementById('setting-free-for-all').checked,
    tunnelEnabled: document.getElementById('setting-tunnel-enabled').checked,
    maintenanceMode: document.getElementById('setting-maintenance-mode').checked,
    comingSoonMode: document.getElementById('setting-coming-soon-mode').checked,
    ollamaHost: document.getElementById('setting-ollama-host').value.trim() || 'http://127.0.0.1:11434',
    defaultModel: document.getElementById('setting-default-model').value || '',
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
  
  let totalTokens = 0;
  let onlineCount = 0;
  currentUsers = [];
  
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  snap.forEach(docSnap => {
    const data = docSnap.data();
    const uid = docSnap.id;
    currentUsers.push({ uid, ...data });
    
    totalTokens += data.tokens || 0;

    // Check if online (active within last 15 minutes)
    if (data.lastActive) {
      const activeDate = data.lastActive.toDate ? data.lastActive.toDate() : new Date(data.lastActive);
      if (activeDate >= fifteenMinutesAgo) {
        onlineCount++;
      }
    }
  });

  document.getElementById('stat-users').textContent = currentUsers.length;
  document.getElementById('stat-online').textContent = onlineCount;
  document.getElementById('stat-tokens').textContent = totalTokens.toLocaleString();

  // Draw users table
  renderUsersTable(currentUsers);

  // Render Charts
  updateCharts(currentUsers);
}

function renderUsersTable(usersToRender) {
  const tbody = document.getElementById('users-table-body');
  tbody.innerHTML = '';
  
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  usersToRender.forEach(user => {
    const tokens = user.tokens || 0;
    const isBanned = user.banned === true;
    
    // Check if online (active within last 15 minutes)
    let isOnline = false;
    if (user.lastActive) {
      const activeDate = user.lastActive.toDate ? user.lastActive.toDate() : new Date(user.lastActive);
      if (activeDate >= fifteenMinutesAgo) {
        isOnline = true;
      }
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="status-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online' : 'Offline'}"></span>
          <div>
            <div style="font-weight: 600; display: flex; align-items: center; gap: 6px;">
              ${user.name || 'Unknown'}
              ${isBanned ? '<span style="font-size: 0.72rem; background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(239,68,68,0.3); font-weight: 500;"><i class="fa-solid fa-user-slash"></i> Banned</span>' : ''}
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">${user.email || 'No email'}</div>
          </div>
        </div>
      </td>
      <td>
        <div>${user.ip || 'Unknown IP'}</div>
      </td>
      <td>
        <span class="badge ${user.tier || 'free'}">${(user.tier || 'free').toUpperCase()}</span>
      </td>
      <td style="font-family: monospace; font-weight: bold;">
        ${tokens.toLocaleString()}
      </td>
      <td>
        ${user.lastActive ? (user.lastActive.toDate ? user.lastActive.toDate() : new Date(user.lastActive)).toLocaleString() : 'Never'}
      </td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="action-btn edit-user" data-uid="${user.uid}">Edit</button>
          <button class="action-btn ${isBanned ? 'unban-user' : 'ban-user'}" data-uid="${user.uid}" style="background: ${isBanned ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}; color: ${isBanned ? '#10b981' : '#f43f5e'}; border: 1px solid ${isBanned ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}; padding: 6px 12px; font-size: 0.85rem; cursor: pointer;">
            ${isBanned ? 'Unban' : 'Ban'}
          </button>
          <button class="action-btn delete-user-btn" data-uid="${user.uid}" style="background: rgba(239, 68, 68, 0.25); color: #f43f5e; border: 1px solid rgba(239, 68, 68, 0.4); padding: 6px 12px; font-size: 0.85rem; cursor: pointer;">
            Delete
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Attach click listeners for actions
  document.querySelectorAll('.edit-user').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const uid = e.target.closest('.edit-user').dataset.uid;
      openEditModal(uid);
    });
  });

  document.querySelectorAll('.ban-user').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const uid = e.target.closest('.ban-user').dataset.uid;
      const user = currentUsers.find(u => u.uid === uid);
      if (confirm(`Are you sure you want to BAN ${user?.name || 'this user'}? They will be locked out of the AI chat service immediately.`)) {
        try {
          await updateDoc(doc(db, 'users', uid), { banned: true });
          await loadUsers();
        } catch (err) {
          alert('Error banning user: ' + err.message);
        }
      }
    });
  });

  document.querySelectorAll('.unban-user').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const uid = e.target.closest('.unban-user').dataset.uid;
      const user = currentUsers.find(u => u.uid === uid);
      if (confirm(`Are you sure you want to UNBAN ${user?.name || 'this user'}?`)) {
        try {
          await updateDoc(doc(db, 'users', uid), { banned: false });
          await loadUsers();
        } catch (err) {
          alert('Error unbanning user: ' + err.message);
        }
      }
    });
  });

  document.querySelectorAll('.delete-user-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const uid = e.target.closest('.delete-user-btn').dataset.uid;
      const user = currentUsers.find(u => u.uid === uid);
      if (confirm(`Are you sure you want to DELETE ${user?.name || 'this user'} permanently? This will erase their tokens and cannot be undone.`)) {
        try {
          await deleteDoc(doc(db, 'users', uid));
          await loadUsers();
        } catch (err) {
          alert('Error deleting user: ' + err.message);
        }
      }
    });
  });
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
    tokens: tokens,
    lastActive: new Date() // Reset lastActive to now to prevent 24h reset overrides
  });
  
  modal.style.display = 'none';
  document.getElementById('save-user-btn').textContent = 'Save';
  loadUsers();
});

// WebGL Prism shader implementation using OGL
function initPrism(container) {
  const height = 3.5;
  const baseWidth = 5.5;
  const animationType = 'rotate';
  const glow = 1;
  const offset = { x: 0, y: 0 };
  const noise = 0;
  const transparent = true;
  const scale = 3.6;
  const hueShift = 0;
  const colorFrequency = 1;
  const hoverStrength = 2;
  const inertia = 0.05;
  const bloom = 1;
  const suspendWhenOffscreen = false;
  const timeScale = 0.5;

  const H = Math.max(0.001, height);
  const BW = Math.max(0.001, baseWidth);
  const BASE_HALF = BW * 0.5;
  const GLOW = Math.max(0.0, glow);
  const NOISE = Math.max(0.0, noise);
  const offX = offset?.x ?? 0;
  const offY = offset?.y ?? 0;
  const SAT = transparent ? 1.5 : 1;
  const SCALE = Math.max(0.001, scale);
  const HUE = hueShift || 0;
  const CFREQ = Math.max(0.0, colorFrequency || 1);
  const BLOOM = Math.max(0.0, bloom || 1);
  const RSX = 1;
  const RSY = 1;
  const RSZ = 1;
  const TS = Math.max(0, timeScale || 1);
  const HOVSTR = Math.max(0, hoverStrength || 1);
  const INERT = Math.max(0, Math.min(1, inertia || 0.12));

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const renderer = new Renderer({
    dpr,
    alpha: transparent,
    antialias: false
  });
  const gl = renderer.gl;
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);

  Object.assign(gl.canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    zIndex: '0'
  });
  container.appendChild(gl.canvas);

  const vertex = /* glsl */ `
    attribute vec2 position;
    void main() {
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

  const fragment = /* glsl */ `
    precision highp float;

    uniform vec2  iResolution;
    uniform float iTime;

    uniform float uHeight;
    uniform float uBaseHalf;
    uniform mat3  uRot;
    uniform int   uUseBaseWobble;
    uniform float uGlow;
    uniform vec2  uOffsetPx;
    uniform float uNoise;
    uniform float uSaturation;
    uniform float uScale;
    uniform float uHueShift;
    uniform float uColorFreq;
    uniform float uBloom;
    uniform float uCenterShift;
    uniform float uInvBaseHalf;
    uniform float uInvHeight;
    uniform float uMinAxis;
    uniform float uPxScale;
    uniform float uTimeScale;

    vec4 tanh4(vec4 x){
      vec4 e2x = exp(2.0*x);
      return (e2x - 1.0) / (e2x + 1.0);
    }

    float rand(vec2 co){
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    float sdOctaAnisoInv(vec3 p){
      vec3 q = vec3(abs(p.x) * uInvBaseHalf, abs(p.y) * uInvHeight, abs(p.z) * uInvBaseHalf);
      float m = q.x + q.y + q.z - 1.0;
      return m * uMinAxis * 0.5773502691896258;
    }

    float sdPyramidUpInv(vec3 p){
      float oct = sdOctaAnisoInv(p);
      float halfSpace = -p.y;
      return max(oct, halfSpace);
    }

    mat3 hueRotation(float a){
      float c = cos(a), s = sin(a);
      mat3 W = mat3(
        0.299, 0.587, 0.114,
        0.299, 0.587, 0.114,
        0.299, 0.587, 0.114
      );
      mat3 U = mat3(
         0.701, -0.587, -0.114,
        -0.299,  0.413, -0.114,
        -0.300, -0.588,  0.886
      );
      mat3 V = mat3(
         0.168, -0.331,  0.500,
         0.328,  0.035, -0.500,
        -0.497,  0.296,  0.201
      );
      return W + U * c + V * s;
    }

    void main(){
      vec2 f = (gl_FragCoord.xy - 0.5 * iResolution.xy - uOffsetPx) * uPxScale;

      float z = 5.0;
      float d = 0.0;

      vec3 p;
      vec4 o = vec4(0.0);

      float centerShift = uCenterShift;
      float cf = uColorFreq;

      mat2 wob = mat2(1.0);
      if (uUseBaseWobble == 1) {
        float t = iTime * uTimeScale;
        float c0 = cos(t + 0.0);
        float c1 = cos(t + 33.0);
        float c2 = cos(t + 11.0);
        wob = mat2(c0, c1, c2, c0);
      }

      const int STEPS = 100;
      for (int i = 0; i < STEPS; i++) {
        p = vec3(f, z);
        p.xz = p.xz * wob;
        p = uRot * p;
        vec3 q = p;
        q.y += centerShift;
        d = 0.1 + 0.2 * abs(sdPyramidUpInv(q));
        z -= d;
        o += (sin((p.y + z) * cf + vec4(0.0, 1.0, 2.0, 3.0)) + 1.0) / d;
      }

      o = tanh4(o * o * (uGlow * uBloom) / 1e5);

      vec3 col = o.rgb;
      float n = rand(gl_FragCoord.xy + vec2(iTime));
      col += (n - 0.5) * uNoise;
      col = clamp(col, 0.0, 1.0);

      float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = clamp(mix(vec3(L), col, uSaturation), 0.0, 1.0);

      if(abs(uHueShift) > 0.0001){
        col = clamp(hueRotation(uHueShift) * col, 0.0, 1.0);
      }

      gl_FragColor = vec4(col, o.a);
    }
  `;

  const geometry = new Triangle(gl);
  const iResBuf = new Float32Array(2);
  const offsetPxBuf = new Float32Array(2);

  const program = new Program(gl, {
    vertex,
    fragment,
    uniforms: {
      iResolution: { value: iResBuf },
      iTime: { value: 0 },
      uHeight: { value: H },
      uBaseHalf: { value: BASE_HALF },
      uUseBaseWobble: { value: 1 },
      uRot: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      uGlow: { value: GLOW },
      uOffsetPx: { value: offsetPxBuf },
      uNoise: { value: NOISE },
      uSaturation: { value: SAT },
      uScale: { value: SCALE },
      uHueShift: { value: HUE },
      uColorFreq: { value: CFREQ },
      uBloom: { value: BLOOM },
      uCenterShift: { value: H * 0.25 },
      uInvBaseHalf: { value: 1 / BASE_HALF },
      uInvHeight: { value: 1 / H },
      uMinAxis: { value: Math.min(BASE_HALF, H) },
      uPxScale: {
        value: 1 / ((gl.drawingBufferHeight || 1) * 0.1 * SCALE)
      },
      uTimeScale: { value: TS }
    }
  });
  const mesh = new Mesh(gl, { geometry, program });

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h);
    iResBuf[0] = gl.drawingBufferWidth;
    iResBuf[1] = gl.drawingBufferHeight;
    offsetPxBuf[0] = offX * dpr;
    offsetPxBuf[1] = offY * dpr;
    program.uniforms.uPxScale.value = 1 / ((gl.drawingBufferHeight || 1) * 0.1 * SCALE);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const rotBuf = new Float32Array(9);
  const setMat3FromEuler = (yawY, pitchX, rollZ, out) => {
    const cy = Math.cos(yawY), sy = Math.sin(yawY);
    const cx = Math.cos(pitchX), sx = Math.sin(pitchX);
    const cz = Math.cos(rollZ), sz = Math.sin(rollZ);
    const r00 = cy * cz + sy * sx * sz;
    const r01 = -cy * sz + sy * sx * cz;
    const r02 = sy * cx;

    const r10 = cx * sz;
    const r11 = cx * cz;
    const r12 = -sx;

    const r20 = -sy * cz + cy * sx * sz;
    const r21 = sy * sz + cy * sx * cz;
    const r22 = cy * cx;

    out[0] = r00; out[1] = r10; out[2] = r20;
    out[3] = r01; out[4] = r11; out[5] = r21;
    out[6] = r02; out[7] = r12; out[8] = r22;
    return out;
  };

  const NOISE_IS_ZERO = NOISE < 1e-6;
  let raf = 0;
  const t0 = performance.now();
  const startRAF = () => {
    if (raf) return;
    raf = requestAnimationFrame(render);
  };
  const stopRAF = () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const rnd = () => Math.random();
  const wX = (0.3 + rnd() * 0.6) * RSX;
  const wY = (0.2 + rnd() * 0.7) * RSY;
  const wZ = (0.1 + rnd() * 0.5) * RSZ;
  const phX = rnd() * Math.PI * 2;
  const phZ = rnd() * Math.PI * 2;

  let yaw = 0, pitch = 0, roll = 0;
  let targetYaw = 0, targetPitch = 0;
  const lerp = (a, b, t) => a + (b - a) * t;

  const pointer = { x: 0, y: 0, inside: true };
  const onMove = e => {
    const ww = Math.max(1, window.innerWidth);
    const wh = Math.max(1, window.innerHeight);
    const cx = ww * 0.5;
    const cy = wh * 0.5;
    const nx = (e.clientX - cx) / (ww * 0.5);
    const ny = (e.clientY - cy) / (wh * 0.5);
    pointer.x = Math.max(-1, Math.min(1, nx));
    pointer.y = Math.max(-1, Math.min(1, ny));
    pointer.inside = true;
  };
  const onLeave = () => { pointer.inside = false; };
  const onBlur = () => { pointer.inside = false; };

  let onPointerMove = null;
  if (animationType === 'hover') {
    onPointerMove = e => {
      onMove(e);
      startRAF();
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('mouseleave', onLeave);
    window.addEventListener('blur', onBlur);
    program.uniforms.uUseBaseWobble.value = 0;
  } else if (animationType === '3drotate') {
    program.uniforms.uUseBaseWobble.value = 0;
  } else {
    program.uniforms.uUseBaseWobble.value = 1;
  }

  const render = t => {
    const time = (t - t0) * 0.001;
    program.uniforms.iTime.value = time;

    let continueRAF = true;

    if (animationType === 'hover') {
      const maxPitch = 0.6 * HOVSTR;
      const maxYaw = 0.6 * HOVSTR;
      targetYaw = (pointer.inside ? -pointer.x : 0) * maxYaw;
      targetPitch = (pointer.inside ? pointer.y : 0) * maxPitch;
      const prevYaw = yaw;
      const prevPitch = pitch;
      const prevRoll = roll;
      yaw = lerp(prevYaw, targetYaw, INERT);
      pitch = lerp(prevPitch, targetPitch, INERT);
      roll = lerp(prevRoll, 0, 0.1);
      program.uniforms.uRot.value = setMat3FromEuler(yaw, pitch, roll, rotBuf);

      if (NOISE_IS_ZERO) {
        const settled = Math.abs(yaw - targetYaw) < 1e-4 && Math.abs(pitch - targetPitch) < 1e-4 && Math.abs(roll) < 1e-4;
        if (settled) continueRAF = false;
      }
    } else if (animationType === '3drotate') {
      const tScaled = time * TS;
      yaw = tScaled * wY;
      pitch = Math.sin(tScaled * wX + phX) * 0.6;
      roll = Math.sin(tScaled * wZ + phZ) * 0.5;
      program.uniforms.uRot.value = setMat3FromEuler(yaw, pitch, roll, rotBuf);
      if (TS < 1e-6) continueRAF = false;
    } else {
      // rotate mode (base wobble)
      rotBuf[0] = 1;
      rotBuf[1] = 0;
      rotBuf[2] = 0;
      rotBuf[3] = 0;
      rotBuf[4] = 1;
      rotBuf[5] = 0;
      rotBuf[6] = 0;
      rotBuf[7] = 0;
      rotBuf[8] = 1;
      program.uniforms.uRot.value = rotBuf;
      if (TS < 1e-6) continueRAF = false;
    }

    renderer.render({ scene: mesh });
    if (continueRAF) {
      raf = requestAnimationFrame(render);
    } else {
      raf = 0;
    }
  };

  if (suspendWhenOffscreen) {
    const io = new IntersectionObserver(entries => {
      const vis = entries.some(e => e.isIntersecting);
      if (vis) startRAF();
      else stopRAF();
    });
    io.observe(container);
    startRAF();
    container.__prismIO = io;
  } else {
    startRAF();
  }

  return () => {
    stopRAF();
    ro.disconnect();
    if (animationType === 'hover') {
      if (onPointerMove) window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('blur', onBlur);
    }
    if (suspendWhenOffscreen) {
      const io = container.__prismIO;
      if (io) io.disconnect();
      delete container.__prismIO;
    }
    if (gl.canvas.parentElement === container) container.removeChild(gl.canvas);
  };
}
