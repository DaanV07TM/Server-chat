(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = '/api/server-status';
  let lastSuccessfulCheck = 0;
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  function formatUptime(seconds) {
    let value = Math.max(0, Math.floor(number(seconds)));
    const days = Math.floor(value / 86400); value %= 86400;
    const hours = Math.floor(value / 3600); value %= 3600;
    const minutes = Math.floor(value / 60);
    return (days ? days + 'd ' : '') + (hours ? hours + 'h ' : '') + minutes + 'm';
  }
  function setText(id, value) { const node = $(id); if (node) node.textContent = String(value); }
  function setMeter(valueId, barId, detailId, value, rawValue, detail) {
    const pct = Math.max(0, Math.min(100, number(value)));
    setText(valueId, rawValue);
    setText(detailId, detail);
    const bar = $(barId);
    if (bar) {
      bar.style.width = pct + '%';
      bar.dataset.tone = pct >= 95 ? 'critical' : pct >= 80 ? 'warning' : 'normal';
    }
  }
  function setOverall(level, text) {
    const pill = $('overallStatus');
    if (pill) pill.dataset.state = level || 'unknown';
    setText('overallStatusText', text);
  }
  function renderWarnings(warnings) {
    const root = $('warnings');
    root.replaceChildren();
    const rows = Array.isArray(warnings) ? warnings : [];
    for (const item of rows) {
      const level = ['critical','warning','healthy','info'].includes(item.level) ? item.level : 'info';
      const row = document.createElement('div');
      row.className = 'warning ' + level;
      const icon = document.createElement('span');
      icon.className = 'warning-icon';
      icon.textContent = level === 'critical' ? '🚨' : level === 'warning' ? '⚠️' : level === 'healthy' ? '✅' : 'ℹ️';
      const copy = document.createElement('span');
      const title = document.createElement('b');
      title.textContent = item.title || 'Server status';
      const detail = document.createElement('small');
      detail.textContent = item.detail || '';
      copy.append(title, detail);
      row.append(icon, copy);
      root.appendChild(row);
    }
    if (!root.children.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No current resource alerts.';
      root.appendChild(empty);
    }
  }
  function renderChannels(channels) {
    const root = $('channels');
    root.replaceChildren();
    const rows = Array.isArray(channels) ? channels : [];
    for (const item of rows) {
      const online = number(item.online);
      const row = document.createElement('div');
      row.className = 'channel';
      row.dataset.active = online > 0 ? 'true' : 'false';
      const name = document.createElement('span');
      name.className = 'channel-name';
      const dot = document.createElement('i');
      dot.className = 'channel-dot';
      const label = document.createElement('span');
      label.textContent = item.label || item.key || 'Channel';
      name.append(dot, label);
      const count = document.createElement('span');
      count.className = 'channel-count';
      count.textContent = online + (online === 1 ? ' online' : ' online');
      row.append(name, count);
      root.appendChild(row);
    }
    if (!root.children.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No channel metrics available.';
      root.appendChild(empty);
    }
  }
  function renderActivity(activity) {
    const root = $('activity');
    root.replaceChildren();
    const rows = Array.isArray(activity) ? activity : [];
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'activity';
      const time = document.createElement('time');
      time.textContent = item.t ? new Date(number(item.t)).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '—';
      const copy = document.createElement('span');
      copy.className = 'activity-message';
      const tag = document.createElement('b');
      tag.className = 'category';
      tag.textContent = String(item.category || 'system').toUpperCase();
      const message = document.createElement('span');
      message.textContent = item.message || '';
      copy.append(tag, message);
      row.append(time, copy);
      root.appendChild(row);
    }
    if (!root.children.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No recent service events yet.';
      root.appendChild(empty);
    }
  }
  function render(data, latencyMs) {
    const load = data.load || {};
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    const hard = warnings.some(item => item.level === 'critical');
    const soft = warnings.some(item => item.level === 'warning');
    const level = hard ? 'critical' : soft ? 'warning' : load.level === 'unknown' ? 'unknown' : 'healthy';
    const levelText = hard ? 'Critical resource warning' : soft ? 'High resource usage' : load.level === 'unknown' ? 'Collecting data' : 'All systems operational';
    setOverall(level, levelText);
    setText('onlineUsers', number(data.online));
    setText('activeChannels', number(data.activeChannels));
    setText('uptime', formatUptime(data.uptimeSeconds));
    setText('loadLabel', level === 'critical' ? 'Critical' : level === 'warning' ? 'High' : load.level === 'unknown' ? 'Checking' : 'Normal');
    setText('loadSubline', 'CPU ' + number(load.cpuPct) + '% · heap ' + number(load.heapPct) + '%');
    const safeLatency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null;
    const latencyQuality = safeLatency === null ? 'unknown' : safeLatency < 80 ? 'good' : safeLatency < 180 ? 'moderate' : safeLatency < 350 ? 'slow' : 'poor';
    const latencyLabel = safeLatency === null ? 'Unavailable' : safeLatency + ' ms';
    const latencyDescription = safeLatency === null ? 'Waiting for a successful status response.' :
      safeLatency < 80 ? 'Excellent response time from this browser to Server Chat.' :
      safeLatency < 180 ? 'Good response time from this browser to Server Chat.' :
      safeLatency < 350 ? 'Slower response; check your network if chat also feels delayed.' :
      'High response time; the network or server may be slow.';
    setText('networkLatency', latencyLabel);
    setText('networkLatencyQuality', latencyDescription);
    const latencyCard = $('networkLatencyCard');
    if (latencyCard) latencyCard.dataset.quality = latencyQuality;
    setText('resourceLevel', String(load.level || 'unknown').toUpperCase());
    const cpu = number(load.cpuPct);
    setMeter('cpuValue','cpuBar','cpuDetail',cpu,cpu + '%',load.cpuReady ? 'Node.js process use of one CPU core.' : 'Waiting for the first CPU sample.');
    const ramHasLimit = load.rssPct !== null && load.rssPct !== undefined && Number.isFinite(Number(load.rssPct));
    setMeter('ramValue','ramBar','ramDetail',ramHasLimit ? load.rssPct : 0,
      number(load.rssMB) + ' MB',
      ramHasLimit ? number(load.rssMB) + ' MB RSS out of ' + number(load.memoryLimitMB) + ' MB container limit.' : number(load.rssMB) + ' MB RSS; container RAM limit is unavailable.');
    setMeter('heapValue','heapBar','heapDetail',load.heapPct,number(load.heapUsedMB) + ' MB',
      number(load.heapUsedMB) + ' MB used out of ' + number(load.heapLimitMB) + ' MB JavaScript heap.');
    renderWarnings(warnings);
    renderChannels(data.channels);
    renderActivity(data.activity);
    const checked = data.checkedAt ? new Date(number(data.checkedAt)).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
    setText('lastChecked', 'Last checked: ' + checked);
    setText('refreshState', 'Auto-refreshes every 15 seconds · Last successful check ' + checked);
    $('connectionError').classList.remove('show');
    lastSuccessfulCheck = Date.now();
  }
  async function refresh() {
    if (document.visibilityState === 'hidden') return;
    try {
      const startedAt = performance.now();
      const response = await fetch(API, { cache:'no-store', headers:{ Accept:'application/json' }, signal:AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Status endpoint returned ' + response.status);
      const data = await response.json();
      if (!data || data.ok !== true || !data.load) throw new Error('Invalid status response');
      render(data, performance.now() - startedAt);
    } catch (_) {
      if (!lastSuccessfulCheck) setOverall('offline','Status unavailable');
      $('connectionError').classList.add('show');
      setText('refreshState','Connection issue · retrying automatically');
    }
  }
  refresh();
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
})();