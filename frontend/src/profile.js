import { auth, db, signOut, onAuthStateChanged, doc, getDoc, onSnapshot } from './firebase.js';

document.addEventListener('DOMContentLoaded', () => {
  const profileLoading = document.getElementById('profile-loading');
  const profileContent = document.getElementById('profile-content');
  const signOutBtn = document.getElementById('sign-out-btn');
  const backToChatBtn = document.getElementById('back-to-chat-btn');

  let unsubscribeUser = null;

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = '/login/';
      return;
    }

    // Populate Firebase Auth data immediately
    document.getElementById('profile-name').textContent = user.displayName || 'User';
    document.getElementById('profile-email').textContent = user.email || 'No email';
    document.getElementById('info-email').textContent = user.email || 'No email';
    document.getElementById('info-uid').textContent = user.uid;
    document.getElementById('info-created').textContent = user.metadata.creationTime 
      ? new Date(user.metadata.creationTime).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '--';

    // Set avatar
    const avatarEl = document.getElementById('profile-avatar');
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${user.photoURL}" alt="${user.displayName || 'User'}" referrerpolicy="no-referrer">`;
    } else {
      const initials = (user.displayName || user.email || 'U').charAt(0).toUpperCase();
      avatarEl.innerHTML = `<span class="avatar-fallback" style="font-size: 2.5rem; color: var(--primary-mint);">${initials}</span>`;
    }

    // Show content, hide loading
    profileLoading.style.display = 'none';
    profileContent.style.display = 'block';

    let limits = { free: 5000, pro: 50000, advanced: 1000000 };
    let freeForAll = false;
    let userData = null;

    function updateUserUI() {
      if (!userData) return;

      const tokens = userData.tokens || 0;
      document.getElementById('stat-tokens').textContent = tokens.toLocaleString();

      const tier = userData.tier || 'free';
      document.getElementById('stat-tier').textContent = tier.toUpperCase();
      
      const tierBadge = document.getElementById('info-tier-badge');
      tierBadge.textContent = tier.toUpperCase();
      tierBadge.className = `tier-badge ${tier}`;

      // Update progress bar
      const tokenUsageContainer = document.getElementById('token-usage-container');
      if (freeForAll) {
        tokenUsageContainer.style.display = 'block';
        document.getElementById('token-percentage').textContent = 'Unlimited';
        document.getElementById('token-percentage').style.color = '#10b981';
        document.getElementById('token-progress-bar').style.width = '100%';
        document.getElementById('token-progress-bar').style.background = 'linear-gradient(90deg, var(--accent-cyan), var(--primary-mint))';
        document.getElementById('token-used-text').textContent = `Remaining: Unlimited`;
        document.getElementById('token-limit-text').textContent = `Allowance: Unlimited`;
      } else {
        tokenUsageContainer.style.display = 'block';
        const limit = limits[tier] || 5000;
        const pct = Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
        
        document.getElementById('token-percentage').textContent = `${pct}% Remaining`;
        if (pct < 15) {
          document.getElementById('token-percentage').style.color = '#ef4444';
          document.getElementById('token-progress-bar').style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
        } else {
          document.getElementById('token-percentage').style.color = 'var(--primary-mint)';
          document.getElementById('token-progress-bar').style.background = 'linear-gradient(90deg, var(--accent-cyan), var(--primary-mint))';
        }
        
        document.getElementById('token-progress-bar').style.width = `${pct}%`;
        document.getElementById('token-used-text').textContent = `Remaining: ${tokens.toLocaleString()} tokens`;
        document.getElementById('token-limit-text').textContent = `Allowance: ${limit.toLocaleString()} tokens`;
      }
    }

    // Listen to global settings in real-time
    const unsubscribeSettings = onSnapshot(doc(db, 'settings', 'global'), (settingsSnap) => {
      if (settingsSnap.exists()) {
        const sData = settingsSnap.data();
        if (sData.limits) limits = { ...limits, ...sData.limits };
        freeForAll = !!sData.freeForAll;
      }
      updateUserUI();
    });

    // Listen for real-time Firestore user data
    unsubscribeUser = onSnapshot(doc(db, 'users', user.uid), (docSnap) => {
      if (docSnap.exists()) {
        userData = docSnap.data();
        updateUserUI();

        // Last active
        if (userData.lastActive) {
          try {
            const lastActiveDate = userData.lastActive.toDate();
            document.getElementById('info-last-active').textContent = lastActiveDate.toLocaleDateString('en-US', {
              year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
          } catch (e) {
            document.getElementById('info-last-active').textContent = '--';
          }
        } else {
          document.getElementById('info-last-active').textContent = '--';
        }
      } else {
        // User doc doesn't exist yet (new user who hasn't chatted)
        userData = { tokens: 5000, tier: 'free' };
        updateUserUI();
        document.getElementById('info-last-active').textContent = 'Never';
      }
    }, (error) => {
      console.error('Error listening to user document:', error);
    });

    // Sign out
    signOutBtn.addEventListener('click', async () => {
      try {
        if (unsubscribeUser) unsubscribeUser();
        if (unsubscribeSettings) unsubscribeSettings();
        await signOut(auth);
        window.location.href = '/login/';
      } catch (error) {
        console.error('Error signing out:', error);
      }
    });

    // Back to chat
    backToChatBtn.addEventListener('click', () => {
      window.location.href = '/chat/';
    });
  });
});
