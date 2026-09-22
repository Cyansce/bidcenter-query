import 'dotenv/config';
import assert from 'node:assert/strict';
const base = `http://127.0.0.1:${process.env.PORT || 3100}`;
const headers = { 'Content-Type': 'application/json' };
for (const [path, status, options] of [
  ['/health', 200, {}], ['/api/status', 200, {}], ['/api/runs', 200, {}],
  ['/api/projects?page=-1', 400, { headers }], ['/api/projects?pageSize=101', 400, { headers }],
  ['/api/projects?from=invalid', 400, { headers }], ['/api/projects?surprise=1', 400, { headers }],
  ['/api/auth/sms/verify', 400, { method: 'POST', headers, body: JSON.stringify({ code: 'bad' }) }],
  ['/api/runs', 400, { method: 'POST', headers, body: JSON.stringify({ queries: [''] }) }], ['/', 200, {}],
]) {
  const result = await fetch(base + path, options);
  assert.equal(result.status, status, path);
  console.log(`${result.status} ${path}`);
}
console.log('HTTP smoke checks passed');
