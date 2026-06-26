import { auth, db, signOut, onAuthStateChanged, doc, setDoc, getDoc, onSnapshot, signInWithPopup, googleProvider, serverTimestamp } from './firebase.js';

let API_BASE = import.meta.env.VITE_API_URL || '';
let currentUser = null;
let sessions = [];
let activeModels = [];
let isGenerating = false;

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements — all inside DOMContentLoaded so they are never null
  const sidebar = document.getElementById('sidebar');
  const sidebarToggleOpen = document.getElementById('sidebar-toggle-open');
  const sidebarToggleClose = document.getElementById('sidebar-toggle-close');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const modelSelect = document.getElementById('model-select');
  const refreshModelsBtn = document.getElementById('refresh-models-btn');
  const ollamaErrorBanner = document.getElementById('ollama-error-banner');
  const messagesContainer = document.getElementById('messages-container');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const suggestionCards = document.querySelectorAll('.suggestion-card');
  const currentModelSpan = document.getElementById('current-loaded-model');
  const newChatBtn = document.getElementById('new-chat-btn');
  const chatHistoryList = document.getElementById('chat-history-list');
  const welcomeScreen = document.getElementById('welcome-screen');
  const retryOllamaBtn = document.getElementById('retry-ollama-btn');
  const stopGenerationBtn = document.getElementById('stop-generation-btn');
  const currentLoadedModel = document.getElementById('current-loaded-model');
  
  let activeSessionId = null;
  let activeController = null;

  // Firebase Auth State Observer
  let unsubscribeUser = null;
  let unsubscribeSettings = null;

  window.currentUserTokens = 0;
  window.freeForAll = false;
  window.userManuallySelectedModel = false;

  function updateTokenBalanceDisplay(tokens) {
    const tokenBalanceEl = document.getElementById('token-balance');
    if (!tokenBalanceEl) return;
    
    if (window.freeForAll) {
      tokenBalanceEl.textContent = 'Unlimited';
      tokenBalanceEl.style.color = '#10b981';
      tokenBalanceEl.style.background = 'rgba(16, 185, 129, 0.1)';
    } else {
      tokenBalanceEl.textContent = (tokens || 0).toLocaleString() + ' tokens';
      tokenBalanceEl.style.color = 'var(--primary-mint)';
      tokenBalanceEl.style.background = 'rgba(20, 184, 166, 0.1)';
    }
  }

  // Real-time Settings Listener
  let isInitialLoad = true;
  unsubscribeSettings = onSnapshot(doc(db, 'settings', 'global'), (settingsSnap) => {
    if (settingsSnap.exists()) {
      const data = settingsSnap.data();
      let apiUrlChanged = false;
      
      if (data.apiUrl && data.apiUrl !== API_BASE) {
        API_BASE = data.apiUrl;
        apiUrlChanged = true;
      }
      
      if (data.defaultModel) {
        window.defaultModelFromSettings = data.defaultModel;
        const modelSelect = document.getElementById('model-select');
        if (modelSelect && !window.userManuallySelectedModel) {
          if ([...modelSelect.options].some(o => o.value === data.defaultModel)) {
            modelSelect.value = data.defaultModel;
            const currentLoadedModel = document.getElementById('current-loaded-model');
            if (currentLoadedModel) currentLoadedModel.textContent = data.defaultModel;
          }
        }
      }
      
      window.freeForAll = !!data.freeForAll;
      updateTokenBalanceDisplay(window.currentUserTokens);
      
      if (apiUrlChanged || isInitialLoad) {
        fetchModels();
        isInitialLoad = false;
      }
    }
  }, (error) => {
    console.warn("Could not subscribe to global settings in real-time:", error);
  });

  onAuthStateChanged(auth, async (user) => {
    const signOutBtn = document.getElementById('sign-out-btn');
    if (!user) {
      if (unsubscribeUser) unsubscribeUser();
      
      if (signOutBtn) {
        signOutBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In';
      }

      if (sessions.length === 0) {
        startNewSession();
      }
    } else {
      currentUser = user;
      document.getElementById('bot-name').textContent = user.displayName || 'User';

      // Update sidebar avatar with user's Google photo
      const sidebarAvatar = document.getElementById('sidebar-avatar');
      if (sidebarAvatar && user.photoURL) {
        sidebarAvatar.innerHTML = `<img src="${user.photoURL}" alt="${user.displayName || 'User'}" referrerpolicy="no-referrer">`;
      }

      if (signOutBtn) {
        signOutBtn.innerHTML = '<i class="fa-solid fa-arrow-right-from-bracket"></i> Sign Out';
      }

      // CRITICAL: Initialize user document FIRST, before anything else
      const userRef = doc(db, 'users', user.uid);
      try {
        const docSnap = await getDoc(userRef);
        if (!docSnap.exists() || !docSnap.data().email) {
          // Document doesn't exist OR is empty/partial — write full document
          const existingData = docSnap.exists() ? docSnap.data() : {};
          const defaultLimit = window.globalLimits?.free || 5000;
          await setDoc(userRef, {
            name: existingData.name || user.displayName || '',
            email: existingData.email || user.email || '',
            photoURL: existingData.photoURL || user.photoURL || '',
            tokens: (existingData.tokens !== undefined && existingData.tokens !== null) ? existingData.tokens : defaultLimit,
            tier: existingData.tier || 'free',
            createdAt: existingData.createdAt || serverTimestamp(),
            lastActive: serverTimestamp(),
            ip: existingData.ip || 'unknown'
          });
          console.log("[Jellymint] User document created/repaired in Firestore");
        } else {
          // Document exists with data — just update lastActive
          await setDoc(userRef, { lastActive: serverTimestamp() }, { merge: true });
          console.log("[Jellymint] User document lastActive updated");
        }
      } catch (err) {
        console.error("[Jellymint] Error initializing user doc, attempting direct write:", err);
        // FALLBACK: If getDoc failed (e.g. permissions), try a direct merge write
        try {
          await setDoc(userRef, {
            name: user.displayName || '',
            email: user.email || '',
            photoURL: user.photoURL || '',
            tokens: window.globalLimits?.free || 5000,
            tier: 'free',
            createdAt: serverTimestamp(),
            lastActive: serverTimestamp(),
            ip: 'unknown'
          }, { merge: true });
          console.log("[Jellymint] Fallback: User document written via merge");
        } catch (fallbackErr) {
          console.error("[Jellymint] CRITICAL: All attempts to write user document failed:", fallbackErr);
        }
      }

      // NOW load chat history (after user doc is guaranteed to exist)
      loadHistoryFromServer();

      // Listen to token balance reactively
      if (unsubscribeUser) unsubscribeUser();
      unsubscribeUser = onSnapshot(doc(db, 'users', user.uid), (docSnap) => {
        if (docSnap.exists()) {
           const userData = docSnap.data();
           window.currentUserTokens = userData.tokens || 0;
           updateTokenBalanceDisplay(window.currentUserTokens);
        }
      });
    }
  });

  // Sign out functionality
  const signOutBtn = document.getElementById('sign-out-btn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      if (!currentUser) {
        window.location.href = '/login/';
        return;
      }
      try {
        await signOut(auth);
        window.location.reload();
      } catch (error) {
        console.error('Error signing out', error);
      }
    });
  }

  // Custom Marked HTML Escape utility
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Setup Custom Markdown Renderer for Code Blocks
  const renderer = new marked.Renderer();
  renderer.code = function(code, language) {
    const validLanguage = language ? language : 'plaintext';
    return `
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span>${validLanguage}</span>
          <button class="copy-code-btn" onclick="copyCode(this)">
            <i class="fa-regular fa-clipboard"></i> Copy code
          </button>
        </div>
        <pre class="language-${validLanguage}"><code class="language-${validLanguage}">${escapeHtml(code)}</code></pre>
      </div>
    `;
  };
  marked.setOptions({ renderer });

  // Copy Code Functionality
  window.copyCode = function(button) {
    const pre = button.closest('.code-block-wrapper').querySelector('pre');
    const code = pre.textContent;
    
    navigator.clipboard.writeText(code).then(() => {
      button.innerHTML = '<i class="fa-solid fa-check" style="color: #10b981"></i> Copied!';
      setTimeout(() => {
        button.innerHTML = '<i class="fa-regular fa-clipboard"></i> Copy code';
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy: ', err);
    });
  };

  // Sidebar controls
  function updateSidebarState(collapse) {
    if (collapse) {
      sidebar.classList.add('collapsed');
      document.body.classList.add('sidebar-closed');
    } else {
      sidebar.classList.remove('collapsed');
      document.body.classList.remove('sidebar-closed');
    }
  }

  sidebarToggleClose.addEventListener('click', () => updateSidebarState(true));
  sidebarToggleOpen.addEventListener('click', () => updateSidebarState(false));
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => updateSidebarState(true));
  }

  if (window.innerWidth <= 768) {
    updateSidebarState(true);
  } else {
    updateSidebarState(false);
  }

  // Textarea dynamic height adjustment
  chatInput.addEventListener('input', () => {
    chatInput.style.height = '24px';
    chatInput.style.height = chatInput.scrollHeight + 'px';
    sendBtn.disabled = !chatInput.value.trim() || isGenerating;
  });

  // Load configuration and models from backend
  async function fetchModels() {
    modelSelect.innerHTML = '<option value="" disabled selected>Loading models...</option>';
    refreshModelsBtn.querySelector('i').classList.add('fa-spin');
    
    try {
      const response = await fetch(API_BASE + '/api/models', {
        headers: { 'ngrok-skip-browser-warning': 'true' }
      });
      const data = await response.json();
      
      refreshModelsBtn.querySelector('i').classList.remove('fa-spin');
      
      const indicator = document.getElementById('ollama-status-indicator');
      const dot = indicator.querySelector('.status-dot');
      const statusText = indicator.querySelector('.status-text');

      if (data.online) {
        dot.className = 'status-dot online';
        statusText.textContent = 'AI Service Connected';
        ollamaErrorBanner.classList.add('hidden');
        
        // Show model select wrapper in header
        const modelSelectWrapper = document.querySelector('.model-selector-wrapper');
        if (modelSelectWrapper) modelSelectWrapper.style.display = 'flex';
        
        activeModels = data.models;
        if (activeModels.length === 0) {
          modelSelect.innerHTML = '<option value="" disabled selected>No models installed</option>';
          currentModelSpan.textContent = 'None';
          ollamaErrorBanner.classList.remove('hidden');
          ollamaErrorBanner.querySelector('h4').textContent = 'No local models found';
          ollamaErrorBanner.querySelector('p').innerHTML = 'AI Service is online, but you have no models installed. Please install a model in your terminal to continue.';
          return;
        }

        modelSelect.innerHTML = '';
        activeModels.forEach(model => {
          const option = document.createElement('option');
          option.value = model.name;
          option.textContent = model.name;
          modelSelect.appendChild(option);
        });

        // Automatically select the best fitting model
        let selectedModel = '';
        
        if (window.defaultModelFromSettings && activeModels.some(m => m.name === window.defaultModelFromSettings)) {
          selectedModel = window.defaultModelFromSettings;
        } else {
          const qwen3Model = activeModels.find(m => m.name.toLowerCase().includes('qwen3'));
          const qwen25Model = activeModels.find(m => m.name.toLowerCase().includes('qwen2.5'));
          const qwenModel = activeModels.find(m => m.name.toLowerCase().includes('qwen'));
          
          if (qwen3Model) {
            selectedModel = qwen3Model.name;
          } else if (qwen25Model) {
            selectedModel = qwen25Model.name;
          } else if (qwenModel) {
            selectedModel = qwenModel.name;
          } else {
            selectedModel = activeModels[0].name;
          }
        }

        modelSelect.value = selectedModel;
        currentModelSpan.textContent = selectedModel;
      } else {
        dot.className = 'status-dot offline';
        statusText.textContent = 'AI Service Offline';
        modelSelect.innerHTML = '<option value="" disabled selected>AI Service Offline</option>';
        currentModelSpan.textContent = 'None';
        ollamaErrorBanner.classList.remove('hidden');
        
        // Hide model select wrapper in header
        const modelSelectWrapper = document.querySelector('.model-selector-wrapper');
        if (modelSelectWrapper) modelSelectWrapper.style.display = 'none';
      }
    } catch (error) {
      console.error('Error fetching models:', error);
      refreshModelsBtn.querySelector('i').classList.remove('fa-spin');
    }
  }

  modelSelect.addEventListener('change', () => {
    window.userManuallySelectedModel = true;
    currentLoadedModel.textContent = modelSelect.value;
    if (activeSessionId) {
      const activeSession = sessions.find(s => s.id === activeSessionId);
      if (activeSession) {
        activeSession.model = modelSelect.value;
        saveHistoryToServer();
      }
    }
  });

  refreshModelsBtn.addEventListener('click', fetchModels);
  retryOllamaBtn.addEventListener('click', fetchModels);

  // Encryption-enabled Chat History Storage Sync
  async function loadHistoryFromServer() {
    if (!currentUser) return;
    try {
      const docRef = doc(db, 'users', currentUser.uid, 'history', 'data');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        sessions = docSnap.data().sessions || [];
        renderSidebarHistory();
        startNewSession();
      } else {
        sessions = [];
        startNewSession();
      }
      
      const pendingPrompt = sessionStorage.getItem('pendingPrompt');
      if (pendingPrompt) {
        sessionStorage.removeItem('pendingPrompt');
        setTimeout(() => {
          chatInput.value = pendingPrompt;
          chatInput.style.height = chatInput.scrollHeight + 'px';
          sendBtn.disabled = false;
          sendMessage();
        }, 500);
      }
    } catch (error) {
      console.error('Failed to load history from Firestore:', error);
      sessions = [];
      startNewSession();
    }
  }

  async function saveHistoryToServer() {
    if (!currentUser) return;
    try {
      const docRef = doc(db, 'users', currentUser.uid, 'history', 'data');
      await setDoc(docRef, { sessions });
    } catch (error) {
      console.error('Failed to sync history with Firestore:', error);
    }
  }

  // Sidebar History Renderer
  function renderSidebarHistory() {
    chatHistoryList.innerHTML = '';
    
    if (sessions.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.padding = '15px';
      emptyMsg.style.fontSize = '0.82rem';
      emptyMsg.style.color = 'var(--text-muted)';
      emptyMsg.style.textAlign = 'center';
      emptyMsg.textContent = 'No recent conversations';
      chatHistoryList.appendChild(emptyMsg);
      return;
    }

    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = `history-item ${session.id === activeSessionId ? 'active' : ''}`;
      item.dataset.id = session.id;

      item.innerHTML = `
        <div class="history-item-left">
          <i class="fa-regular fa-message"></i>
          <span class="history-item-title">${escapeHtml(session.title)}</span>
        </div>
        <button class="delete-session-btn" title="Delete conversation">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      `;

      // Direct listener with stopPropagation for safe deletion (crucial for mobile touch events)
      const deleteBtn = item.querySelector('.delete-session-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteSession(session.id);
        });
      }

      item.addEventListener('click', () => {
        loadSession(session.id);
      });

      chatHistoryList.appendChild(item);
    });
  }

  // Session Control Functions
  function startNewSession() {
    if (isGenerating) return;
    
    activeSessionId = 'session_' + Date.now();
    const newSession = {
      id: activeSessionId,
      title: 'New Chat',
      model: modelSelect.value || '',
      messages: [],
      createdAt: new Date().toISOString()
    };
    
    sessions.unshift(newSession);
    renderSidebarHistory();
    loadSession(activeSessionId);
  }

  function loadSession(id) {
    if (isGenerating) return;
    
    activeSessionId = id;
    const session = sessions.find(s => s.id === id);
    if (!session) return;

    // Highlight active in sidebar
    document.querySelectorAll('.history-item').forEach(item => {
      item.classList.toggle('active', item.dataset.id === id);
    });

    // Update model selector if matching
    if (session.model && [...modelSelect.options].some(o => o.value === session.model)) {
      modelSelect.value = session.model;
      currentLoadedModel.textContent = session.model;
    }

    // Render messages
    renderMessages(session.messages);
    
    if (session.messages.length === 0) {
      welcomeScreen.classList.remove('hidden');
      messagesContainer.classList.add('hidden');
    } else {
      welcomeScreen.classList.add('hidden');
      messagesContainer.classList.remove('hidden');
      scrollToBottom();
    }

    if (window.innerWidth <= 768) {
      updateSidebarState(true);
    }
  }

  function deleteSession(id) {
    if (isGenerating) return;
    
    const index = sessions.findIndex(s => s.id === id);
    if (index === -1) return;

    sessions.splice(index, 1);
    saveHistoryToServer();
    
    if (activeSessionId === id) {
      if (sessions.length > 0) {
        loadSession(sessions[0].id);
      } else {
        startNewSession();
      }
    } else {
      renderSidebarHistory();
    }
  }

  newChatBtn.addEventListener('click', startNewSession);

  // Message Rendering Helpers
  function renderMessages(messages) {
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      appendMessageBubble(msg.role, msg.content, false, msg.metricsHTML || '');
    });
  }

  function appendMessageBubble(role, content, isTemporary = false, metricsHTML = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role}`;
    if (isTemporary) wrapper.id = 'temp-bot-bubble';

    const avatar = document.createElement('div');
    avatar.className = `message-avatar ${role}-avatar`;
    if (role === 'user') {
      avatar.innerHTML = '<i class="fa-solid fa-user"></i>';
    } else {
      avatar.innerHTML = '<img src="/logo.svg" alt="Bot">';
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    if (role === 'user') {
      contentDiv.textContent = content;
    } else {
      contentDiv.innerHTML = marked.parse(content) + metricsHTML;
    }

    bubble.appendChild(contentDiv);
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    messagesContainer.appendChild(wrapper);
    
    if (role === 'assistant') {
      Prism.highlightAllUnder(contentDiv);
    }
  }

  function updateBotBubble(content, metricsHTML = '') {
    const bubble = document.getElementById('temp-bot-bubble');
    if (!bubble) return;
    
    const contentDiv = bubble.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.innerHTML = marked.parse(content) + metricsHTML;
      Prism.highlightAllUnder(contentDiv);
    }
    scrollToBottom();
  }

  function showLoadingSkeleton() {
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper assistant';
    wrapper.id = 'skeleton-indicator';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar bot-avatar';
    avatar.innerHTML = '<img src="/logo.svg" alt="Bot">';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const typingDiv = document.createElement('div');
    typingDiv.className = 'typing-indicator';
    typingDiv.innerHTML = `
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
    `;

    bubble.appendChild(typingDiv);
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    messagesContainer.appendChild(wrapper);
    scrollToBottom();
  }

  function removeLoadingSkeleton() {
    const skeleton = document.getElementById('skeleton-indicator');
    if (skeleton) skeleton.remove();
  }

  function scrollToBottom() {
    const container = messagesContainer.parentElement || messagesContainer;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  // Suggestion Cards Clicking
  suggestionCards.forEach(card => {
    card.addEventListener('click', () => {
      const prompt = card.getAttribute('data-prompt');
      chatInput.value = prompt;
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
      sendBtn.disabled = false;
      chatInput.focus();
    });
  });

  // Sending Messages & Streaming logic
  async function sendMessage() {
    const userPrompt = chatInput.value.trim();
    const model = modelSelect.value;

    if (!userPrompt || !model || isGenerating) return;

    if (!currentUser) {
      try {
        await signInWithPopup(auth, googleProvider);
        sessionStorage.setItem('pendingPrompt', userPrompt);
        return;
      } catch (error) {
        console.error("Popup login failed", error);
        return;
      }
    }

    // Reset textarea
    chatInput.value = '';
    chatInput.style.height = '24px';
    sendBtn.disabled = true;

    // Update screen view
    welcomeScreen.classList.add('hidden');
    messagesContainer.classList.remove('hidden');

    const activeSession = sessions.find(s => s.id === activeSessionId);
    if (!activeSession) return;

    // Generate title from prompt if first message
    if (activeSession.messages.length === 0) {
      let title = userPrompt;
      if (title.length > 25) {
        title = title.substring(0, 25) + '...';
      }
      activeSession.title = title;
      renderSidebarHistory();
    }

    // Add user message to session memory
    activeSession.messages.push({ role: 'user', content: userPrompt });
    appendMessageBubble('user', userPrompt);
    scrollToBottom();

    // Streaming setup
    isGenerating = true;
    activeController = new AbortController();
    stopGenerationBtn.classList.remove('hidden');
    showLoadingSkeleton();

    try {
      const idToken = await currentUser.getIdToken();
      const response = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({
          model: model,
          messages: activeSession.messages
        }),
        signal: activeController.signal
      });

      removeLoadingSkeleton();

      if (!response.ok) {
        const errJson = await response.json();
        throw new Error(errJson.details || errJson.error || 'Server error');
      }

      // Add temporary bot response bubble
      appendMessageBubble('assistant', '', true, '');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let botResponse = '';
      let metrics = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        // Keep the last partial line in the buffer
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message && parsed.message.content) {
              botResponse += parsed.message.content;
              updateBotBubble(botResponse);
              scrollToBottom();
            }
            if (parsed.done) {
              metrics = {
                eval_count: parsed.eval_count,
                eval_duration: parsed.eval_duration,
                total_duration: parsed.total_duration
              };
            }
          } catch (e) {
            console.warn('Error parsing streaming line:', e, line);
          }
        }
      }

      // Check remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          if (parsed.message && parsed.message.content) {
            botResponse += parsed.message.content;
            updateBotBubble(botResponse);
            scrollToBottom();
          }
          if (parsed.done) {
            metrics = {
              eval_count: parsed.eval_count,
              eval_duration: parsed.eval_duration,
              total_duration: parsed.total_duration
            };
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      let metricsHTML = '';
      if (metrics && metrics.eval_count && metrics.eval_duration) {
        try {
          const timeSec = (metrics.total_duration / 1e9).toFixed(2);
          const tps = (metrics.eval_count / (metrics.eval_duration / 1e9)).toFixed(1);
          
          metricsHTML = `
            <div class="message-metrics">
              <span class="metric-item"><i class="fa-solid fa-bolt"></i> ${tps} tok/s</span>
              <span class="metric-item"><i class="fa-regular fa-clock"></i> ${timeSec}s</span>
            </div>
          `;
          updateBotBubble(botResponse, metricsHTML);
        } catch(e) {
          console.error('Metrics fetch error', e);
        }
      }

      // Swap temporary bubble ID
      const tempBubble = document.getElementById('temp-bot-bubble');
      if (tempBubble) tempBubble.removeAttribute('id');

      // Add assistant response to session memory
      activeSession.messages.push({ 
        role: 'assistant', 
        content: botResponse,
        metricsHTML: metricsHTML
      });
      saveHistoryToServer();

    } catch (error) {
      removeLoadingSkeleton();
      const tempBubble = document.getElementById('temp-bot-bubble');
      if (tempBubble) tempBubble.remove();

      if (error.name === 'AbortError') {
        console.log('Stream generation aborted by user.');
        // Save whatever we generated before aborting
        const lastWrapper = messagesContainer.lastElementChild;
        if (lastWrapper && lastWrapper.classList.contains('assistant')) {
          const content = lastWrapper.querySelector('.message-content').textContent;
          if (content.trim()) {
            activeSession.messages.push({ role: 'assistant', content: content + ' *[Generation stopped]*' });
            saveHistoryToServer();
          }
        }
      } else {
        console.error('Messaging streaming error:', error);
        appendMessageBubble('assistant', `⚠️ **Error:** ${error.message || 'Failed to stream response from local model.'}`);
      }
    } finally {
      isGenerating = false;
      activeController = null;
      stopGenerationBtn.classList.add('hidden');
      sendBtn.disabled = !chatInput.value.trim();
    }
  }

  // Event bindings for sending message
  sendBtn.addEventListener('click', sendMessage);
  
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Stop generation control
  stopGenerationBtn.addEventListener('click', () => {
    if (activeController) {
      activeController.abort();
    }
  });

  // Fetch bot info and display in sidebar/header
  async function fetchVersion() {
    try {
      const response = await fetch(API_BASE + '/api/version', {
        headers: { 'ngrok-skip-browser-warning': 'true' }
      });
      if (response.ok) {
        const metadata = await response.json();
        document.getElementById('bot-name').textContent = metadata.name || 'Jellymint';
        document.getElementById('bot-version').textContent = metadata.version || 'v2.0.0';
        document.getElementById('header-version').textContent = metadata.version || 'v2.0.0';
        const sidebarVer = document.getElementById('sidebar-version-display');
        if (sidebarVer) {
          sidebarVer.textContent = metadata.version || '2.0.0';
        }
      }
    } catch (e) {
      console.warn('Failed to fetch version metadata:', e);
    }
  }

  // Typing animation for welcome page
  const welcomeHeadingH1 = document.querySelector('.welcome-heading h1');
  if (welcomeHeadingH1) {
    welcomeHeadingH1.style.borderRight = '3px solid var(--primary-mint)';
    welcomeHeadingH1.innerHTML = '';
    
    const textPart1 = "Hello, I'm ";
    const textPart2 = "Jellymint";
    let typeIndex = 0;
    
    function typeWriter() {
      if (typeIndex < textPart1.length) {
        welcomeHeadingH1.innerHTML = textPart1.substring(0, typeIndex + 1);
        typeIndex++;
        setTimeout(typeWriter, 50);
      } else if (typeIndex < textPart1.length + textPart2.length) {
        const j = typeIndex - textPart1.length;
        welcomeHeadingH1.innerHTML = textPart1 + `<span class="gradient-text">${textPart2.substring(0, j + 1)}</span>`;
        typeIndex++;
        setTimeout(typeWriter, 50);
      } else {
        welcomeHeadingH1.style.borderRight = 'none';
      }
    }
    setTimeout(typeWriter, 300);
  }

  // Initialize
  fetchVersion();
});

