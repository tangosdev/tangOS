import { app, BrowserWindow, Notification } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// A one-shot debug snapshot: dumps a screenshot + full state + a DOM/computed-style map to a
// stable folder so the operator (and Claude, reading the files) can see the UI and pull data
// without guessing. Triggered by a hotkey (Ctrl+Shift+D) or a Settings button.

export function debugDir(): string {
  return join(app.getPath('documents'), 'tangos-debug')
}

// Runs INSIDE the renderer (injected as a string, so it's plain JS — not type-checked against the
// main process's non-DOM lib). Returns rects + computed styles for the UI elements we most often
// chase visual bugs on: the console-inspector view, basically.
const DOM_SNAPSHOT_JS = `(function () {
  var sel = ['.topbar','.brand','.seg','.aib-card','.aib-name','.aib-stats','.aib-roles','.role-chip','.agent-role','.agent-effort','.aib-size','.aib-loop','.joke-text','.app-version','.autopush-chip','.controller','.workspace','.tool-palette'];
  var props = ['color','backgroundColor','backgroundImage','fontSize','fontWeight','fontStyle','padding','margin','border','borderRadius','width','height','display','flexDirection','gap','alignItems','justifyContent','opacity','position','overflow'];
  var out = { viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }, theme: document.documentElement.dataset.theme || null, elements: {} };
  for (var i = 0; i < sel.length; i++) {
    var s = sel[i];
    var nodes = Array.prototype.slice.call(document.querySelectorAll(s), 0, 6);
    out.elements[s] = nodes.map(function (el) {
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      var style = {};
      for (var j = 0; j < props.length; j++) style[props[j]] = cs[props[j]];
      return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, text: (el.textContent || '').trim().slice(0, 90), classes: el.className, style: style };
    });
  }
  return out;
})()`

/** Write screenshot.png + state.json + dom.json to the debug folder. Returns the folder path. */
export async function dumpDebug(win: BrowserWindow | null, state: unknown, activity: unknown): Promise<string> {
  const dir = debugDir()
  mkdirSync(dir, { recursive: true })
  if (win && !win.isDestroyed()) {
    try {
      const img = await win.webContents.capturePage()
      writeFileSync(join(dir, 'screenshot.png'), img.toPNG())
    } catch {
      /* capture can fail if the window is hidden */
    }
    try {
      const dom = await win.webContents.executeJavaScript(DOM_SNAPSHOT_JS, true)
      writeFileSync(join(dir, 'dom.json'), JSON.stringify(dom, null, 2))
    } catch {
      /* renderer not ready */
    }
  }
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ at: new Date().toISOString(), version: app.getVersion(), state, activity }, null, 2)
  )
  // In-app toast (works in dev, unlike a native notification which needs the installed app's ID).
  if (win && !win.isDestroyed()) win.webContents.send('debug:dumped', dir)
  try {
    new Notification({ title: 'tangOS debug', body: 'Snapshot saved (screenshot + state + dom)' }).show()
  } catch {
    /* native notifications may be off (e.g. a dev build) */
  }
  return dir
}
