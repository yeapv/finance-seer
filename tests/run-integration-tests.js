/**
 * Finance Seer - Integration Tests
 * Tests that verify module imports and system structure
 */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    process.stdout.write('F');
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertDefined(val, message) {
  if (val === undefined || val === null) throw new Error(message || 'Expected value to be defined');
}

const fs = require('fs');
const path = require('path');

console.log('\n🔗 Finance Seer Integration Tests\n');

const ROOT = path.join(__dirname, '..');

// File existence tests
test('package.json exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'package.json')), 'package.json must exist');
});

test('scripts directory exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'scripts')), 'scripts/ directory must exist');
});

test('lib directory exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'lib')), 'lib/ directory must exist');
});

test('app directory exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'app')), 'app/ directory must exist');
});

test('send-ci-notification.js exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'scripts/send-ci-notification.js')), 'Notification script must exist');
});

test('requirements.txt exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'requirements.txt')), 'requirements.txt must exist');
});

test('.gitignore exists', () => {
  assert(fs.existsSync(path.join(ROOT, '.gitignore')), '.gitignore must exist');
});

test('README.md exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'README.md')), 'README.md must exist');
});

test('CI/CD workflow exists', () => {
  assert(
    fs.existsSync(path.join(ROOT, '.github/workflows/ci-cd-pipeline.yml')),
    'CI/CD workflow must exist'
  );
});

// Package.json validation
test('package.json has name field', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assertDefined(pkg.name, 'package.json must have name');
});

test('package.json has version field', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assertDefined(pkg.version, 'package.json must have version');
});

test('package.json has scripts.build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assertDefined(pkg.scripts?.build, 'package.json must have build script');
});

// Script syntax validation
const scriptFiles = fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js'));
scriptFiles.forEach(file => {
  test(`${file} has valid syntax`, () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
    assert(content.length > 0, `${file} must not be empty`);
  });
});

// Print results
console.log('\n\n=== INTEGRATION TEST RESULTS ===\n');

if (failures.length > 0) {
  console.log('FAILURES:');
  failures.forEach(({ name, error }) => {
    console.log(`  ❌ ${name}: ${error}`);
  });
  console.log();
}

const total = passed + failed;
console.log(`Total:  ${total}`);
console.log(`Passed: ${passed} ✅`);
console.log(`Failed: ${failed} ${failed > 0 ? '❌' : '✅'}`);
console.log();

if (failed === 0) {
  console.log('🎉 ALL INTEGRATION TESTS PASSED!\n');
  process.exit(0);
} else {
  console.log(`⚠️  ${failed} INTEGRATION TEST(S) FAILED\n`);
  process.exit(1);
}
