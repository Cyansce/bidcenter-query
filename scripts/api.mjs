import 'dotenv/config';
const [path = 'status', body] = process.argv.slice(2);
if (!/^[a-z0-9/?=&_%.,:-]+$/i.test(path)) throw new Error('路径无效');
const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3100}/api/${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body }),
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
