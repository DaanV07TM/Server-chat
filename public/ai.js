(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if ((params.get('room') || 'general').toLowerCase() !== 'ai') return;

  const shareId = params.get('share') || '';
  const sharedView = /^[a-f0-9]{32}$/.test(shareId);
  const root = document.createElement('div');
  root.id = 'aiStudioRoot';
  root.innerHTML =
    '<main class="ai-workspace">' +
      '<aside id="aiSidebar" class="ai-sidebar">' +
        '<div class="ai-sidebar-brand"><span class="ai-brand-icon">✦</span><div><strong>AI Studio</strong><span>YOUR PRIVATE SPACE</span></div></div>' +
        '<button id="aiNewChat" class="ai-new-chat" type="button"><span>＋</span> New conversation</button>' +
        '<div class="ai-history-heading"><span>YOUR CHATS</span><span id="aiHistoryCount">0</span></div>' +
        '<div id="aiHistory" class="ai-history" aria-label="Your private AI conversations"></div>' +
        '<div class="ai-sidebar-footer"><span class="ai-lock-icon">♙</span><div><strong>Private by default</strong><p>Your chats belong to your account. Only a share link makes a read-only copy visible to others.</p></div></div>' +
      '</aside>' +
      '<section class="ai-main">' +
        '<div class="ai-topbar" role="group" aria-label="AI conversation header">' +
          '<div class="ai-topbar-title"><span class="ai-workspace-eyebrow" id="aiBreadcrumb">PERSONAL WORKSPACE</span><h1 id="aiConversationTitle">Your AI assistant</h1><div class="ai-status-line"><span id="aiStatusDot" class="ai-status-dot"></span><span id="aiStatusText">Connecting to AI…</span><span class="ai-private-badge" id="aiPrivateBadge">🔒 Private</span></div></div>' +
          '<div class="ai-top-actions"><a id="aiImageLink" class="ai-secondary-btn ai-external-image-link" href="https://www.bing.com/images/create" target="_blank" rel="noopener noreferrer" title="Open the free Bing Image Creator">▧ <span>Create image</span></a><button id="aiShareBtn" class="ai-primary-btn" type="button">↗ <span>Share</span></button><button id="aiStopShareBtn" class="ai-secondary-btn" type="button" hidden>Stop sharing</button><button id="aiDeleteBtn" class="ai-icon-btn" type="button" aria-label="Delete conversation" title="Delete conversation">⌫</button></div>' +
        '</div>' +
        '<div id="aiShareBanner" class="ai-share-banner" hidden><span>↗</span><div><strong>Shared read-only conversation</strong><p>This is a snapshot shared by someone with the link. You cannot see their private chat history or send messages to their account.</p></div><a href="/?room=ai">Open your AI Studio</a></div>' +
        '<div id="aiModeNotice" class="ai-mode-notice" hidden></div>' +
        '<div id="aiThread" class="ai-thread" aria-live="polite"><div class="ai-empty-state"><span class="ai-empty-orb">✦</span><h2>What are we working on?</h2><p>Ask a question, explore an idea or improve some writing. Use Create image above to open the free image generator.</p><div class="ai-starter-grid"><button type="button" data-starter="Explain a difficult topic to me in simple steps."><span>✧</span><b>Learn something</b><small>Clear explanations and examples</small></button><button type="button" data-starter="Help me brainstorm five original ideas for a project."><span>◇</span><b>Brainstorm ideas</b><small>Get unstuck and explore options</small></button><button type="button" data-starter="Help me write a clear, friendly message."><span>↗</span><b>Write something</b><small>Messages, emails and more</small></button><button type="button" data-starter="Help me create a detailed image prompt for a cinematic fantasy scene."><span>▧</span><b>Imagine a scene</b><small>Draft a visual idea</small></button></div></div></div>' +
        '<div id="aiWorking" class="ai-working" hidden><span class="ai-working-orb">✦</span><span id="aiWorkingText">Thinking…</span><span class="ai-thinking-dots"><i></i><i></i><i></i></span></div>' +
        '<form id="aiComposer" class="ai-composer">' +
          '<div class="ai-composer-tools"><span id="aiComposerMode">✦ Message the AI</span><span>Enter to send · Shift+Enter for a new line</span></div>' +
          '<div class="ai-composer-field"><textarea id="aiInput" rows="1" maxlength="2500" placeholder="Ask anything…"></textarea><button id="aiSend" class="ai-send-btn" type="submit" aria-label="Send message">↑</button></div>' +
          '<div class="ai-composer-foot"><span>AI can make mistakes. Don’t share passwords or sensitive information.</span><span id="aiComposerHint">Private to your account</span></div>' +
        '</form>' +
        '<div id="aiToast" class="ai-toast" role="status" aria-live="polite"></div>' +
      '</section>' +
    '</main>';
  document.body.appendChild(root);

  const $ = id => document.getElementById(id);
  const state = {
    conversations: [],
    activeId: '',
    active: null,
    available: false,
    sharedView,
    share: null,
    busy: false,
    abortController: null,
    requestVersion: 0,
    toastTimer: null
  };

  const sessionToken = () => {
    // The admin has a distinct private AI workspace and can use it without a temporary user account.
    try { return localStorage.getItem('accountSessionToken') || localStorage.getItem('adminSessionToken') || ''; } catch (_) { return ''; }
  };
  const api = async (path, options = {}) => {
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    const token = sessionToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'The AI request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return data;
  };
  const toast = (message, kind = 'info', duration = 4300) => {
    const node = $('aiToast');
    node.textContent = message;
    node.className = 'ai-toast is-visible ' + kind;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { node.className = 'ai-toast'; }, duration);
  };
  const displayTime = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  };
  const escapeText = value => String(value == null ? '' : value);

  function updateStatus(text, ready) {
    $('aiStatusText').textContent = text;
    $('aiStatusDot').classList.toggle('is-ready', Boolean(ready));
    $('aiPrivateBadge').textContent = state.sharedView ? '↗ Shared' : '🔒 Private';
    if (state.sharedView) $('aiPrivateBadge').classList.add('is-shared');
  }

  async function checkStatus() {
    try {
      const status = await api('/api/ai/status');
      state.available = Boolean(status.available);
      const statusText = !status.enabled ? 'AI paused by a server administrator' : !status.configured ? 'Text AI is not configured' : 'AI assistant ready';
      updateStatus(statusText, state.available);
      if (!status.enabled) showModeNotice('The server administrator has temporarily paused text AI. Your private conversation history has not been deleted.', true, 'warning');
      else if (!status.configured) showModeNotice('Text AI is not configured on the server yet. Your prompt will not be sent until the provider is configured.', true, 'warning');
      else if ($('aiModeNotice').classList.contains('warning')) showModeNotice('', false);
      syncComposer();
    } catch (_) {
      updateStatus('AI service unavailable', false);
      state.available = false;
      syncComposer();
    }
  }

  function showModeNotice(text, visible = true, kind = '') {
    const el = $('aiModeNotice');
    el.textContent = text;
    el.hidden = !visible;
    el.className = 'ai-mode-notice' + (kind ? ' ' + kind : '');
  }

  function syncComposer() {
    const disabled = state.sharedView || state.busy || !state.available || !sessionToken();
    $('aiInput').disabled = disabled;
    $('aiSend').disabled = disabled || !$('aiInput').value.trim();
    $('aiShareBtn').hidden = state.sharedView || !state.active || !state.active.messages.length;
    const shareLabel = $('aiShareBtn').querySelector('span');
    if (shareLabel) shareLabel.textContent = state.active && state.active.shareId ? 'Update link' : 'Share';
    $('aiStopShareBtn').hidden = state.sharedView || !state.active || !state.active.shareId;
    $('aiDeleteBtn').hidden = state.sharedView || !state.activeId;
    $('aiNewChat').hidden = state.sharedView;
    $('aiComposerMode').textContent = state.sharedView ? 'Read-only shared conversation' : '✦ Message the AI';
    $('aiComposerHint').textContent = state.sharedView ? 'Read only' : 'Private to your account';
    $('aiInput').placeholder = state.sharedView ? 'This conversation is read-only.' : 'Ask anything…';
  }

  function appendTextContent(container, text) {
    const content = document.createElement('div');
    content.className = 'ai-message-copy';
    content.textContent = escapeText(text);
    container.appendChild(content);
  }

  function makeMessage(message) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const row = document.createElement('article');
    row.className = 'ai-message-row ' + role;
    const avatar = document.createElement('div');
    avatar.className = 'ai-message-avatar ' + role;
    avatar.textContent = role === 'user' ? 'You' : '✦';
    row.appendChild(avatar);
    const body = document.createElement('div');
    body.className = 'ai-message-body';
    const meta = document.createElement('div');
    meta.className = 'ai-message-meta';
    meta.textContent = role === 'user' ? 'You' : 'Server Chat AI';
    body.appendChild(meta);
    appendTextContent(body, message.content);
    row.appendChild(body);
    return row;
  }

  function renderThread() {
    const thread = $('aiThread');
    thread.replaceChildren();
    const messages = state.sharedView
      ? (state.share && Array.isArray(state.share.messages) ? state.share.messages : [])
      : (state.active && Array.isArray(state.active.messages) ? state.active.messages : []);
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'ai-empty-state';
      empty.innerHTML = '<span class="ai-empty-orb">✦</span><h2>What are we working on?</h2><p>Ask a question, explore an idea or improve some writing. Use Create image above to open the free image generator.</p>' +
        '<div class="ai-starter-grid"><button type="button" data-starter="Explain a difficult topic to me in simple steps."><span>✧</span><b>Learn something</b><small>Clear explanations and examples</small></button><button type="button" data-starter="Help me brainstorm five original ideas for a project."><span>◇</span><b>Brainstorm ideas</b><small>Get unstuck and explore options</small></button><button type="button" data-starter="Help me write a clear, friendly message."><span>↗</span><b>Write something</b><small>Messages, emails and more</small></button><button type="button" data-starter="Help me create a detailed image prompt for a cinematic fantasy scene."><span>▧</span><b>Imagine a scene</b><small>Draft a visual idea</small></button></div>';
      thread.appendChild(empty);
      return;
    }
    for (const message of messages) thread.appendChild(makeMessage(message));
    if (!state.sharedView && messages.length < 2) {
      const intro = document.createElement('div');
      intro.className = 'ai-thread-footnote';
      intro.textContent = 'This conversation is private to your temporary account unless you deliberately create a share link.';
      thread.appendChild(intro);
    }
    requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  }

  function renderHistory() {
    const list = $('aiHistory');
    list.replaceChildren();
    $('aiHistoryCount').textContent = String(state.conversations.length);
    for (const item of state.conversations) {
      const entry = document.createElement('div');
      entry.className = 'ai-history-entry' + (item.id === state.activeId ? ' is-active' : '');
      const open = document.createElement('button');
      open.className = 'ai-history-open';
      open.type = 'button';
      const title = document.createElement('span');
      title.className = 'ai-history-title';
      title.textContent = item.title || 'New conversation';
      const detail = document.createElement('small');
      detail.textContent = displayTime(item.updatedAt) + (item.shared ? ' · Shared link' : '');
      open.append(title, detail);
      open.addEventListener('click', () => openConversation(item.id));
      entry.appendChild(open);
      const remove = document.createElement('button');
      remove.className = 'ai-history-delete';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Delete conversation';
      remove.setAttribute('aria-label', 'Delete ' + (item.title || 'conversation'));
      remove.addEventListener('click', event => {
        event.stopPropagation();
        deleteConversation(item.id);
      });
      entry.appendChild(remove);
      list.appendChild(entry);
    }
    if (!state.conversations.length) {
      const empty = document.createElement('p');
      empty.className = 'ai-history-empty';
      empty.textContent = 'Your private conversations will appear here.';
      list.appendChild(empty);
    }
  }

  async function loadConversations() {
    if (state.sharedView) return;
    if (!sessionToken()) {
      state.conversations = [];
      state.active = null;
      state.activeId = '';
      renderHistory();
      $('aiConversationTitle').textContent = 'Sign in to use AI Studio';
      updateStatus('Account required', false);
      renderThread();
      syncComposer();
      return;
    }
    const requestToken = sessionToken();
    try {
      const data = await api('/api/ai/conversations');
      if (!requestToken || requestToken !== sessionToken() || state.sharedView) return;
      state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
      renderHistory();
      if (state.activeId && state.conversations.some(item => item.id === state.activeId)) {
        await openConversation(state.activeId, false);
      } else if (state.conversations.length) {
        await openConversation(state.conversations[0].id, false);
      } else {
        await newConversation();
      }
    } catch (error) {
      state.conversations = [];
      renderHistory();
      $('aiConversationTitle').textContent = 'Private AI workspace';
      showModeNotice(error.message + ' Use the login screen to restore your temporary account.', true, 'error');
      syncComposer();
    }
  }

  async function newConversation() {
    if (state.sharedView || !sessionToken() || state.busy) return;
    const requestToken = sessionToken();
    try {
      const data = await api('/api/ai/conversations', { method: 'POST', body: {} });
      if (!requestToken || requestToken !== sessionToken() || state.sharedView) return;
      state.activeId = data.conversation.id;
      state.active = data.conversation;
      $('aiConversationTitle').textContent = state.active.title || 'New conversation';
      $('aiInput').value = '';
      $('aiInput').style.height = 'auto';
      showModeNotice('', false);
      await refreshConversationListOnly();
      renderThread();
      syncComposer();
      $('aiInput').focus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function refreshConversationListOnly() {
    if (state.sharedView || !sessionToken()) return;
    const requestToken = sessionToken();
    try {
      const data = await api('/api/ai/conversations');
      if (!requestToken || requestToken !== sessionToken() || state.sharedView) return;
      state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
      renderHistory();
    } catch (_) {}
  }

  async function openConversation(id, focusInput = true) {
    if (state.sharedView || !sessionToken() || state.busy) return;
    const requestToken = sessionToken();
    try {
      const data = await api('/api/ai/conversations/' + encodeURIComponent(id));
      if (!requestToken || requestToken !== sessionToken() || state.sharedView) return;
      state.activeId = data.conversation.id;
      state.active = data.conversation;
      $('aiConversationTitle').textContent = state.active.title || 'New conversation';
      $('aiInput').value = '';
      $('aiInput').style.height = 'auto';
      showModeNotice('', false);
      renderHistory();
      renderThread();
      syncComposer();
      if (focusInput) $('aiInput').focus();
    } catch (error) {
      toast(error.message, 'error');
      await refreshConversationListOnly();
    }
  }

  async function deleteConversation(id) {
    if (state.sharedView || !sessionToken() || state.busy) return;
    const item = state.conversations.find(entry => entry.id === id);
    const label = item && item.title ? item.title : 'this conversation';
    if (!window.confirm('Delete "' + label + '"? Any share link for this conversation will also stop working. This cannot be undone.')) return;
    try {
      await api('/api/ai/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.activeId === id) {
        state.activeId = '';
        state.active = null;
      }
      await refreshConversationListOnly();
      if (!state.activeId && state.conversations.length) await openConversation(state.conversations[0].id, false);
      else if (!state.activeId) await newConversation();
      toast('Conversation deleted.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function shareConversation() {
    if (state.sharedView || !state.active || !state.active.messages.length) return;
    if (!window.confirm('Anyone who receives this link can read the messages in this shared snapshot. The rest of your private AI history stays private. Share this conversation?')) return;
    try {
      const result = await api('/api/ai/conversations/' + encodeURIComponent(state.active.id) + '/share', { method: 'POST', body: {} });
      state.active.shareId = result.id;
      const url = location.origin + '/?room=ai&share=' + encodeURIComponent(result.id);
      try {
        await navigator.clipboard.writeText(url);
        toast('Share link copied. It expires in 7 days; use Stop sharing to revoke it.', 'success', 7000);
      } catch (_) {
        window.prompt('Copy this share link. Anyone with it can read the shared snapshot:', url);
      }
      await refreshConversationListOnly();
      syncComposer();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function stopSharing() {
    if (!state.active || !state.active.shareId) return;
    try {
      await api('/api/ai/shares/' + encodeURIComponent(state.active.shareId), { method: 'DELETE' });
      state.active.shareId = null;
      await refreshConversationListOnly();
      syncComposer();
      toast('The share link has been revoked.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function setBusy(value, label = 'Thinking…') {
    state.busy = value;
    $('aiWorkingText').textContent = label;
    $('aiWorking').hidden = !value;
    syncComposer();
  }

  async function submitPrompt() {
    const prompt = $('aiInput').value.trim();
    if (!prompt || state.busy || state.sharedView) return;
    if (!sessionToken()) {
      toast('Sign in to use your private AI workspace.', 'error');
      return;
    }
    if (!state.available) {
      showModeNotice('Text AI is not configured on the server. Your prompt was not sent.', true, 'error');
      return;
    }
    if (!state.activeId) await newConversation();
    if (!state.activeId) return;
    $('aiInput').value = '';
    $('aiInput').style.height = 'auto';
    const requestToken = sessionToken();
    const conversationId = state.activeId;
    const version = ++state.requestVersion;
    const controller = new AbortController();
    state.abortController = controller;
    setBusy(true, 'Thinking through your question…');
    showModeNotice('', false);
    try {
      const result = await api('/api/ai/chat', {
        method: 'POST',
        body: { conversationId, message: prompt },
        signal: controller.signal
      });
      if (version !== state.requestVersion || !requestToken || requestToken !== sessionToken() || state.activeId !== conversationId) return;
      state.active = result.conversation;
      $('aiConversationTitle').textContent = state.active.title || 'New conversation';
      await refreshConversationListOnly();
      if (version === state.requestVersion && requestToken === sessionToken()) renderThread();
    } catch (error) {
      if (error.name === 'AbortError' || version !== state.requestVersion || requestToken !== sessionToken()) return;
      $('aiInput').value = prompt;
      showModeNotice(error.message, true, 'error');
    } finally {
      if (version === state.requestVersion) {
        state.abortController = null;
        setBusy(false);
      }
    }
  }

  async function loadSharedConversation() {
    $('aiSidebar').hidden = true;
  }

  async function initSharedView() {
    state.sharedView = true;
    $('aiSidebar').hidden = true;
    $('aiShareBanner').hidden = false;
    $('aiNewChat').hidden = true;
    $('aiShareBtn').hidden = true;
    $('aiStopShareBtn').hidden = true;
    $('aiDeleteBtn').hidden = true;
    $('aiImageLink').hidden = true;
    $('aiComposer').hidden = true;
    $('aiBreadcrumb').textContent = 'SHARED CONVERSATION';
    $('aiComposerHint').textContent = 'Read only';
    try {
      const data = await api('/api/ai/share/' + encodeURIComponent(shareId));
      state.share = data;
      $('aiConversationTitle').textContent = data.title || 'Shared AI conversation';
      $('aiStatusText').textContent = 'Read-only share link';
      $('aiStatusDot').classList.add('is-ready');
      $('aiPrivateBadge').textContent = '↗ Shared';
      $('aiPrivateBadge').classList.add('is-shared');
      const until = new Date(data.expiresAt);
      $('aiShareBanner').querySelector('p').textContent = 'This is a read-only snapshot. It expires on ' + until.toLocaleString() + '. It does not grant access to the owner’s private chat history.';
      renderThread();
    } catch (error) {
      $('aiConversationTitle').textContent = 'Shared conversation unavailable';
      updateStatus('Share link expired or revoked', false);
      showModeNotice(error.message, true, 'error');
      renderThread();
    }
  }

  $('aiNewChat').addEventListener('click', () => newConversation());
  $('aiShareBtn').addEventListener('click', () => shareConversation());
  $('aiStopShareBtn').addEventListener('click', () => stopSharing());
  $('aiDeleteBtn').addEventListener('click', () => { if (state.activeId) deleteConversation(state.activeId); });
  $('aiComposer').addEventListener('submit', event => { event.preventDefault(); submitPrompt(); });
  $('aiInput').addEventListener('input', () => {
    $('aiInput').style.height = 'auto';
    $('aiInput').style.height = Math.min($('aiInput').scrollHeight, 150) + 'px';
    syncComposer();
  });
  $('aiInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('aiComposer').requestSubmit();
    }
  });
  $('aiThread').addEventListener('click', event => {
    const starter = event.target.closest('[data-starter]');
    if (starter && !state.sharedView) {
      $('aiInput').value = starter.dataset.starter || '';
      $('aiInput').focus();
      $('aiInput').dispatchEvent(new Event('input'));
    }
  });

  // Keep the status current when an administrator pauses/resumes AI from another panel or tab.
  setInterval(() => { if (!state.sharedView) checkStatus(); }, 20000);

  window.addEventListener('server-chat:account-ready', () => {
    if (!state.sharedView) {
      checkStatus();
      loadConversations();
    }
  });
  window.addEventListener('server-chat:session-ended', () => {
    if (state.sharedView) return;
    state.requestVersion++;
    if (state.abortController) state.abortController.abort();
    state.abortController = null;
    state.busy = false;
    $('aiWorking').hidden = true;
    showModeNotice('', false);
    state.conversations = [];
    state.active = null;
    state.activeId = '';
    $('aiInput').value = '';
    $('aiInput').style.height = 'auto';
    renderHistory();
    renderThread();
    $('aiConversationTitle').textContent = 'Sign in to use AI Studio';
    updateStatus('Account required', false);
    syncComposer();
  });

  if (state.sharedView) {
    initSharedView();
  } else {
    checkStatus();
    if (sessionToken()) loadConversations();
    else {
      $('aiConversationTitle').textContent = 'Sign in to use AI Studio';
      updateStatus('Account required', false);
      renderThread();
      syncComposer();
    }
  }
})();