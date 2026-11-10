import { spawn } from 'node:child_process';
import { delimiter, resolve } from 'node:path';

// Keep tool state writable in this isolated cloud checkout; retain proxy/CA env.
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Expected a tool name');
const child = spawn(command, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH || ''}`,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || resolve('.cache'),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || resolve('.cache/config'),
    ASTRO_TELEMETRY_DISABLED: '1',
    WRANGLER_SEND_METRICS: 'false',
  },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
