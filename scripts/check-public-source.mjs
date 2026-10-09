import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: rootDir })
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const failures = [];

const prohibitedFiles = [
  /(^|\/)\.mcp\.json$/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)(?:docs\/)?handoffs?(\/|$)/i,
  /(^|\/)(?:data|state|backup|backups)(\/|$)/i,
  /\.(?:db|sqlite|sqlite3|bak|backup|pem|key|p12|pfx)$/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
];

for (const file of tracked) {
  if (prohibitedFiles.some((pattern) => pattern.test(file))) {
    failures.push(`prohibited tracked file: ${file}`);
  }
}

const join = (...parts) => parts.join('');
const prohibitedMarkers = [
  { label: 'legacy agent slug', pattern: new RegExp(`\\b${join('w', 'm', '2', '1')}\\b`, 'i') },
  { label: 'legacy agent label', pattern: new RegExp(`\\b${join('Wing', 'man')}[\\s_-]*${join('2', '1')}\\b`, 'i') },
  { label: 'personal operator name', pattern: new RegExp(`\\b${join('Pe', 'te')}(?: Winn)?\\b`, 'i') },
  { label: 'personal agent identity', pattern: new RegExp(`\\b${join('Ri', 'ck')}\\b`, 'i') },
  { label: 'operator home path', pattern: new RegExp(join('/Users/', 'mi', 'ni', '(?:/|\\b)'), 'i') },
  { label: 'private organization marker', pattern: new RegExp(join('humans', 'institute'), 'i') },
  { label: 'private upstream domain', pattern: new RegExp(join('(?:[a-z0-9-]+\\.)*', 'other', 'stuff', '\\.(?:ai|studio|com|net|org|io|dev|app)\\b'), 'i') },
  { label: 'private agent domain', pattern: new RegExp(join('(?:[a-z0-9-]+\\.)*', 'run', 'wingman', '\\.com\\b'), 'i') },
];

const approvedSyntheticNpubs = new Set([
  // Shared Tower record-delta v1 synthetic actor fixture.
  join('npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78', 'suk0wul'),
  // Public schema authority embedded by the SuperBased record-family bundle.
  join('npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6', 'dns5'),
  join('npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq', 'pkge6d'),
  join('npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs', '38mnyd'),
  join('npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus', '6gq266'),
  join('npub1ujfahuwppkq0xkq7fyzfxzc5qnxxcyuspms8tpr5l222h6xye5fs', 'ccv64k'),
  join('npub1979aung6qusfx4d55ujs5hz39r5ghp9am3se4d7t4r2knvjqaljq', 'evzcrp'),
  join('npub1lluhh4t4tmh2ggz98g2r25346wp0v3e0s452rze0q4apgcpfw4tq', 'f7pfhd'),
]);
const npubPattern = /\bnpub1[023456789acdefghjklmnpqrstuvwxyz]{58}\b/gi;
const prohibitedSecretValues = [
  {
    label: 'literal Nostr private key',
    pattern: /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{58}\b/i,
  },
  {
    label: 'labelled raw private key',
    pattern: /(?:AGENT_NSEC|TESTING(?:_MEMBER)?_NSEC|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSWORD)[\s"'=:]+[0-9a-f]{64}\b/i,
  },
  {
    label: 'PEM private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    label: 'GitHub access token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  },
  {
    label: 'AWS access key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    label: 'API secret key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: 'Slack access token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  },
  {
    label: 'literal bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/i,
  },
];

for (const file of tracked) {
  const absolutePath = path.join(rootDir, file);
  if (!existsSync(absolutePath)) continue;
  const contents = readFileSync(absolutePath);
  if (contents.includes(0)) continue;

  const text = contents.toString('utf8');
  // The public hosting domain is explicit product copy, not an operator endpoint.
  // Permit only this exact domain in the onboarding and policy sources.
  const publicHostingFiles = new Set(['index.html', 'src/hosting-legal-content.json', 'docs/design/nstack-hosting-onboarding.md']);
  for (const marker of prohibitedMarkers) {
    const markerText = marker.label === 'private upstream domain' && publicHostingFiles.has(file)
      ? text.replace(/(?<![a-z0-9.-])nstack\.otherstuff\.ai(?![a-z0-9-]|\.[a-z0-9])/gi, 'public-hosting-domain') : text;
    if (marker.pattern.test(markerText)) failures.push(`${marker.label}: ${file}`);
  }

  for (const secret of prohibitedSecretValues) {
    if (secret.pattern.test(text)) failures.push(`${secret.label}: ${file}`);
  }

  for (const npub of text.match(npubPattern) || []) {
    if (!approvedSyntheticNpubs.has(npub.toLowerCase())) {
      failures.push(`unapproved literal npub: ${file}`);
      break;
    }
  }
}

if (failures.length > 0) {
  console.error('Public-source quality check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public-source quality check passed for ${tracked.length} tracked files.`);
