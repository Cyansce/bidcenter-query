const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 14) {
  console.error(`当前 Node.js ${process.version} 不符合项目要求：请使用 Node.js >=24.14.0 <25。`);
  console.error('请在项目目录执行 nvm install && nvm use，再执行 npm run start。');
  console.error('若已执行 nvm use 仍显示旧版本，请执行 export PATH="$NVM_BIN:$PATH"，再用 node -v 确认。');
  console.error('依赖安装、构建和启动必须使用同一 Node.js 主版本，否则 SQLite 原生模块可能加载失败。');
  process.exitCode = 1;
}
