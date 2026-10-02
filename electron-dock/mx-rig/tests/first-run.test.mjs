import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appBundle, appleScriptString, commandFor, plan, shellWord, translocated } from '../apps/desktop/first-run.mjs'

// 未签名安装包的第一次打开: what the app decides to do about macOS's
// quarantine, and the exact shell it would hand to the system prompt.
// Nothing here runs osascript or touches /Applications.

test('where the app runs from decides what to offer', () => {
  const exe = '/private/var/folders/x/T/AppTranslocation/0A1B/d/MX Rig.app/Contents/MacOS/MX Rig'
  const bundle = appBundle(exe)
  assert.equal(bundle, '/private/var/folders/x/T/AppTranslocation/0A1B/d/MX Rig.app')
  assert.equal(translocated(bundle), true)
  assert.equal(appBundle('/usr/local/bin/node'), null)

  // Opened from the disk image or Downloads: copy into Applications.
  assert.deepEqual(plan({ bundle, quarantined: true }), { kind: 'install', from: bundle, to: '/Applications/MX Rig.app' })
  assert.equal(plan({ bundle: '/Users/me/Downloads/MX Rig.app', quarantined: true }).kind, 'install')
  // Already in Applications, still flagged: only the flag goes.
  assert.deepEqual(plan({ bundle: '/Applications/MX Rig.app', quarantined: true }), { kind: 'release', to: '/Applications/MX Rig.app' })
  // Built on this machine, or already cleared: nothing to ask.
  assert.equal(plan({ bundle: '/Users/me/mx-rig/dist/mac-arm64/MX Rig.app', quarantined: false }), null)
  assert.equal(plan({ bundle: '/Applications/MX Rig.app', quarantined: false }), null)
})

test('the commands quote every path, and hand an elevated copy back to the person', () => {
  const step = { kind: 'install', from: "/Volumes/MX Rig/it's MX Rig.app", to: '/Applications/MX Rig.app' }
  const command = commandFor(step, { owner: '501' })
  assert.equal(
    command,
    "/bin/rm -rf '/Applications/MX Rig.app' && /usr/bin/ditto '/Volumes/MX Rig/it'\\''s MX Rig.app' '/Applications/MX Rig.app' && /usr/bin/xattr -dr com.apple.quarantine '/Applications/MX Rig.app' && /usr/sbin/chown -R '501' '/Applications/MX Rig.app'"
  )
  assert.equal(commandFor({ kind: 'release', to: '/Applications/MX Rig.app' }), "/usr/bin/xattr -dr com.apple.quarantine '/Applications/MX Rig.app'")
  // What sh actually receives is the path as written, quote and all.
  if (process.platform !== 'win32')
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellWord("it's \"here\" $HOME")}`]).toString(), 'it\'s "here" $HOME')
  assert.equal(appleScriptString('echo "a\\b"'), '"echo \\"a\\\\b\\""')
})
