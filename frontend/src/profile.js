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

    // Listen for real-time Firestore user data
    unsubscribeUser = onSnapshot(doc(db, 'users', user.uid), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();

        // Token balance
        const tokens = data.tokens || 0;
        document.getElementById('stat-tokens').textContent = tokens.toLocaleString();

        // Tier
        const tier = data.tier || 'free';
        document.getElementById('stat-tier').textContent = tier.toUpperCase();
        
        const tierBadge = document.getElementById('info-tier-badge');
        tierBadge.textContent = tier.toUpperCase();
        tierBadge.className = `tier-badge ${tier}`;

        // Last active
        if (data.lastActive) {
          try {
            const lastActiveDate = data.lastActive.toDate();
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
        document.getElementById('stat-tokens').textContent = '0';
        document.getElementById('stat-tier').textContent = 'FREE';
        document.getElementById('info-tier-badge').textContent = 'FREE';
        document.getElementById('info-tier-badge').className = 'tier-badge free';
        document.getElementById('info-last-active').textContent = 'Never';
      }
    }, (error) => {
      console.error('Error listening to user document:', error);
    });
  });

  // Sign out
  signOutBtn.addEventListener('click', async () => {
    try {
      if (unsubscribeUser) unsubscribeUser();
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
