import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const meta = JSON.parse(readFileSync(new URL('../.build-meta.json', import.meta.url), 'utf8'));
const buildNumber = meta.absoluteVersion;
const sourceDate = Date.parse(`${meta.lastBuildDate}T00:00:00Z`);
if (!Number.isSafeInteger(buildNumber) || buildNumber < 1 || !Number.isFinite(sourceDate)) {
  throw new Error('Invalid CapRover build metadata');
}

const build = spawnSync('bun', ['run', 'build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    FLIGHTDECK_BUILD_NUMBER: String(buildNumber),
    FLIGHTDECK_BUILD_ID: `caprover-${buildNumber}`,
    SOURCE_DATE_EPOCH: String(Math.floor(sourceDate / 1000)),
  },
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
