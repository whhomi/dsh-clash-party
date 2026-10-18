// Launch a Chrome instance that talks to the plugin's proxy: its own profile dir, the
// proxy flag, and nothing else. Pure helpers (resolve/build) are unit-tested; launch is
// the only side effect.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const WIN_CANDIDATES = [
  'Google/Chrome/Application/chrome.exe',
  'Google/Chrome Beta/Application/chrome.exe',
  'Google/Chrome Dev/Application/chrome.exe',
  'Microsoft/Edge/Application/msedge.exe',
]

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
]

/** @returns {string | undefined} a usable browser executable, if one is installed. */
export function resolveChromePath(configured, env = process.env, platform = process.platform) {
  if (configured) return fs.existsSync(configured) ? configured : undefined
  if (env.DSH_PROXY_CHROME) return fs.existsSync(env.DSH_PROXY_CHROME) ? env.DSH_PROXY_CHROME : undefined
  const roots = []
  if (platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]) {
      if (base) for (const rel of WIN_CANDIDATES) roots.push(path.join(base, rel))
    }
  } else if (platform === 'darwin') {
    roots.push(...MAC_CANDIDATES)
  } else {
    roots.push(...LINUX_CANDIDATES)
  }
  for (const candidate of roots) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }
  return undefined
}

export function buildChromeArgs({ proxyUrl, userDataDir, extraArgs = [] }) {
  const args = []
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`)
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`)
  args.push('--no-first-run', '--no-default-browser-check')
  for (const extra of extraArgs) if (extra) args.push(String(extra))
  return args
}

/**
 * Start the browser detached so it outlives the plugin call.
 *
 * On Windows the launch is delegated to the shell (`cmd /c start`): a directly spawned
 * chrome.exe inherits the caller's restricted process/job, which can make it exit before
 * creating its profile. Letting the shell start it gives Chrome a normal environment.
 *
 * Chrome creates `<profile>/Local State` within the first second, so that file is the
 * readiness signal returned to the panel.
 *
 * @returns {Promise<{ ok: boolean, pid: number | null, executable: string, args: string[], userDataDir: string, via: string, command: string }>}
 */
export async function launchChrome({ executable, proxyUrl, userDataDir, extraArgs = [], platform = process.platform, waitMs = 1500 }) {
  const args = buildChromeArgs({ proxyUrl, userDataDir, extraArgs })
  const child = platform === 'win32'
    // `start "" <exe> <args…>` — the empty title argument keeps the exe out of the title slot.
    ? spawn('cmd.exe', ['/c', 'start', '""', executable, ...args], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(executable, args, { detached: true, stdio: 'ignore' })
  child.unref()

  const command = `"${executable}" ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
  const started = Date.now()
  let ok = false
  while (Date.now() - started < waitMs) {
    if (userDataDir && fs.existsSync(path.join(userDataDir, 'Local State'))) { ok = true; break }
    await new Promise((r) => setTimeout(r, 150))
  }
  return { ok, pid: child.pid ?? null, executable, args, userDataDir, via: platform === 'win32' ? 'shell' : 'direct', command }
}
