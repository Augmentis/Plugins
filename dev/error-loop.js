#!/usr/bin/env node

// Central dev error orchestrator for all registered plugins.
//
// Connects to a single Chrome instance via CDP, watches every loaded extension
// simultaneously, identifies which plugin owns each error by mapping extension
// IDs to plugin configs, and routes each error to the correct fixer — either a
// persistent Claude session or a local Ollama model.
//
// Each plugin maintains its own fixer session and fix log in its own dev/ folder.

const { spawn, execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const REGISTRY_PATH = path.join(SCRIPT_DIR, 'registry.json');

// ── Load registry ─────────────────────────────────────────────────────────────

if (!fs.existsSync(REGISTRY_PATH)) {
  console.error(`No registry.json found at ${REGISTRY_PATH}`);
  console.error('Create dev/registry.json listing your active plugins.');
  process.exit(1);
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const CDP_PORT = registry.cdpPort || 9222;
const CDP_HOST = `http://localhost:${CDP_PORT}`;

// ── Load plugin configs ───────────────────────────────────────────────────────

const plugins = registry.plugins.map((entry) => {
  const pluginDir = path.resolve(SCRIPT_DIR, entry.path);
  const configPath = path.join(pluginDir, 'dev.config.json');

  if (!fs.existsSync(configPath)) {
    console.warn(`  ⚠ No dev.config.json at ${configPath} — skipping`);
    return null;
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Prefer the manifest name for matching against CDP target titles
  let manifestName = config.name;
  const manifestPath = path.join(pluginDir, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name) manifestName = manifest.name;
    } catch {}
  }

  const devDir = path.join(pluginDir, 'dev');
  return {
    ...config,
    dir: pluginDir,
    devDir,
    fixer: entry.fixer || config.fixer || 'claude',
    manifestName,
    sessionFile:    path.join(devDir, '.claude-session-id'),
    fixLogFile:     path.join(devDir, '.fix-log.jsonl'),
    lastPromptFile: path.join(devDir, '.last-prompt.txt'),
  };
}).filter(Boolean);

// ── Extension ID → plugin map ─────────────────────────────────────────────────
//
// Chrome assigns each loaded-unpacked extension a unique ID (a 32-char string).
// All CDP target URLs for that extension begin with chrome-extension://<id>/.
//
// At startup (and after every reload) we build a map from ID → plugin by:
//   1. Scanning the Chrome profile's Default/Extensions/<id>/ folder — each
//      subdirectory contains a manifest.json whose "name" we match to our plugin list.
//   2. Falling back to CDP target titles, which often equal the extension name.
//
// Once the map is built, routing an error to its owning plugin is a single O(1) lookup.

const extensionMap = new Map(); // extensionId (string) → plugin config

function buildExtensionMap() {
  const extBaseDir = path.join(SCRIPT_DIR, '.chrome-dev-profile', 'Default', 'Extensions');
  if (!fs.existsSync(extBaseDir)) return;

  for (const extId of fs.readdirSync(extBaseDir)) {
    if (extensionMap.has(extId)) continue;

    const extDir = path.join(extBaseDir, extId);
    if (!fs.statSync(extDir).isDirectory()) continue;

    const versions = fs.readdirSync(extDir).filter(
      (v) => fs.statSync(path.join(extDir, v)).isDirectory()
    );

    for (const version of versions) {
      const mPath = path.join(extDir, version, 'manifest.json');
      if (!fs.existsSync(mPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        const plugin = plugins.find(
          (p) => p.manifestName === manifest.name || p.name === manifest.name
        );
        if (plugin) { extensionMap.set(extId, plugin); break; }
      } catch {}
    }
  }
}

function mapFromTargets(targets) {
  for (const target of targets) {
    if (!target.url?.startsWith('chrome-extension://')) continue;
    const extId = target.url.split('/')[2];
    if (extensionMap.has(extId)) continue;
    const title = target.title || '';
    const plugin = plugins.find(
      (p) =>
        p.manifestName === title ||
        p.name === title ||
        title.toLowerCase().includes(p.name.toLowerCase())
    );
    if (plugin) extensionMap.set(extId, plugin);
  }
}

function getPluginForError(source, location) {
  const str = location || source || '';
  const match = str.match(/chrome-extension:\/\/([a-z]{32})/);
  if (match) return extensionMap.get(match[1]) || null;
  return null;
}

// ── Per-plugin session management ─────────────────────────────────────────────

function loadSessionId(plugin) {
  try { return fs.readFileSync(plugin.sessionFile, 'utf8').trim() || null; }
  catch { return null; }
}

function saveSessionId(plugin, id) {
  fs.mkdirSync(plugin.devDir, { recursive: true });
  fs.writeFileSync(plugin.sessionFile, id, 'utf8');
}

// ── Per-plugin fix log ────────────────────────────────────────────────────────

function appendFixLog(plugin, entry) {
  fs.mkdirSync(plugin.devDir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(plugin.fixLogFile, line, 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Terminal formatting ───────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[91m',
  green:  '\x1b[92m',
  yellow: '\x1b[93m',
  blue:   '\x1b[94m',
  cyan:   '\x1b[96m',
  white:  '\x1b[97m',
};
const fmt  = (color, str) => `${color}${str}${c.reset}`;
const W    = 62;
const line = () => fmt(c.dim, '─'.repeat(W));
const step = (msg) => console.log(fmt(c.dim, '  │ ') + msg);

// ── Chrome CDP ────────────────────────────────────────────────────────────────

async function getTargets() {
  const res = await fetch(`${CDP_HOST}/json`);
  if (!res.ok) throw new Error(`Chrome not reachable on port ${CDP_PORT}. Did dev.sh start it?`);
  return res.json();
}

function connectTarget(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new (require(WS_PATH))(wsUrl);
    const pending = new Map();
    let seq = 1;

    ws.on('open', () => resolve({ ws, send }));
    ws.on('error', reject);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.result);
      }
      if (msg.method) ws.emit('cdp_event', msg);
    });

    function send(method, params = {}) {
      return new Promise((resolve) => {
        const id = seq++;
        pending.set(id, { resolve });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
  });
}

// ── Target watching ───────────────────────────────────────────────────────────

let activeWatchers = [];

async function watchTarget(target) {
  const label = target.title || target.url || target.id;
  step(fmt(c.dim, '● ') + label);

  let client;
  try { client = await connectTarget(target.webSocketDebuggerUrl); }
  catch (e) {
    step(fmt(c.yellow, '⚠ Could not connect to ') + label + ': ' + e.message);
    return;
  }

  const { ws, send } = client;
  activeWatchers.push({ ws, label });

  await send('Runtime.enable');
  await send('Console.enable');

  ws.on('cdp_event', (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails;
      const text = ex.exception?.description || ex.text || 'Unknown exception';
      const loc = ex.url
        ? `${ex.url}:${ex.lineNumber}:${ex.columnNumber}`
        : 'unknown location';
      handleError({ source: label, text, location: loc, type: 'exception' });
    }
    if (msg.method === 'Console.messageAdded') {
      const m = msg.params.message;
      if (m.level === 'error') {
        const loc = m.url ? `${m.url}:${m.line}:${m.column}` : 'unknown location';
        handleError({ source: label, text: m.text, location: loc, type: 'console.error' });
      }
    }
  });
}

function closeAllWatchers() {
  for (const { ws } of activeWatchers) {
    try { ws.close(); } catch {}
  }
  activeWatchers = [];
}

// ── Error state ───────────────────────────────────────────────────────────────

let errorQueue = Promise.resolve();
let seenErrors  = new Set();
const activeRecurrenceChecks = new Set();

// ── Error handler ─────────────────────────────────────────────────────────────

function handleError(err) {
  // Notify any active verification windows before deduplication
  for (const check of activeRecurrenceChecks) check(err);

  const key = `${err.source}|${err.text}`;
  if (seenErrors.has(key)) return;
  seenErrors.add(key);
  setTimeout(() => seenErrors.delete(key), 10_000);

  const plugin = getPluginForError(err.source, err.location);
  const pluginLabel = plugin
    ? fmt(c.cyan, plugin.name)
    : fmt(c.yellow, 'unknown plugin');

  console.log('\n' + line());
  console.log(
    fmt(c.red, c.bold + '  ✗ ERROR') +
    fmt(c.dim, ` [${err.type}]`) +
    '  ' + pluginLabel
  );
  console.log(fmt(c.dim, '  @ ') + fmt(c.cyan, err.location));
  console.log(fmt(c.dim, '  > ') + err.text);
  console.log(line());

  if (!plugin) {
    console.log(fmt(c.yellow, '  ⚠ No registered plugin owns this extension — skipping.'));
    console.log(fmt(c.dim,    '    Add it to dev/registry.json to enable auto-fix.\n'));
    return;
  }

  const fixerLabel = plugin.fixer === 'claude'
    ? 'Claude'
    : plugin.fixer.startsWith('ollama:') ? plugin.fixer : plugin.fixer;

  console.log(
    fmt(c.blue, `  → Routing to ${fixerLabel} for ${plugin.name}…`) +
    fmt(c.dim, ' (new Terminal window opening)\n')
  );

  errorQueue = errorQueue.then(() => runFix(err, plugin));
}

// ── Source context ────────────────────────────────────────────────────────────

function getSourceSnippet(plugin, location) {
  const fileMatch = location.match(/\/([\w.-]+\.(?:js|html|css|json)):/);
  if (!fileMatch) return '';

  const filename = fileMatch[1];
  const searchDirs = (plugin.sourceDirs || []).map((d) => path.join(plugin.dir, d));
  searchDirs.push(plugin.dir);

  for (const dir of searchDirs) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const lineNo = parseInt(location.split(':').at(-2)) || 0;
      const start  = Math.max(0, lineNo - 10);
      const end    = Math.min(lines.length, lineNo + 10);
      return (
        `\nRelevant source (${p}, lines ${start}–${end}):\n` +
        `\`\`\`\n${lines.slice(start, end).join('\n')}\n\`\`\``
      );
    }
  }
  return '';
}

// ── Extension reload ──────────────────────────────────────────────────────────

async function reloadExtension(plugin) {
  console.log('\n' + fmt(c.blue, `  ⟳ Reloading ${plugin.name}…`));

  let targets;
  try { targets = await getTargets(); }
  catch (e) { console.warn('  Could not fetch targets:', e.message); return false; }

  // Find the service worker that belongs specifically to this plugin
  const extId = [...extensionMap.entries()].find(([, p]) => p === plugin)?.[0];

  const sw = targets.find((t) => {
    if (t.type !== 'service_worker') return false;
    if (extId && t.url?.includes(extId)) return true;
    const title = t.title || '';
    return title === plugin.manifestName || title === plugin.name;
  });

  if (!sw) {
    step(fmt(c.yellow, `⚠ No service worker found for ${plugin.name} — reload skipped`));
    return false;
  }

  try {
    const { ws, send } = await connectTarget(sw.webSocketDebuggerUrl);
    await send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' });
    ws.close();
    step(fmt(c.dim, 'chrome.runtime.reload() called'));
    return true;
  } catch (e) {
    step(fmt(c.yellow, '⚠ Could not reload: ' + e.message));
    return false;
  }
}

async function waitForExtensionTargets(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      const targets = await getTargets();
      const ext = targets.filter(
        (t) => t.url?.startsWith('chrome-extension://') || t.type === 'service_worker'
      );
      if (ext.length > 0) return ext;
    } catch {}
  }
  return [];
}

async function reAttachWatchers() {
  closeAllWatchers();
  step(fmt(c.dim, 'waiting for targets…'));
  const extTargets = await waitForExtensionTargets();

  if (extTargets.length === 0) {
    step(fmt(c.yellow, '⚠ No targets after reload'));
    return;
  }

  // Refresh the extension map — new targets may have new IDs after reload
  buildExtensionMap();
  mapFromTargets(extTargets);

  step(fmt(c.dim, `re-attaching to ${extTargets.length} target(s)…`));
  for (const t of extTargets) await watchTarget(t);
}

// ── Error reproduction ────────────────────────────────────────────────────────

async function reproduceError(err) {
  step(fmt(c.dim, 'reproducing error…'));

  let targets;
  try { targets = await getTargets(); }
  catch { return; }

  const match = targets.find((t) => {
    const label = t.title || t.url || '';
    return (
      label.includes(err.source) ||
      err.source.includes(t.title || '') ||
      (err.location && t.url && err.location.includes(t.url.split('/').pop()))
    );
  });

  if (match) {
    try {
      await fetch(`${CDP_HOST}/json/activate/${match.id}`);
      step(fmt(c.dim, 'activated: ') + (match.title || match.url));
      if (match.type !== 'service_worker' && match.webSocketDebuggerUrl) {
        const { ws, send } = await connectTarget(match.webSocketDebuggerUrl);
        await send('Page.reload', { ignoreCache: true });
        ws.close();
        step(fmt(c.dim, 'page reloaded'));
      }
    } catch (e) {
      step(fmt(c.yellow, '⚠ Could not activate: ' + e.message));
    }
  } else {
    step(fmt(c.dim, `no open target for "${err.source}" — open it manually to reproduce`));
  }
}

// ── Fix verification ──────────────────────────────────────────────────────────

const VERIFY_WINDOW_MS = 12_000;

async function verifyFix(err, plugin) {
  const key = `${err.source}|${err.text}`;
  seenErrors.delete(key);

  const reloaded = await reloadExtension(plugin);
  if (!reloaded) {
    step(fmt(c.dim, 'skipping verification — reload not available\n'));
    return;
  }

  await reAttachWatchers();
  await sleep(600);
  await reproduceError(err);

  console.log(fmt(c.blue, `  ⟳ Verifying — watching ${VERIFY_WINDOW_MS / 1000}s for recurrence…\n`));

  const recurrenceDetected = await new Promise((resolve) => {
    let fired = false;
    const check = (detectedErr) => {
      if (`${detectedErr.source}|${detectedErr.text}` === key) fired = true;
    };
    activeRecurrenceChecks.add(check);
    setTimeout(() => {
      activeRecurrenceChecks.delete(check);
      resolve(fired);
    }, VERIFY_WINDOW_MS);
  });

  if (recurrenceDetected) {
    console.log(line());
    console.log(fmt(c.yellow, '  ⚠ Same error recurred — fix incomplete. Retrying…'));
    console.log(line() + '\n');
    appendFixLog(plugin, { error: err.text, location: err.location, verified: false });
    errorQueue = errorQueue.then(() => runFix(err, plugin, true));
  } else {
    console.log(fmt(c.green, '  ✓ Fix verified — error did not recur.\n'));
    appendFixLog(plugin, { error: err.text, location: err.location, verified: true });
  }
}

// ── Fixer: Claude ─────────────────────────────────────────────────────────────

function buildClaudePrompt(err, plugin, isRetry) {
  const sessionId = loadSessionId(plugin);

  const retryHeader = isRetry
    ? `IMPORTANT: A previous fix was applied and the extension reloaded, but the same ` +
      `error reappeared. The fix did not work. Investigate more deeply — consider ` +
      `related files, initialization order, async timing, or incorrect assumptions ` +
      `in the previous fix.\n\n`
    : '';

  const freshHeader = !sessionId
    ? `Before doing anything else, read ${path.join(plugin.dir, 'CLAUDE.md')} ` +
      `to understand the project structure and conventions.\n\n`
    : '';

  return (
    `${retryHeader}${freshHeader}` +
    `A runtime error occurred in the ${plugin.name} Chrome extension.\n\n` +
    `Project: ${plugin.description}\n` +
    `Error type: ${err.type}\n` +
    `Source page: ${err.source}\n` +
    `Location: ${err.location}\n` +
    `Message: ${err.text}\n` +
    `${getSourceSnippet(plugin, err.location)}\n\n` +
    `Project root: ${plugin.dir}\n` +
    `Source directories: ${(plugin.sourceDirs || []).join(', ')}\n\n` +
    `Please:\n` +
    `1. Identify the root cause\n` +
    `2. Fix it by editing the relevant file(s) in the project\n` +
    `3. Briefly explain what you changed and why\n\n` +
    `Apply the fix directly — do not just suggest it.`
  );
}

function runClaudeFix(err, plugin, isRetry = false) {
  return new Promise((resolve) => {
    const sessionId = loadSessionId(plugin);
    const prompt = buildClaudePrompt(err, plugin, isRetry);

    fs.mkdirSync(plugin.devDir, { recursive: true });
    fs.writeFileSync(plugin.lastPromptFile, prompt, 'utf8');

    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--allowedTools', 'Read,Edit,Write',
    ];
    if (sessionId) args.push('--resume', sessionId);
    args.push(prompt);

    const claudeCmd = [
      'claude',
      ...args.map((a) => `'${a.replace(/'/g, "'\\''")}'`),
    ].join(' ');

    const termScript = `
      tell application "Terminal"
        activate
        do script "cd '${plugin.dir}' && echo 'Fixing ${plugin.name}…' && ${claudeCmd}; echo; echo '[Done — window will stay open]'"
      end tell
    `;

    const proc = spawn('claude', args, {
      cwd: plugin.dir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;
        try {
          const obj = JSON.parse(rawLine);
          if (obj.type === 'result' && obj.session_id) saveSessionId(plugin, obj.session_id);
        } catch {}
      }
    });

    proc.on('close', async (code) => {
      if (code !== 0) step(fmt(c.red, `✗ claude exited with code ${code}`));
      appendFixLog(plugin, {
        error: err.text, location: err.location, source: err.source,
        isRetry, claudeExitCode: code,
      });
      step(fmt(c.green, '✓ Fix applied'));
      await verifyFix(err, plugin);
      resolve();
    });

    exec(
      `osascript -e "${termScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      (e) => { if (e) console.warn('Could not open Terminal window:', e.message); }
    );
  });
}

// ── Fixer: Ollama ─────────────────────────────────────────────────────────────

function buildOllamaPrompt(err, plugin, isRetry) {
  const retryHeader = isRetry
    ? `A previous fix did not work — the same error reappeared after reload. ` +
      `Investigate more deeply.\n\n`
    : '';

  return (
    `${retryHeader}` +
    `You are fixing a bug in the ${plugin.name} Chrome extension.\n\n` +
    `Error type: ${err.type}\n` +
    `Source: ${err.source}\n` +
    `Location: ${err.location}\n` +
    `Message: ${err.text}\n` +
    `${getSourceSnippet(plugin, err.location)}\n\n` +
    `Project root: ${plugin.dir}\n` +
    `Source directories: ${(plugin.sourceDirs || []).join(', ')}\n\n` +
    `Read the relevant source files, identify the root cause, and output the corrected ` +
    `file content. Apply the fix directly.`
  );
}

function runOllamaFix(err, plugin, model, isRetry = false) {
  return new Promise((resolve) => {
    const prompt = buildOllamaPrompt(err, plugin, isRetry);

    fs.mkdirSync(plugin.devDir, { recursive: true });
    fs.writeFileSync(plugin.lastPromptFile, prompt, 'utf8');

    step(fmt(c.blue, `Running ollama ${model} for ${plugin.name}…`));

    const proc = spawn('ollama', ['run', model, prompt], {
      cwd: plugin.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d) => process.stdout.write(d));
    proc.stderr.on('data', (d) => process.stderr.write(d));

    proc.on('close', async (code) => {
      appendFixLog(plugin, {
        error: err.text, location: err.location, source: err.source,
        isRetry, fixer: `ollama:${model}`, exitCode: code,
      });
      step(fmt(c.green, '✓ Ollama response received'));
      await verifyFix(err, plugin);
      resolve();
    });
  });
}

// ── Fix dispatcher ────────────────────────────────────────────────────────────

function runFix(err, plugin, isRetry = false) {
  if (plugin.fixer === 'claude') return runClaudeFix(err, plugin, isRetry);

  if (plugin.fixer?.startsWith('ollama:')) {
    const model = plugin.fixer.slice('ollama:'.length);
    return runOllamaFix(err, plugin, model, isRetry);
  }

  console.warn(`  ⚠ Unknown fixer "${plugin.fixer}" for ${plugin.name} — skipping`);
  return Promise.resolve();
}

// ── Startup ───────────────────────────────────────────────────────────────────

const WS_PATH = path.join(__dirname, 'node_modules', 'ws');

async function main() {
  if (!fs.existsSync(WS_PATH)) {
    console.log('Installing dev dependencies…');
    execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
  }

  console.log('\n' + line());
  console.log(fmt(c.bold + c.white, '  Augmentis Dev Orchestrator'));
  console.log(fmt(c.dim, `  CDP  localhost:${CDP_PORT}`));
  console.log(line());
  console.log(fmt(c.dim, '  Plugins:'));
  for (const p of plugins) {
    const sid = loadSessionId(p);
    const sessionLabel = sid
      ? fmt(c.green, '●') + fmt(c.dim, ' ' + sid.slice(0, 16) + '…')
      : fmt(c.dim, '○ new session on first error');
    console.log(
      fmt(c.dim, '    ') +
      fmt(c.white, p.name.padEnd(14)) +
      fmt(c.dim, `fixer=${p.fixer.padEnd(12)}`) +
      sessionLabel
    );
  }
  console.log(line() + '\n');

  let targets;
  try {
    targets = await getTargets();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  buildExtensionMap();
  mapFromTargets(targets);

  const extTargets = targets.filter(
    (t) => t.url?.startsWith('chrome-extension://') || t.type === 'service_worker'
  );

  if (extTargets.length === 0) {
    console.log(fmt(c.yellow, '  ⚠ No extension targets found.'));
    console.log(fmt(c.dim,    '    Load extensions: chrome://extensions → Load unpacked'));
  } else {
    console.log(fmt(c.dim, '  Watching targets:'));
    for (const t of extTargets) await watchTarget(t);
  }

  console.log('\n' + fmt(c.dim, '  Extension → plugin routing:'));
  if (extensionMap.size === 0) {
    console.log(fmt(c.yellow, '    ⚠ No extensions mapped yet — load them in Chrome'));
  } else {
    for (const [extId, plugin] of extensionMap) {
      console.log(
        fmt(c.dim, '    ') +
        fmt(c.dim, extId.slice(0, 12) + '…  →  ') +
        fmt(c.white, plugin.name)
      );
    }
  }

  console.log('\n' + fmt(c.dim, '  Ready — watching for errors across all plugins…') + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
