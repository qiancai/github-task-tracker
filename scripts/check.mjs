import { readFile, access, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'GitHub Task Tracker');
assert.deepEqual(manifest.permissions, ['storage']);
assert.deepEqual(manifest.host_permissions, ['https://github.com/*']);
const files = [manifest.background.service_worker, manifest.options_page, 'tasks.html', ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(item => item.js)];
for (const file of files) await access(file);
for (const file of await readdir('src')) if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', `src/${file}`]);
console.log('Manifest, extension assets, and JavaScript syntax checked.');
