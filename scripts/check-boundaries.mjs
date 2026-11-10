import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function files(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

const violations = [];
for (const path of [...await files('src'), ...await files('functions'), ...await files('public')]) {
  if (!/\.(?:astro|css|html|[cm]?[jt]sx?)$/.test(path)) continue;
  const source = await readFile(path, 'utf8');
  if (/https?:\/\/(?:api\.themoviedb\.org|image\.tmdb\.org|files\.tmdb\.org)\b/i.test(source)) violations.push(`${path}: source URL in visitor runtime`);
  const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g);
  for (const match of imports) if (/(^|\/)sync(?:\/|$)/.test(match[1])) violations.push(`${path}: sync import in visitor runtime`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log('Visitor source boundary check passed: no source URLs or sync imports.');
