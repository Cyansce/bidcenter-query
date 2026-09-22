'use strict';
const $ = id => document.getElementById(id);
let connected = false; let projectsLoaded = false; let page = 1; let totalPages = 1; let refreshing = false; let actionRunning = false;
let latestStatus; let latestRuns = [];
const runNames = { QUEUED: '排队中', RUNNING: '采集中', WAITING_LOGIN: '等待登录', WAITING_HUMAN: '等待人工验证', WAITING_COOLDOWN: '等待冷却', RETRY_WAIT: '等待重试', CANCELLED: '已取消', FAILED: '失败', SUCCEEDED: '已完成', PARTIAL: '部分完成' };
const authNames = { AUTHENTICATED: '已登录', SESSION_SAVED: '已保存登录态', LOGIN_REQUIRED: '等待登录', MANUAL_LOGIN: '等待网页登录', PASSWORD_READY: '等待网页登录', READY_TO_SEND_SMS: '等待短信登录', WAITING_SMS_OR_CAPTCHA: '等待网页登录', VERIFYING: '检查登录中', HUMAN_REQUIRED: '等待人工验证', LOGIN_ACTION_REQUIRED: '需要检查登录窗口', COOLDOWN: '等待冷却', TRANSIENT: '稍后重试登录检查' };
const cancellable = ['QUEUED', 'WAITING_LOGIN', 'WAITING_HUMAN', 'WAITING_COOLDOWN', 'RETRY_WAIT'];
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(Array.isArray(result.message) ? result.message.join('；') : result.message || '请求失败');
  return result;
}
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未披露';
async function action(fn) {
  if (actionRunning) return;
  actionRunning = true; updateButtons();
  try { const result = await fn(); $('message').textContent = result?.message || '操作已完成'; await refresh(); }
  catch (e) { $('message').textContent = e.message; }
  finally { actionRunning = false; updateButtons(); }
}
function updateButtons() { document.querySelectorAll('button').forEach(button => { button.disabled = actionRunning || (!connected && button.id !== 'closeDetail'); }); }
function queueMessage(status, runs) {
  if (status.pacing.humanRequired || status.auth.state === 'HUMAN_REQUIRED') return '采集已暂停：请在弹出的验证页面完成验证，系统识别后自动继续。';
  if (status.pacing.pausedUntil) return `网站访问暂时冷却，${date(status.pacing.pausedUntil)} 后自动继续。`;
  if (status.auth.blocked || ['LOGIN_REQUIRED', 'MANUAL_LOGIN', 'PASSWORD_READY', 'READY_TO_SEND_SMS', 'WAITING_SMS_OR_CAPTCHA', 'VERIFYING', 'LOGIN_ACTION_REQUIRED'].includes(status.auth.state)) return status.auth.browserOpen ? '正在等待浏览器登录完成。登录成功后自动开始，已排队的任务无需重新提交。' : '采集等待登录。请打开登录窗口，登录成功后任务会自动继续。';
  const running = runs.some(run => run.status === 'RUNNING');
  const queued = runs.filter(run => run.status === 'QUEUED').length;
  if (running) return `正在采集${queued ? `，另有 ${queued} 个任务排队` : ''}。重复任务可在下方取消或删除。`;
  if (queued) return `${queued} 个任务等待调度，约 5 秒内开始。`;
  return '可以开始采集；任务会自动排队执行。';
}
function renderRuns(runs, status) {
  $('runs').replaceChildren();
  if (!runs.length) { $('runs').textContent = '暂无任务，输入查询词后开始采集。'; return; }
  for (const run of runs) {
    const row = document.createElement('article'); row.className = 'run-card'; row.dataset.runId = run.id;
    const heading = document.createElement('div'); heading.className = 'section-heading';
    const title = document.createElement('strong'); title.textContent = JSON.parse(run.queriesJson).join(' · ');
    const badge = document.createElement('span'); badge.className = `badge ${run.status === 'RUNNING' ? 'active' : ''}`; badge.textContent = runNames[run.status] || run.status;
    heading.append(title, badge); row.append(heading);
    const meta = document.createElement('p'); meta.className = 'hint'; meta.textContent = `${run.trigger === 'daily' ? '每日采集' : '手动采集'} · ${date(run.createdAt)} · 已完成 ${run.pagesCollected} / ${run.maxPages} 页 · 已保存详情 ${run.saved} 条${run.restricted ? `，其中 ${run.restricted} 条受限` : ''}`; row.append(meta);
    const note = document.createElement('p');
    note.textContent = run.status === 'QUEUED' ? queueMessage(status, runs) : run.status === 'CANCELLED' ? '已取消，不再执行。已采集的项目保留。' : [run.lastError, run.nextAttemptAt ? '预计恢复：' + date(run.nextAttemptAt) : '', ...JSON.parse(run.warningsJson)].filter(Boolean).join('；');
    if (note.textContent) row.append(note);
    const actions = document.createElement('div'); actions.className = 'actions';
    const button = (label, handler, className = '') => { const item = document.createElement('button'); item.textContent = label; item.className = className; item.onclick = () => action(handler); actions.append(item); };
    if (cancellable.includes(run.status)) button('取消任务', () => api(`runs/${run.id}/cancel`, {}));
    if (['FAILED', 'RETRY_WAIT'].includes(run.status)) button('从断点重试', () => api(`runs/${run.id}/resume`, {}));
    if (run.status !== 'RUNNING') button('删除任务', () => api(`runs/${run.id}`, undefined, 'DELETE'), 'danger');
    if (actions.childElementCount) row.append(actions);
    $('runs').append(row);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [status, runs, notifications] = await Promise.all([api('status'), api('runs'), api('notifications')]);
    latestStatus = status; latestRuns = runs;
    connected = true;
    $('connection').textContent = '已连接';
    $('managedControls').hidden = status.auth.browserMode === 'chrome-manual';
    $('auth').textContent = [status.auth.account || status.auth.phone, status.auth.message].filter(Boolean).join(' · ');
    $('authState').textContent = authNames[status.auth.state] || '正在检查';
    $('authState').className = `badge ${['AUTHENTICATED', 'SESSION_SAVED'].includes(status.auth.state) && !status.auth.blocked ? 'active' : ''}`;
    $('queueHint').textContent = queueMessage(status, runs);
    $('queueSummary').textContent = `最近 ${runs.length} 个任务 · ${runs.filter(run => run.status === 'RUNNING').length} 个运行中 · ${runs.filter(run => run.status === 'QUEUED').length} 个排队`;
    $('run').textContent = runs.some(run => run.status === 'RUNNING') ? '加入采集队列' : '立即采集';
    $('search').textContent = `当前：${status.search.mode === 'combined' ? '组合查询 ' + status.search.combinedQuery : '分别查询 ' + status.search.keywords.join('、')}；每任务最多 ${status.search.maxPagesPerRun} 页；已保存 ${status.count} 条`;
    const pacing = status.pacing;
    const batchBreak = pacing.batchSize > 0 && pacing.breakMaxMs > 0
      ? `每 ${pacing.batchSize} 次额外休息 ${pacing.breakMinMs / 1000}–${pacing.breakMaxMs / 1000} 秒`
      : '无批次额外休息';
    $('pacing').textContent = `响应后间隔 ${pacing.minIntervalMs / 1000}–${pacing.maxIntervalMs / 1000} 秒；${batchBreak}。${pacing.pausedUntil ? '冷却至 ' + date(pacing.pausedUntil) + '。' : ''}`;
    renderRuns(runs, status);
    $('notifications').replaceChildren(...notifications.slice(0, 15).map(item => { const li = document.createElement('li'); li.textContent = `${date(item.createdAt)} ${item.message}`; return li; }));
    if (!projectsLoaded) await loadProjects();
  } catch (e) {
    connected = false;
    $('connection').textContent = `连接失败，正在自动重试：${e.message}`;
    throw e;
  } finally { refreshing = false; updateButtons(); }
}
async function loadProjects() {
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if ($('keyword').value) params.set('keyword', $('keyword').value);
  if ($('valid').checked) params.set('validOnly', 'true');
  const result = await api(`projects?${params}`);
  totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  $('pagination').textContent = `${page} / ${totalPages} 页，共 ${result.total} 条`;
  $('projects').replaceChildren();
  for (const item of result.items) {
    const tr = document.createElement('tr'); const title = document.createElement('td');
    const button = document.createElement('button'); button.textContent = item.title;
    button.onclick = () => action(async () => { const detail = await api(`projects/${item.id}`); $('detailText').textContent = `${detail.title}\n${detail.sourceUrl}\n\n报名/文件截止：${date(detail.fileDeadline)}\n响应/投标截止：${date(detail.bidDeadline)}\n预算：${detail.budgetRaw || '未披露'}\n采购方式：${detail.procurementMethod || '未披露'}\n采购人：${detail.buyer || '未披露'}\n代理机构：${detail.agency || '未披露'}\n项目编号：${detail.projectNumber || '未披露'}\n来源：${detail.sourceWebsite || '未披露'}\n原始链接：${detail.originalUrl || detail.sourceUrl}\nPDF：${detail.pdfUrl || '未提供'}\n联系人：${JSON.stringify(detail.contacts, null, 2)}\n附件：${JSON.stringify(detail.attachments, null, 2)}\n项目进展：${JSON.stringify(detail.timeline, null, 2)}\n标签：${JSON.stringify(detail.tags, null, 2)}\n\n${detail.bodyText || '详情尚未获取'}\n\n日期依据：${JSON.stringify(detail.deadlineEvidence, null, 2)}`; $('detail').showModal(); });
    title.append(button); tr.append(title);
    for (const value of [item.region, date(item.publishedAt), item.budgetYuan || item.budgetRaw || '未披露', date(item.fileDeadline), date(item.bidDeadline), `${item.accessLevel} / ${item.detailStatus}`]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    $('projects').append(tr);
  }
  projectsLoaded = true;
}
$('smsStart').onclick = () => action(() => api('auth/start', { method: 'sms' }));
$('passwordStart').onclick = () => action(() => api('auth/start', { method: 'password' }));
$('sendSms').onclick = () => action(() => api('auth/sms/send', {}));
$('verifySms').onclick = () => action(async () => { const code = $('code').value; $('code').value = ''; return api('auth/sms/verify', { code }); });
$('passwordSubmit').onclick = () => action(() => api('auth/password/submit', {}));
$('challenge').onclick = () => action(() => api('auth/challenge', {}));
$('complete').onclick = () => action(() => api('auth/complete', {}));
$('run').onclick = () => action(async () => {
  const run = await api('runs', $('queries').value.trim() ? { queries: $('queries').value.split('\n').map(s => s.trim()).filter(Boolean) } : {});
  return { message: `任务已加入队列。${latestStatus ? queueMessage(latestStatus, [...latestRuns, run]) : ''}` };
});
$('loadProjects').onclick = () => action(async () => { page = 1; await loadProjects(); });
$('previous').onclick = () => action(async () => { page = Math.max(1, page - 1); await loadProjects(); });
$('next').onclick = () => action(async () => { page = Math.min(totalPages, page + 1); await loadProjects(); });
$('closeDetail').onclick = () => $('detail').close();
updateButtons();
void refresh().catch(() => {});
setInterval(() => { void refresh().catch(() => {}); }, 5000);
