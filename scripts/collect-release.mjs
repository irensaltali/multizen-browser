import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const brand = JSON.parse(readFileSync(new URL('../branding/brand.json', import.meta.url), 'utf8'));

// Builders run on separate hosts. Merge their update feeds only after EVERY
// build succeeds; otherwise one Mac architecture overwrites the other's feed.
export function collectRelease(input, output, version) {
  mkdirSync(output, { recursive: true });
  const feeds = new Map();
  const assets = new Set();
  for (const dir of readdirSync(input, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(join(input, dir.name))) {
      const path = join(input, dir.name, name);
      if (/^latest.*\.yml$/.test(name)) {
        const feed = parse(readFileSync(path, 'utf8'));
        if (feed.version !== version || !Array.isArray(feed.files) || !feed.files.length) {
          throw new Error(`Invalid version or empty feed: ${path}`);
        }
        const merged = feeds.get(name) ?? { ...feed, files: [] };
        merged.files.push(...feed.files);
        feeds.set(name, merged);
      } else if (/\.(dmg|zip|exe|AppImage|blockmap)$/.test(name)) {
        if (assets.has(name)) throw new Error(`Duplicate release asset: ${name}`);
        copyFileSync(path, join(output, name));
        assets.add(name);
      }
    }
  }
  for (const [name, feed] of feeds) {
    const seen = new Set();
    for (const file of feed.files) {
      if (typeof file.url !== 'string' || basename(file.url) !== file.url || !assets.has(file.url)) {
        throw new Error(`Missing or unsafe update asset: ${file.url}`);
      }
      if (seen.has(file.url)) throw new Error(`Duplicate update entry: ${file.url}`);
      seen.add(file.url);
      const bytes = readFileSync(join(output, file.url));
      if (file.sha512 !== createHash('sha512').update(bytes).digest('base64') || file.size !== bytes.length) {
        throw new Error(`Update checksum/size mismatch: ${file.url}`);
      }
    }
    feed.files.sort((a, b) => a.url.localeCompare(b.url));
    const first = feed.files.find(f => f.url.endsWith('.zip')) ?? feed.files[0];
    feed.path = first.url;
    feed.sha512 = first.sha512;
    writeFileSync(join(output, name), stringify(feed));
  }
  for (const name of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
    if (!feeds.has(name)) throw new Error(`Missing platform feed: ${name}`);
  }
  for (const arch of ['arm64', 'x64']) {
    for (const ext of ['dmg', 'zip']) {
      if (!assets.has(`${brand.name}-mac-${arch}.${ext}`)) throw new Error(`Missing Mac ${arch} ${ext}`);
    }
    if (!feeds.get('latest-mac.yml').files.some(f => f.url === `${brand.name}-mac-${arch}.zip`)) {
      throw new Error(`Missing Mac ${arch} update entry`);
    }
  }
  // v0.4.3 Mac clients use fixed legacy DMG URLs. Keep their upgrade path.
  for (const arch of ['arm64', 'x64']) {
    const alias = `${brand.compatibility.legacyArtifactName}-mac-${arch}.dmg`;
    const canonical = `${brand.name}-mac-${arch}.dmg`;
    if (alias !== canonical) {
      if (assets.has(alias)) throw new Error(`Unexpected legacy asset: ${alias}`);
      copyFileSync(join(output, canonical), join(output, alias));
      assets.add(alias);
    }
  }
  const sums = [...assets].sort().map(name =>
    `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}`,
  );
  writeFileSync(join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return { assets: assets.size, feeds: feeds.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, version] = process.argv.slice(2);
  if (!input || !output || !version || !existsSync(input)) throw new Error('Usage: collect-release.mjs INPUT OUTPUT VERSION');
  console.log(collectRelease(input, output, version));
}
