#!/usr/bin/env node
// Builds the signed code-update bundle for the desktop app and points latest.json at it.
//
//   npm run bundle            build web/dist, then write release/autoposter-<version>.bundle and update latest.json
//   node scripts/release-bundle.js keygen   one time: make the signing key (keep it safe, never commit it)
//
// Then: upload the bundle to a GitHub release tagged v<version>, and push latest.json to main.
// The signing key lives outside the repo: AUTOPOSTER_SIGNING_KEY, or ~/.autoposter/update-signing-key.pem.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packBundle, verifyBundle, unpackBundle } from '../src/bundle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.AUTOPOSTER_SIGNING_KEY || path.join(os.homedir(), '.autoposter', 'update-signing-key.pem');
const REPO = 'raketbizdev/autoposter';

if (process.argv[2] === 'keygen') {
  if (fs.existsSync(KEY)) { console.error(`A signing key already exists at ${KEY}. Not replacing it.`); process.exit(1); }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(KEY), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).trim();
  fs.writeFileSync(path.join(root, 'src', 'update-key.js'),
    `// Public half of the update signing key (scripts/release-bundle.js keygen). Updates signed with any other key are refused.\n`
    + `export const UPDATE_PUBLIC_KEY = \`${pub}\n\`;\n`);
  console.log(`Signing key: ${KEY}\nBack it up somewhere safe. Without it you cannot ship code updates to installed apps.`);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { version } = pkg;
const minShell = pkg.autoposter?.minShell || version;
if (!fs.existsSync(KEY)) { console.error(`No signing key at ${KEY}. Run: node scripts/release-bundle.js keygen`); process.exit(1); }
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('Run npm run build first.'); process.exit(1); }

const files = {};
function add(abs, skipNested) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      if (name === '.DS_Store' || (skipNested && name === 'node_modules')) continue;
      add(path.join(abs, name), skipNested);
    }
  } else if (st.isFile() && !abs.endsWith('.map')) {
    files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs);
  }
}
add(path.join(root, 'src'));
add(path.join(root, 'web', 'dist'));
add(path.join(root, 'package.json'));
add(path.join(root, 'LICENSE'));
// Production dependencies only. Nested node_modules folders are listed on their own.
const deps = execFileSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
  .split('\n').map((s) => s.trim()).filter((d) => d && d !== root);
for (const d of deps) add(d, true);

const { bytes, sig } = packBundle({ version, minShell, files }, fs.readFileSync(KEY, 'utf8'));
const { UPDATE_PUBLIC_KEY } = await import('../src/update-key.js');
if (!verifyBundle(bytes, sig, UPDATE_PUBLIC_KEY)) { console.error('src/update-key.js does not match your signing key.'); process.exit(1); }
unpackBundle(bytes);

const name = `autoposter-${version}.bundle`;
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
fs.writeFileSync(path.join(root, 'release', name), bytes);

const feedFile = path.join(root, 'latest.json');
const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
feed.version = version;
feed.bundle = { url: `https://github.com/${REPO}/releases/download/v${version}/${name}`, sig, minShell, size: bytes.length };
fs.writeFileSync(feedFile, `${JSON.stringify(feed, null, 2)}\n`);

console.log(`Wrote release/${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${Object.keys(files).length} files)`);
console.log('Updated latest.json. Edit its "notes", then:');
console.log(`  gh release create v${version} release/${name} --title "Autoposter ${version}"`);
console.log('  git add latest.json && git commit -m "Release ' + version + '" && git push');
console.log('Push latest.json only after the release upload, or apps will try a file that is not there yet.');
