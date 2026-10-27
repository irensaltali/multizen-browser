import { readFileSync, writeFileSync } from 'node:fs';
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) throw new Error('Usage: yarn release:version 0.4.4');
const paths = ['package.json', 'apps/desktop/package.json'];
const packages = paths.map(path => JSON.parse(readFileSync(path, 'utf8')));
const current = packages[1].version.split('.').map(Number);
const target = next.split('.').map(Number);
const changedIndex = target.findIndex((n, i) => n !== current[i]);
if (changedIndex < 0 || target[changedIndex] < current[changedIndex]) throw new Error('Release version must increase');
packages.forEach((pkg, i) => {
  pkg.version = next;
  writeFileSync(paths[i], `${JSON.stringify(pkg, null, 2)}\n`);
});
console.log(`Version set to ${next}. Commit, then push main and tag v${next} to origin.`);
