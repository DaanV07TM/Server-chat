(() => {
  'use strict';
  const messages = [];
  let available = false;
  let sending = false;
  let typingNode = null;
  let activeController = null;
  const root = document.createElement('div');
  root.id = 'builtInAiRoot';
  root.innerHTML = `
    <button class="ai-launcher" id="aiLauncher" type="button" aria-expanded="false" aria-controls="aiPanel">
      <span class="ai-launcher-mark" aria-hidden="true">✦</span><span>Chat AI</span>
    </button>
    <section class="ai-panel" id="aiPanel" role="dialog" aria-modal="false" aria-labelledby="aiTitle">
      <header class="ai-header">
        <div class="ai-avatar" aria-hidden="true">✦</div>
        <div class="ai-heading"><h2 class="ai-title" id="aiTitle">Server Chat AI</h2><div class="ai-subtitle"><span class="ai-dot" id="aiDot"></span><span id="aiStatus">Verbinding controleren…</span></div></div>
        <button class="ai-icon-button" id="aiClear" type="button" title="Nieuw gesprek" aria-label="Nieuw gesprek">↻</button>
        <button class="ai-icon-button" id="aiClose" type="button" title="Sluiten" aria-label="Sluiten">×</button>
      </header>
      <div class="ai-privacy"><strong>Jouw privacy:</strong> de AI leest geen chats of privékanalen automatisch mee. Alleen tekst die je hier verstuurt, wordt doorgestuurd naar de AI-dienst.</div>
      <div class="ai-messages" id="aiMessages" aria-live="polite" aria-relevant="additions text">
        <div class="ai-welcome" id="aiWelcome"><h3>Waar kan ik je mee helpen?</h3><p>Stel een vraag, laat iets uitleggen of werk samen aan een idee.</p>
          <div class="ai-suggestions">
            <button class="ai-suggestion" type="button" data-prompt="Leg dit eenvoudig uit, stap voor stap.">Leg iets uit</button>
            <button class="ai-suggestion" type="button" data-prompt="Help me een vriendelijk en duidelijk bericht te schrijven.">Help met schrijven</button>
            <button class="ai-suggestion" type="button" data-prompt="Geef me vijf originele ideeën om Server Chat beter te maken.">Ideeën voor de chatapp</button>
          </div>
        </div>
      </div>
      <div class="ai-composer-wrap">
        <form class="ai-composer" id="aiForm">
          <textarea class="ai-input" id="aiInput" rows="1" maxlength="2500" placeholder="Vraag iets aan de AI…" aria-label="Bericht aan de AI"></textarea>
          <button class="ai-send" id="aiSend" type="submit" aria-label="Verstuur bericht">↑</button>
        </form>
        <p class="ai-footnote" id="aiFootnote">AI-antwoorden kunnen fouten bevatten. Deel geen wachtwoorden of gevoelige gegevens.</p>
      </div>
    </section>`;
  document.body.appendChild(root);

  const $ = id => document.getElementById(id);
  const launcher = $('aiLauncher'), panel = $('aiPanel'), input = $('aiInput'), sendButton = $('aiSend');
  const feed = $('aiMessages'), status = $('aiStatus'), dot = $('aiDot'), footnote = $('aiFootnote');
  const setOpen = open => {
    panel.classList.toggle('is-open', open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.innerHTML = open
      ? '<span class="ai-launcher-mark" aria-hidden="true">✦</span><span>AI sluiten</span>'
      : '<span class="ai-launcher-mark" aria-hidden="true">✦</span><span>Chat AI</span>';
    if (open) setTimeout(() => input.focus(), 30);
  };
  const scrollFeed = () => { feed.scrollTop = feed.scrollHeight; };
  const addMessage = (role, text, isError = false) => {
    const node = document.createElement('div');
    node.className = 'ai-message ' + role + (isError ? ' error' : '');
    node.textContent = text;
    feed.appendChild(node);
    scrollFeed();
    return node;
  };
  const setStatus = (text, ready) => {
    status.textContent = text;
    dot.classList.toggle('is-ready', !!ready);
    available = !!ready;
    input.placeholder = ready ? 'Vraag iets aan de AI…' : 'AI nog niet geconfigureerd';
    sendButton.disabled = !ready || sending;
    if (!ready) footnote.textContent = 'De beheerder moet GROQ_API_KEY instellen op de server. De sleutel hoort nooit in je browser.';
    else footnote.textContent = 'AI-antwoorden kunnen fouten bevatten. Deel geen wachtwoorden of gevoelige gegevens.';
  };
  const checkStatus = async () => {
    try {
      const response = await fetch('/api/ai/status', {headers:{'Accept':'application/json'}, cache:'no-store'});
      const data = await response.json();
      if (data && data.available) setStatus('Klaar om te helpen', true);
      else setStatus('Nog niet ingesteld', false);
    } catch (_) { setStatus('AI-server niet bereikbaar', false); }
  };
  const setBusy = busy => {
    sending = busy;
    sendButton.disabled = busy || !available;
    input.disabled = busy || !available;
    if (busy) {
      typingNode = document.createElement('div');
      typingNode.className = 'ai-message assistant';
      typingNode.setAttribute('aria-label','AI is aan het antwoorden');
      typingNode.innerHTML = '<span class="ai-typing"><span></span><span></span><span></span></span>';
      feed.appendChild(typingNode);
      scrollFeed();
    } else if (typingNode) { typingNode.remove(); typingNode = null; }
  };
  const submit = async text => {
    const prompt = String(text || input.value || '').trim();
    if (!prompt || sending) return;
    if (!available) {
      addMessage('assistant', 'De ingebouwde AI is nog niet geactiveerd. De beheerder moet eerst een Groq API-sleutel instellen op de server.', true);
      return;
    }
    if (prompt.length > 2500) return;
    $('aiWelcome').hidden = true;
    addMessage('user', prompt);
    input.value = '';
    input.style.height = 'auto';
      messages.push({role:'user', content:prompt});
    setBusy(true);
    try {
      activeController = new AbortController();
      const requestController = activeController;
      const response = await fetch('/api/ai/chat', {
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        cache:'no-store',
        signal:requestController.signal,
        body:JSON.stringify({messages: (() => {
          const context = messages.slice(-10).map(item => ({
            role: item.role,
            content: item.content.length > 2300 ? item.content.slice(0, 2300) : item.content
          }));
          while (context.length > 1 && context.reduce((sum, item) => sum + item.content.length, 0) > 10000) context.shift();
          return context;
        })()})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429) throw new Error('De AI heeft tijdelijk zijn gebruikslimiet bereikt. Probeer het later opnieuw.');
        if (response.status === 503) throw new Error('De ingebouwde AI is nog niet ingesteld door de beheerder.');
        throw new Error(data.error || 'De AI kon nu niet antwoorden. Probeer het straks opnieuw.');
      }
      if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('De AI stuurde een leeg antwoord. Probeer het opnieuw.');
      messages.push({role:'assistant', content:data.reply.slice(0, 2300)});
      addMessage('assistant', data.reply);
    } catch (error) {
      // An account logout/deletion can clear the in-memory conversation and abort the pending request.
      if (error && error.name === 'AbortError') return;
      // Don't let a failed request remain in the local conversation context.
      if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
      addMessage('assistant', error && error.message ? error.message : 'Er ging iets mis.', true);
    } finally {
      activeController = null;
      setBusy(false);
      if (available) input.focus();
    }
  };
  launcher.addEventListener('click', () => setOpen(!panel.classList.contains('is-open')));
  $('aiClose').addEventListener('click', () => setOpen(false));
  $('aiClear').addEventListener('click', () => {
    messages.length = 0;
    feed.innerHTML = '<div class="ai-welcome" id="aiWelcome"><h3>Nieuw gesprek</h3><p>Waar wil je samen naar kijken?</p><div class="ai-suggestions"><button class="ai-suggestion" type="button" data-prompt="Leg dit eenvoudig uit, stap voor stap.">Leg iets uit</button><button class="ai-suggestion" type="button" data-prompt="Help me een vriendelijk en duidelijk bericht te schrijven.">Help met schrijven</button><button class="ai-suggestion" type="button" data-prompt="Geef me vijf originele ideeën om Server Chat beter te maken.">Ideeën voor de chatapp</button></div></div>';
  });
  $('aiForm').addEventListener('submit', event => { event.preventDefault(); submit(); });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 118) + 'px';
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('aiForm').requestSubmit();
    }
    if (event.key === 'Escape') setOpen(false);
  });
  feed.addEventListener('click', event => {
    const suggestion = event.target.closest('[data-prompt]');
    if (suggestion) { input.value = suggestion.dataset.prompt || ''; input.focus(); input.dispatchEvent(new Event('input')); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.classList.contains('is-open')) setOpen(false);
  });
  // AI chat history exists only in this page's memory. Clear it whenever an account session ends.
  window.addEventListener('server-chat:session-ended', () => {
    if (activeController) activeController.abort();
    activeController = null;
    messages.length = 0;
    input.value = '';
    input.style.height = 'auto';
    if (typingNode) { typingNode.remove(); typingNode = null; }
    sending = false;
    sendButton.disabled = !available;
    input.disabled = !available;
    feed.innerHTML = '<div class="ai-welcome" id="aiWelcome"><h3>Fresh start</h3><p>Your previous AI conversation has been cleared.</p><div class="ai-suggestions"><button class="ai-suggestion" type="button" data-prompt="Leg dit eenvoudig uit, stap voor stap.">Leg iets uit</button><button class="ai-suggestion" type="button" data-prompt="Help me een vriendelijk en duidelijk bericht te schrijven.">Help met schrijven</button><button class="ai-suggestion" type="button" data-prompt="Geef me vijf originele ideeën om Server Chat beter te maken.">Ideeën voor de chatapp</button></div></div>';
  });
  // No channel/socket transcript is read here. The AI only receives this panel's explicit prompts.
  checkStatus();
})();