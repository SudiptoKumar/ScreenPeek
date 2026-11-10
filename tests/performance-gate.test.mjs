import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('the real performance command exits unsuccessfully for a bloated detail template', { timeout: 90_000 }, async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/tool.mjs', 'node', 'scripts/performance.ts', '--bloat'], { timeout: 85_000, maxBuffer: 1_000_000, env: process.env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /First-screen budget exceeded on \/movie\/.+: \d+ bytes > 100000 bytes/);
    return true;
  });
});
