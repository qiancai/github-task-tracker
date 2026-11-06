import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
const target = 'dist/github-task-tracker-0.1.0.zip';
await rm(target, { force: true });
execFileSync('zip', ['-r', target, 'manifest.json', 'settings.html', 'tasks.html', 'src', 'icons', 'docs', 'LICENSE', 'README.md', 'PRIVACY.md'], { stdio: 'inherit' });
console.log(`Packaged ${target}`);
