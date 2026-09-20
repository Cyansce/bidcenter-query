module.exports = {
  apps: [{
    name: 'bidcenter',
    cwd: require('node:path').resolve(__dirname, '..'),
    script: 'dist/main.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,
    max_memory_restart: '800M',
    kill_timeout: 90000,
    time: true,
  }],
};
