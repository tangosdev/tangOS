import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, AlertTriangle, GitBranch, FolderOpen, KeyRound, RefreshCw } from 'lucide-react'
import type { RepoState, McpState, ActivityRun, ActivityEvent, Batch, BatchDraft, BatchItem, Review, ConnectedClient } from '../../shared/types'
import RepoPicker from './components/RepoPicker'
import DescriptorGate from './components/DescriptorGate'
import ToolPalette from './components/ToolPalette'
import McpBubble from './components/McpBubble'
import KeyVault from './components/KeyVault'
import Requirements from './components/Requirements'
import LiveViewer from './components/LiveViewer'
import PromptComposer from './components/PromptComposer'
import AtlasView from './components/AtlasView'
import AppSwitcher, { type AppView } from './components/AppSwitcher'
import Splash from './components/Splash'
import ReviewPanel from './components/ReviewPanel'
import WindowControls from './components/WindowControls'

const THEMES = ['aero', 'sunset', 'deepsea', 'bubblegum', 'mint', 'hal']
const APP_LABEL: Record<AppView, string> = { console: 'Chaos Tools', atlas: 'Chaos Viewer' }

export default function App(): JSX.Element {
  const [repo, setRepo] = useState<RepoState | null>(null)
  const [mcp, setMcp] = useState<McpState | null>(null)
  const [allowMutations, setAllowMutations] = useState(true)
  const [enabledIds, setEnabledIds] = useState<string[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [draft, setDraft] = useState<BatchDraft>({ title: '', prompt: '', items: [] })
  const [theme, setTheme] = useState('aero')
  const [runs, setRuns] = useState<ActivityRun[]>([])
  const [mcpOpen, setMcpOpen] = useState(false)
  const [reqAllSet, setReqAllSet] = useState(false)
  const [view, setView] = useState<AppView>('console')
  const [splash, setSplash] = useState<string | null>(null)
  const [safeMode, setSafeMode] = useState(false)
  const [reviews, setReviews] = useState<Review[]>([])
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [clients, setClients] = useState<ConnectedClient[]>([])
  const [keysOpen, setKeysOpen] = useState(false)
  const [reloadNote, setReloadNote] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const keysRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let unsubActivity = () => {}
    let unsubState = () => {}
    const unsubDraftAdd = window.tangos.onDraftAdd((item) => {
      setDraft((d) => (d.items.some((i) => i.ref === item.ref) ? d : { ...d, items: [...d.items, item] }))
    })
    const unsubReload = window.tangos.onDescriptorReloaded((info) => {
      const errs = info.errors ? ` · ${info.errors} error(s)` : ''
      setReloadNote(`Descriptor reloaded · ${info.toolCount} tools${errs}`)
      window.setTimeout(() => setReloadNote(null), 2600)
    })
    ;(async () => {
      const s = await window.tangos.getState()
      setRepo(s.repo)
      setMcp(s.mcp)
      setAllowMutations(s.allowMutations)
      setEnabledIds(s.enabledToolIds)
      setBatches(s.batches)
      setSafeMode(s.safeMode)
      setReviews(s.reviews)
      setBaseBranch(s.baseBranch)
      setClients(s.clients)
      setRuns(await window.tangos.activitySnapshot())
      unsubActivity = window.tangos.onActivity(applyActivity)
      unsubState = window.tangos.onState((st) => {
        setRepo(st.repo)
        setMcp(st.mcp)
        setAllowMutations(st.allowMutations)
        setEnabledIds(st.enabledToolIds)
        setBatches(st.batches)
        setSafeMode(st.safeMode)
        setReviews(st.reviews)
        setBaseBranch(st.baseBranch)
        setClients(st.clients)
      })
    })()
    return () => {
      unsubActivity()
      unsubState()
      unsubDraftAdd()
      unsubReload()
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (!mcpOpen) return
    function onDown(e: MouseEvent): void {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setMcpOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setMcpOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [mcpOpen])

  useEffect(() => {
    if (!keysOpen) return
    function onDown(e: MouseEvent): void {
      if (keysRef.current && !keysRef.current.contains(e.target as Node)) setKeysOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setKeysOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [keysOpen])

  function applyActivity(ev: ActivityEvent): void {
    setRuns((prev) => {
      if (ev.kind === 'run-started') return [...prev, ev.run]
      if (ev.kind === 'run-output')
        return prev.map((r) => (r.runId === ev.runId ? { ...r, output: r.output + ev.chunk } : r))
      if (ev.kind === 'run-finished')
        return prev.map((r) =>
          r.runId === ev.runId ? { ...r, status: ev.status, exitCode: ev.exitCode, finishedAt: ev.finishedAt } : r
        )
      return prev
    })
  }

  async function toggleMutations(): Promise<void> {
    setAllowMutations(await window.tangos.setMutations(!allowMutations))
  }
  async function toggleSafeMode(): Promise<void> {
    setSafeMode(await window.tangos.setSafeMode(!safeMode))
  }
  async function setEnabled(ids: string[]): Promise<void> {
    setEnabledIds(ids)
    await window.tangos.setEnabledTools(ids)
  }
  function addToBatch(item: BatchItem): void {
    setDraft((d) => (d.items.some((i) => i.ref === item.ref) ? d : { ...d, items: [...d.items, item] }))
  }
  function switchApp(target: AppView): void {
    if (target === view) return
    setSplash(APP_LABEL[target])
    setView(target)
    window.setTimeout(() => setSplash(null), 1750)
  }
  async function changeRepo(): Promise<void> {
    const r = await window.tangos.pickRepo()
    if (r.path) {
      setRepo(r)
      setView('console')
    }
  }
  async function reloadDescriptor(): Promise<void> {
    setRepo(await window.tangos.reloadDescriptor())
  }

  const descriptorOk = !!repo?.descriptor && (repo?.validationErrors?.length ?? 0) === 0
  const showControls = !!repo?.path && descriptorOk

  const consoleBody = (
    <div className="workspace">
      <div className="col left aero-scroll">
        <div className={`req-slot${reqAllSet ? ' below' : ''}`}>
          <Requirements repo={repo!} onStatus={setReqAllSet} />
        </div>
        <ToolPalette repo={repo!} allowMutations={allowMutations} enabledIds={enabledIds} onSetEnabled={setEnabled} />
      </div>
      <div className="col right-col">
        <LiveViewer runs={runs} onClear={() => setRuns([])} />
        <div className="mcp-footer">
          <div className="pop-wrap up" ref={popRef}>
            <button className={`tb-btn ${mcp?.running ? 'on' : 'off'}`} onClick={() => setMcpOpen((o) => !o)}>
              <span className="dot" />
              MCP: {mcp?.running ? 'ON' : 'OFF'}
            </button>
            <div className={`bubble-pop aero-panel${mcpOpen ? ' open' : ''}`}>
              <McpBubble mcp={mcp} onMcp={setMcp} clients={clients} />
            </div>
          </div>
          {mcp?.running && <span className="mcp-foot-url mono">{mcp.url}</span>}
        </div>
      </div>
    </div>
  )

  let body: JSX.Element
  if (!repo?.path) body = <div className="center-stage"><RepoPicker onChanged={setRepo} /></div>
  else if (!repo.hasDescriptor || !descriptorOk) body = <div className="center-stage"><DescriptorGate repo={repo} onChanged={setRepo} /></div>
  else body = view === 'atlas'
    ? <AtlasView
        onAdd={addToBatch}
        liveEnabled={!!repo?.descriptor?.data?.committedDbUrl}
        claimsEnabled={!!repo?.descriptor?.data?.claimsApi}
      />
    : consoleBody

  return (
    <div className="app">
      <div className="topbar">
        {showControls ? (
          <AppSwitcher view={view} onSwitch={switchApp} />
        ) : (
          <div className="brand"><span>tang<span className="os">OS</span></span><span className="sub">Chaos Tools</span></div>
        )}
        {repo?.path && (
          <button className="repo-chip" title={`${repo.path}\n(click to choose a different repo)`} onClick={changeRepo}>
            <FolderOpen size={14} style={{ flex: 'none', opacity: 0.7 }} />
            <span className="name">{repo.descriptor?.project?.title ?? 'repo'}</span>
            <span className="path">{repo.path}</span>
          </button>
        )}
        <div className="spacer" />
        {showControls && (
          <>
            <button
              className={`tb-btn ${allowMutations ? 'warn' : ''}`}
              onClick={toggleMutations}
              title={allowMutations ? 'Tools may write to the repo' : 'Read-only: mutating tools are blocked'}
            >
              {allowMutations ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
              Writes: {allowMutations ? 'ON' : 'OFF'}
            </button>
            <button
              className={`tb-btn ${safeMode ? 'active' : ''}`}
              onClick={toggleSafeMode}
              title={safeMode ? 'Mutations run on tangos/work for review before merge' : 'Mutations write straight to your branch'}
            >
              <GitBranch size={14} />
              Review: {safeMode ? 'ON' : 'OFF'}
            </button>
            <div className="pop-wrap" ref={keysRef}>
              <button
                className={`tb-btn ${keysOpen ? 'active' : ''}`}
                onClick={() => setKeysOpen((o) => !o)}
                title="Securely store API keys for tools that call an HTTP service instead of MCP"
              >
                <KeyRound size={14} />
                Keys
              </button>
              <div className={`bubble-pop aero-panel${keysOpen ? ' open' : ''}`}>
                {keysOpen && <KeyVault />}
              </div>
            </div>
            <button
              className="tb-btn icononly"
              onClick={reloadDescriptor}
              title="Reload tangos.json from disk (edits also hot-reload automatically on save)"
            >
              <RefreshCw size={14} />
            </button>
          </>
        )}
        <select className="theme-select" value={theme} onChange={(e) => setTheme(e.target.value)}>
          {THEMES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <WindowControls />
      </div>

      {body}

      {showControls && reviews.length > 0 && <ReviewPanel reviews={reviews} baseBranch={baseBranch} />}
      {showControls && <PromptComposer draft={draft} onDraft={setDraft} batches={batches} mcpRunning={!!mcp?.running} />}
      {splash && <Splash label={splash} />}
      {reloadNote && <div className="reload-toast aero-glass">{reloadNote}</div>}
    </div>
  )
}
