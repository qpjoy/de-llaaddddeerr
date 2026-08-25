const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

/**
 * Static checks over the two OpenVPN shell scripts.
 *
 * These exist because `install` is the one path the behavioural tests cannot
 * exercise - it needs root, systemd and a package manager - and a call to an
 * undefined function is silent until then. Under `set -e` bash exits 127 at
 * that line, so an install can complete every visible step and still never
 * reach the one that starts the server.
 */

const packageRoot = resolve(__dirname, '..');
const scripts = ['openvpn-server.sh', 'openvpn-client.sh'];

/**
 * Removes heredoc bodies. Their contents are data - systemd units, OpenVPN
 * configuration, JSON - and would otherwise look like commands.
 */
function stripHeredocs(source) {
  const lines = source.split('\n');
  const kept = [];
  let terminator = null;

  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) {
        terminator = null;
      }
      continue;
    }

    const start = /<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?\s*$/.exec(line);
    if (start) {
      kept.push(line);
      terminator = start[1];
      continue;
    }
    kept.push(line);
  }

  assert.equal(terminator, null, `unterminated heredoc <<${terminator}`);
  return kept.join('\n');
}

function definedFunctions(source) {
  const names = new Set();
  for (const match of source.matchAll(/^([a-z_][a-z0-9_]*)\s*\(\)/gm)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Collects candidate calls: the first word of a statement, and the first word
 * inside a command substitution.
 *
 * Only snake_case names containing an underscore are considered. Every helper
 * in these scripts is named that way, while the external binaries they call -
 * ip, awk, systemctl, iptables, openssl - are not, which keeps the check from
 * depending on what happens to be installed on the machine running the tests.
 */
function calledLocalNames(source) {
  const names = new Set();

  for (const line of source.split('\n')) {
    const code = line.replace(/#.*$/, '');

    const statement = /^[\s{(]*([a-z_][a-z0-9_]*)(\s|$)/.exec(code);
    if (statement && statement[1].includes('_')) {
      names.add(statement[1]);
    }

    for (const match of code.matchAll(/\$\(\s*([a-z_][a-z0-9_]*)[\s)]/g)) {
      if (match[1].includes('_')) {
        names.add(match[1]);
      }
    }

    for (const match of code.matchAll(/(?:&&|\|\||;|\|)\s*([a-z_][a-z0-9_]*)(\s|$)/g)) {
      if (match[1].includes('_')) {
        names.add(match[1]);
      }
    }
  }

  return names;
}

function undefinedCalls(source) {
  const code = stripHeredocs(source);
  const defined = definedFunctions(code);
  return [...calledLocalNames(code)].filter((name) => !defined.has(name));
}

for (const script of scripts) {
  test(`${script} calls no undefined function`, () => {
    const source = readFileSync(resolve(packageRoot, 'resources', script), 'utf8');
    assert.deepEqual(
      undefinedCalls(source),
      [],
      'called but never defined; under set -e each one exits 127 and aborts ' +
        'whatever command reached it, which is how an install can finish every ' +
        'visible step without ever starting the server',
    );
  });
}

test('the undefined-call check actually detects one', () => {
  // A check that can only pass is worth nothing. This injects the exact shape
  // of the defect it exists for: a helper called from a command path but never
  // defined.
  const source = readFileSync(resolve(packageRoot, 'resources', 'openvpn-server.sh'), 'utf8');
  const injected = source.replace('\tapply_firewall\n', '\tapply_firewall\n\twrite_missing_thing\n');
  assert.notEqual(injected, source, 'failed to inject the probe');

  assert.deepEqual(undefinedCalls(injected), ['write_missing_thing']);
});

test('both scripts terminate with a single main dispatch', () => {
  for (const script of scripts) {
    const source = readFileSync(resolve(packageRoot, 'resources', script), 'utf8');
    assert.match(source, /\nmain "\$@"\s*$/, `${script} must end with main "$@"`);
  }
});
