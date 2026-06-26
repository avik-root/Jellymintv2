import { auth, db, signOut, onAuthStateChanged, doc, setDoc, onSnapshot, getDoc, serverTimestamp } from './firebase.js';

document.addEventListener('DOMContentLoaded', () => {
  const portalLoading = document.getElementById('portal-loading');
  const portalUi = document.getElementById('portal-ui');

  const profileName = document.getElementById('profile-name');
  const profileEmail = document.getElementById('profile-email');
  const infoEmail = document.getElementById('info-email');
  const infoUid = document.getElementById('info-uid');
  const infoCreated = document.getElementById('info-created');
  const profileAvatar = document.getElementById('profile-avatar');

  const backToChatBtn = document.getElementById('back-to-chat-btn');
  const signOutBtn = document.getElementById('sign-out-btn');

  let unsubscribeUser = null;
  let unsubscribeSettings = null;

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = '/login/';
      return;
    }

    // Ensure user document exists in Firestore with all required fields
    const userRef = doc(db, 'users', user.uid);
    try {
      const docSnap = await getDoc(userRef);
      if (!docSnap.exists() || !docSnap.data().email) {
        const existingData = docSnap.exists() ? docSnap.data() : {};
        await setDoc(userRef, {
          name: existingData.name || user.displayName || '',
          email: existingData.email || user.email || '',
          photoURL: existingData.photoURL || user.photoURL || '',
          tokens: (existingData.tokens !== undefined && existingData.tokens !== null) ? existingData.tokens : 5000,
          tier: existingData.tier || 'free',
          createdAt: existingData.createdAt || serverTimestamp(),
          lastActive: serverTimestamp(),
          ip: existingData.ip || 'unknown'
        });
        console.log("[Jellymint] User document created/repaired from profile page");
      } else {
        await setDoc(userRef, { lastActive: serverTimestamp() }, { merge: true });
      }
    } catch (err) {
      console.error("[Jellymint] Profile: Error initializing user doc, attempting fallback:", err);
      try {
        await setDoc(userRef, {
          name: user.displayName || '',
          email: user.email || '',
          photoURL: user.photoURL || '',
          tokens: 5000,
          tier: 'free',
          createdAt: serverTimestamp(),
          lastActive: serverTimestamp(),
          ip: 'unknown'
        }, { merge: true });
        console.log("[Jellymint] Profile: Fallback user document written");
      } catch (fallbackErr) {
        console.error("[Jellymint] Profile: CRITICAL - all write attempts failed:", fallbackErr);
      }
    }

    // Populate profile sidebar
    profileName.textContent = user.displayName || 'User';
    profileEmail.textContent = user.email || 'No email';
    infoEmail.textContent = user.email || 'No email';
    infoUid.textContent = user.uid;
    infoCreated.textContent = user.metadata.creationTime 
      ? new Date(user.metadata.creationTime).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '--';

    // Set avatar
    if (user.photoURL) {
      profileAvatar.innerHTML = `<img src="${user.photoURL}" alt="${user.displayName || 'User'}" referrerpolicy="no-referrer">`;
    } else {
      const initials = (user.displayName || user.email || 'U').charAt(0).toUpperCase();
      profileAvatar.innerHTML = `<span class="avatar-fallback" style="font-size: 2.2rem; color: var(--primary-mint);">${initials}</span>`;
    }

    // Tab Navigation Logic
    const navItems = document.querySelectorAll('.nav-item');
    const views = document.querySelectorAll('.portal-view');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        navItems.forEach(n => n.classList.remove('active'));
        item.classList.add('active');

        views.forEach(v => v.classList.remove('active'));
        const targetView = document.getElementById(`view-${item.dataset.target}`);
        if (targetView) targetView.classList.add('active');
      });
    });

    let limits = { free: 5000, pro: 50000, advanced: 1000000 };
    let freeForAll = false;
    let userData = null;
    let apiUrl = 'https://spousal-scrabble-stamina.ngrok-free.dev';

    function updateUserUI() {
      if (!userData) return;

      const tokens = userData.tokens || 0;
      const tier = userData.tier || 'free';

      // Update Quick Stats & Details
      document.getElementById('mini-stat-tokens').textContent = tokens.toLocaleString();
      document.getElementById('mini-stat-tier').textContent = tier.toUpperCase();
      
      const badge = document.getElementById('info-tier-badge');
      if (badge) {
        badge.textContent = tier.toUpperCase();
        badge.className = `tier-badge ${tier}`;
      }

      // Update Token Progress Bar
      const tokenUsageContainer = document.getElementById('token-usage-container');
      const tokenPercentage = document.getElementById('token-percentage');
      const tokenProgressBar = document.getElementById('token-progress-bar');
      const tokenUsedText = document.getElementById('token-used-text');
      const tokenLimitText = document.getElementById('token-limit-text');

      if (tokenUsageContainer && tokenPercentage && tokenProgressBar && tokenUsedText && tokenLimitText) {
        if (freeForAll) {
          tokenPercentage.textContent = 'Unlimited';
          tokenPercentage.style.color = '#10b981';
          tokenPercentage.style.background = 'rgba(16, 185, 129, 0.1)';
          tokenProgressBar.style.width = '100%';
          tokenProgressBar.style.background = 'linear-gradient(90deg, var(--accent-cyan), var(--primary-mint))';
          tokenUsedText.textContent = 'Remaining: Unlimited';
          tokenLimitText.textContent = 'Allowance: Unlimited';
        } else {
          const limit = limits[tier] || 5000;
          const pct = Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
          
          tokenPercentage.textContent = `${pct}% Remaining`;
          if (pct < 15) {
            tokenPercentage.style.color = '#ef4444';
            tokenPercentage.style.background = 'rgba(239, 68, 68, 0.1)';
            tokenProgressBar.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
          } else {
            tokenPercentage.style.color = 'var(--primary-mint)';
            tokenPercentage.style.background = 'rgba(20, 184, 166, 0.1)';
            tokenProgressBar.style.background = 'linear-gradient(90deg, var(--accent-cyan), var(--primary-mint))';
          }
          
          tokenProgressBar.style.width = `${pct}%`;
          tokenUsedText.textContent = `Remaining: ${tokens.toLocaleString()} tokens`;
          tokenLimitText.textContent = `Allowance: ${limit.toLocaleString()} tokens`;
        }
      }

      // Update Plan Cards Active States
      const tiersList = ['free', 'pro', 'advanced'];
      tiersList.forEach(t => {
        const card = document.getElementById(`plan-card-${t}`);
        const badgeEl = document.getElementById(`badge-${t}`);
        const btn = document.getElementById(`upgrade-btn-${t}`);

        if (card && badgeEl && btn) {
          if (tier === t) {
            card.classList.add('active');
            badgeEl.style.display = 'block';
            btn.disabled = true;
            btn.textContent = 'Current Plan';
          } else {
            card.classList.remove('active');
            badgeEl.style.display = 'none';
            btn.disabled = false;
            btn.textContent = (tiersList.indexOf(t) > tiersList.indexOf(tier)) ? 'Upgrade Account' : 'Switch Plan';
          }
        }
      });

      // Developer API section visibility
      const apiDisabledBanner = document.getElementById('api-disabled-banner');
      const apiActivePanel = document.getElementById('api-active-panel');

      if (apiDisabledBanner && apiActivePanel) {
        if (tier === 'free') {
          apiDisabledBanner.style.display = 'block';
          apiActivePanel.style.display = 'none';
        } else {
          apiDisabledBanner.style.display = 'none';
          apiActivePanel.style.display = 'block';

          // Load existing API Key
          const apiKeyInput = document.getElementById('api-key-input');
          const codeSnippetToken = document.getElementById('code-snippet-token');
          if (apiKeyInput && codeSnippetToken) {
            if (userData.apiKey) {
              apiKeyInput.value = userData.apiKey;
              codeSnippetToken.textContent = userData.apiKey;
            } else {
              apiKeyInput.value = 'Click Generate to create a secure key';
              codeSnippetToken.textContent = 'YOUR_API_TOKEN';
            }
          }
        }
      }
    }

    // Subscribe to Settings
    unsubscribeSettings = onSnapshot(doc(db, 'settings', 'global'), (settingsSnap) => {
      if (settingsSnap.exists()) {
        const sData = settingsSnap.data();
        if (sData.limits) {
          limits = { ...limits, ...sData.limits };
          const limitFreeEl = document.getElementById('plan-limit-free');
          const limitProEl = document.getElementById('plan-limit-pro');
          const limitAdvancedEl = document.getElementById('plan-limit-advanced');
          
          if (limitFreeEl) limitFreeEl.innerHTML = `${(limits.free).toLocaleString()} <span>tok/day</span>`;
          if (limitProEl) limitProEl.innerHTML = `${(limits.pro).toLocaleString()} <span>tok/day</span>`;
          if (limitAdvancedEl) limitAdvancedEl.innerHTML = `${(limits.advanced).toLocaleString()} <span>tok/day</span>`;
        }
        freeForAll = !!sData.freeForAll;

        if (sData.apiUrl) {
          apiUrl = sData.apiUrl;
          const apiUrlInput = document.getElementById('api-url-input');
          const codeSnippetUrl = document.getElementById('code-snippet-url');
          if (apiUrlInput) apiUrlInput.value = apiUrl;
          if (codeSnippetUrl) codeSnippetUrl.textContent = apiUrl;
        }
      }
      updateUserUI();
      
      // Hide full-screen load indicator
      if (portalLoading) portalLoading.style.display = 'none';
      if (portalUi) portalUi.style.display = 'flex';
    });

    // Subscribe to User document
    unsubscribeUser = onSnapshot(doc(db, 'users', user.uid), (docSnap) => {
      if (docSnap.exists()) {
        userData = docSnap.data();
        updateUserUI();

        // Update Last Synchronization
        const infoLastActive = document.getElementById('info-last-active');
        if (infoLastActive) {
          if (userData.lastActive) {
            try {
              const lastActiveDate = userData.lastActive.toDate ? userData.lastActive.toDate() : new Date(userData.lastActive);
              infoLastActive.textContent = lastActiveDate.toLocaleString('en-US', {
                year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
              });
            } catch (e) {
              infoLastActive.textContent = '--';
            }
          } else {
            infoLastActive.textContent = '--';
          }
        }
      } else {
        // Doc doesn't exist yet
        userData = { tokens: limits.free, tier: 'free' };
        updateUserUI();
        const infoLastActive = document.getElementById('info-last-active');
        if (infoLastActive) infoLastActive.textContent = 'Never';
        
        // Hide full-screen load indicator
        if (portalLoading) portalLoading.style.display = 'none';
        if (portalUi) portalUi.style.display = 'flex';
      }
    });

    // Upgrade buttons action handlers
    const tiersList = ['free', 'pro', 'advanced'];
    tiersList.forEach(t => {
      const btn = document.getElementById(`upgrade-btn-${t}`);
      if (btn) {
        btn.addEventListener('click', async () => {
          const limit = limits[t] || 5000;
          btn.textContent = 'Updating...';
          
          await setDoc(doc(db, 'users', user.uid), {
            tier: t,
            tokens: limit,
            lastActive: new Date() // Reset lastActive to now
          }, { merge: true });

          btn.textContent = 'Updated!';
        });
      }
    });

    // API Key Generation Logic
    const generateApiBtn = document.getElementById('generate-api-btn');
    if (generateApiBtn) {
      generateApiBtn.addEventListener('click', async () => {
        generateApiBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
        
        // Generate secure 32 character hex key
        const randomBytes = new Uint8Array(16);
        window.crypto.getRandomValues(randomBytes);
        const randomHex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        const newKey = `jm_live_${randomHex}`;

        await setDoc(doc(db, 'users', user.uid), {
          apiKey: newKey
        }, { merge: true });

        generateApiBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Generate';
      });
    }

    // Copy handlers
    const copyApiBtn = document.getElementById('copy-api-btn');
    if (copyApiBtn) {
      copyApiBtn.addEventListener('click', () => {
        const apiKeyInput = document.getElementById('api-key-input');
        if (apiKeyInput && apiKeyInput.value && !apiKeyInput.value.startsWith('Click')) {
          navigator.clipboard.writeText(apiKeyInput.value).then(() => {
            copyApiBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10b981"></i> Copied!';
            setTimeout(() => {
              copyApiBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy';
            }, 2000);
          });
        }
      });
    }

    const copyUrlBtn = document.getElementById('copy-url-btn');
    if (copyUrlBtn) {
      copyUrlBtn.addEventListener('click', () => {
        const apiUrlInput = document.getElementById('api-url-input');
        if (apiUrlInput && apiUrlInput.value) {
          navigator.clipboard.writeText(apiUrlInput.value).then(() => {
            copyUrlBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10b981"></i> Copied!';
            setTimeout(() => {
              copyUrlBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy';
            }, 2000);
          });
        }
      });
    }

  });

  // Sidebar back to chat and logout buttons
  if (backToChatBtn) {
    backToChatBtn.addEventListener('click', () => {
      window.location.href = '/chat/';
    });
  }

  if (signOutBtn) {
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
  }
});
