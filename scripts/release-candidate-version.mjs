import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_RE = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)`
  + `(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?`
  + '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$',
);

export function parseSemVer(version) {
  const match = String(version ?? '').match(SEMVER_RE);
  if (!match) throw new Error(`Invalid SemVer: ${version}`);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split('.') ?? null,
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemVer(leftVersion, rightVersion) {
  const left = parseSemVer(leftVersion);
  const right = parseSemVer(rightVersion);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }

  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === null ? 1 : -1;
  }

  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    const compared = compareIdentifiers(a, b);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function defaultCandidateVersion(currentVersion) {
  const current = parseSemVer(currentVersion);
  return `${current.major}.${current.minor}.${current.patch + 1n}-rc.1`;
}

export function assertValidCandidateVersion(candidateVersion, currentVersion) {
  const candidate = parseSemVer(candidateVersion);
  parseSemVer(currentVersion);
  if (candidate.prerelease === null) {
    throw new Error(`Candidate version must include a prerelease identifier: ${candidateVersion}`);
  }
  if (compareSemVer(candidateVersion, currentVersion) <= 0) {
    throw new Error(`Candidate version ${candidateVersion} must be newer than package version ${currentVersion}.`);
  }
  return candidateVersion;
}

function main() {
  const [command, version, currentVersion] = process.argv.slice(2);
  if (command === 'default') {
    process.stdout.write(defaultCandidateVersion(version));
    return;
  }
  if (command === 'validate') {
    assertValidCandidateVersion(version, currentVersion);
    return;
  }
  throw new Error('Usage: release-candidate-version.mjs <default current|validate candidate current>');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
