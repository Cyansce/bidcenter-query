'use strict';
const $ = id => document.getElementById(id);
let key = ''; let page = 1; let totalPages = 1; let refreshing = false;
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(Array.isArray(result.message) ? result.message.join('；') : result.message || '请求失败');
  return result;
}
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未披露';
async function action(fn) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  try { const result = await fn(); $('message').textContent = result?.message || '操作已完成'; await refresh(); }
  catch (e) { $('message').textContent = e.message; }
  finally { buttons.forEach(b => b.disabled = false); }
}
async function refresh() {
  if (!key || refreshing) return;
  refreshing = true;
  try {
    const [status, runs, notifications] = await Promise.all([api('status'), api('runs'), api('notifications')]);
    $('connection').textContent = '已连接';
    $('managedControls').hidden = status.auth.browserMode === 'chrome-manual';
    $('auth').textContent = `${status.auth.state} · ${status.auth.phone} · ${status.auth.message}`;
    $('search').textContent = `当前：${status.search.mode === 'combined' ? '组合查询 ' + status.search.combinedQuery : '分别查询 ' + status.search.keywords.join('、')}；已保存 ${status.count} 条`;
    $('runs').replaceChildren();
    for (const run of runs.slice(0, 12)) {
      const row = document.createElement('div');
      row.textContent = `${date(run.createdAt)}  ${run.status}  查询 ${run.queryIndex + 1} / 第 ${run.page} 页  保存详情 ${run.saved} / 受限 ${run.restricted}\n${run.lastError || ''} ${JSON.parse(run.warningsJson).join('；')}\n`;
      if (['FAILED', 'RETRY_WAIT'].includes(run.status)) { const button = document.createElement('button'); button.textContent = '从断点恢复'; button.onclick = () => action(() => api(`runs/${run.id}/resume`, {})); row.append(button); }
      $('runs').append(row);
    }
    $('notifications').replaceChildren(...notifications.slice(0, 15).map(item => { const li = document.createElement('li'); li.textContent = `${date(item.createdAt)} ${item.message}`; return li; }));
  } finally { refreshing = false; }
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
    button.onclick = () => action(async () => { const detail = await api(`projects/${item.id}`); $('detailText').textContent = `${detail.title}\n${detail.sourceUrl}\n\n报名/文件截止：${date(detail.fileDeadline)}\n响应/投标截止：${date(detail.bidDeadline)}\n预算：${detail.budgetRaw || '未披露'}\n采购方式：${detail.procurementMethod || '未披露'}\n联系人：${JSON.stringify(detail.contacts, null, 2)}\n\n${detail.bodyText || '详情尚未获取'}\n\n日期依据：${JSON.stringify(detail.deadlineEvidence, null, 2)}`; $('detail').showModal(); });
    title.append(button); tr.append(title);
    for (const value of [item.region, date(item.publishedAt), item.budgetYuan || item.budgetRaw || '未披露', date(item.fileDeadline), date(item.bidDeadline), `${item.accessLevel} / ${item.detailStatus}`]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    $('projects').append(tr);
  }
}
$('connect').onclick = () => action(async () => { key = $('key').value.trim(); $('key').value = ''; await refresh(); await loadProjects(); });
$('smsStart').onclick = () => action(() => api('auth/start', { method: 'sms' }));
$('passwordStart').onclick = () => action(() => api('auth/start', { method: 'password' }));
$('sendSms').onclick = () => action(() => api('auth/sms/send', {}));
$('verifySms').onclick = () => action(async () => { const code = $('code').value; $('code').value = ''; return api('auth/sms/verify', { code }); });
$('passwordSubmit').onclick = () => action(() => api('auth/password/submit', {}));
$('challenge').onclick = () => action(() => api('auth/challenge', {}));
$('complete').onclick = () => action(() => api('auth/complete', {}));
$('run').onclick = () => action(() => api('runs', $('queries').value.trim() ? { queries: $('queries').value.split('\n').map(s => s.trim()).filter(Boolean) } : {}));
$('loadProjects').onclick = () => action(async () => { page = 1; await loadProjects(); });
$('previous').onclick = () => action(async () => { page = Math.max(1, page - 1); await loadProjects(); });
$('next').onclick = () => action(async () => { page = Math.min(totalPages, page + 1); await loadProjects(); });
$('closeDetail').onclick = () => $('detail').close();
setInterval(() => refresh().catch(e => { $('connection').textContent = e.message; }), 5000);
