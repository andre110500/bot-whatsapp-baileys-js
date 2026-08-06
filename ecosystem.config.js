const fs = require('fs');
const path = require('path');

// Node 20 a nivel proyecto (devDependency node-win-x64). PM2 lo usa como
// intérprete para que Baileys (que exige Node 20+) corra con la versión
// correcta aunque el Node global sea 18. En plataformas donde no existe el
// binario local (ej. servidor Linux) se cae a `node` global.
const localNode = path.join(
  __dirname,
  'node_modules',
  'node-win-x64',
  'bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
);

module.exports = {
  apps: [
    {
      name: 'whatsapp-bot-baileys',
      script: path.join(__dirname, 'index.js'),
      cwd: __dirname,
      interpreter: fs.existsSync(localNode) ? localNode : 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
