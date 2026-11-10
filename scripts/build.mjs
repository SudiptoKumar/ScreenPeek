import { spawn } from 'node:child_process';
async function run(args) {
  const child = spawn(process.execPath, ['scripts/tool.mjs', ...args], { stdio: 'inherit', env: process.env });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) process.exit(typeof code === 'number' ? code : 1);
}
await run(['astro', 'build']);
await run(['node', '--use-env-proxy', 'scripts/static-build.ts']);
