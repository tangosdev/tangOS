import { useEffect, useRef, useState } from 'react'
import { Settings2, FolderOpen, RefreshCw, AlertTriangle, MessageCircle, Bug } from 'lucide-react'
import type {
  RepoState, McpState, ActivityRun, ActivityEvent, Batch, BatchItem, Review, AiAgent
} from '../../shared/types'
import RepoPicker from './components/RepoPicker'
import DescriptorGate from './components/DescriptorGate'
import ToolPalette from './components/ToolPalette'
import McpBubble from './components/McpBubble'
import Requirements from './components/Requirements'
import Controller from './components/Controller'
import AiDetail from './components/AiDetail'
import SettingsPanel from './components/Settings'
import AtlasView from './components/AtlasView'
import TangoHelper from './components/TangoHelper'
import TangoTour from './components/TangoTour'
import AppSwitcher, { type AppView } from './components/AppSwitcher'
import Splash from './components/Splash'
import ReviewPanel from './components/ReviewPanel'
import WindowControls from './components/WindowControls'
import BugReport from './components/BugReport'

const THEMES = ['aero', 'sunset', 'deepsea', 'bubblegum', 'mint', 'hal']
const APP_LABEL: Record<AppView, string> = { console: 'Chaos Controller', atlas: 'Chaos Viewer' }
const MAX_RUNS = 200 // cap the live run history the renderer holds (bus keeps its own 300)

export default function App(): JSX.Element {
  const [repo, setRepo] = useState<RepoState | null>(null)
  const [mcp, setMcp] = useState<McpState | null>(null)
  const [allowMutations, setAllowMutations] = useState(true)
  const [enabledIds, setEnabledIds] = useState<string[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [theme, setTheme] = useState('aero')
  const [runs, setRuns] = useState<ActivityRun[]>([])
  const [mcpOpen, setMcpOpen] = useState(false)
  const [reqAllSet, setReqAllSet] = useState(false)
  const [view, setView] = useState<AppView>('console')
  const [splash, setSplash] = useState<string | null>(null)
  const [safeMode, setSafeMode] = useState(false)
  const [reviews, setReviews] = useState<Review[]>([])
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [agents, setAgents] = useState<AiAgent[]>([])
  const [cart, setCart] = useState<BatchItem[]>([]) // functions picked in the Viewer, to assign as a custom batch
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportsEnabled, setReportsEnabled] = useState(false)
  const [version, setVersion] = useState('')
  const [useAgents, setUseAgents] = useState(false)
  const [autoLand, setAutoLand] = useState(true)
  const [autoPush, setAutoPush] = useState<{
    enabled: boolean
    on: boolean
    state: 'idle' | 'pushing' | 'ok' | 'error' | 'skipped'
    message?: string
    prUrl?: string
    at?: number
  }>({ enabled: false, on: false, state: 'idle' })
  const [looping, setLooping] = useState<string[]>([])
  const [tourSeen, setTourSeen] = useState(true) // assume seen until state loads, to avoid a flash
  const [detailName, setDetailName] = useState<string | null>(null)
  const [reloadNote, setReloadNote] = useState<string | null>(null)
  const [bugOpen, setBugOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let unsubActivity = (): void => {}
    let unsubState = (): void => {}
    const unsubReload = window.tangos.onDescriptorReloaded((info) => {
      const errs = info.errors ? ` · ${info.errors} error(s)` : ''
      setReloadNote(`Descriptor reloaded · ${info.toolCount} tools${errs}`)
      window.setTimeout(() => setReloadNote(null), 2600)
    })
    const unsubDebug = window.tangos.onDebugDumped(() => {
      setReloadNote('Debug snapshot saved')
      window.setTimeout(() => setReloadNote(null), 2200)
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
      setAgents(s.agents)
      setReportsEnabled(s.reportsEnabled)
      setUseAgents(s.useAgents)
      setAutoLand(s.autoLand)
      setAutoPush(s.autoPush)
      setLooping(s.looping)
      setTourSeen(s.tourSeen)
      setRuns((await window.tangos.activitySnapshot()).slice(-MAX_RUNS))
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
        setAgents(st.agents)
        setReportsEnabled(st.reportsEnabled)
        setUseAgents(st.useAgents)
        setAutoLand(st.autoLand)
        setAutoPush(st.autoPush)
        setLooping(st.looping)
        setTourSeen(st.tourSeen)
      })
    })()
    return () => {
      unsubActivity()
      unsubState()
      unsubReload()
      unsubDebug()
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    window.tangos.appVersion().then(setVersion).catch(() => {})
  }, [])

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
    if (!settingsOpen) return
    function onDown(e: MouseEvent): void {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [settingsOpen])

  function applyActivity(ev: ActivityEvent): void {
    setRuns((prev) => {
      if (ev.kind === 'run-started') {
        // Keep the list bounded — a long scan is hundreds of runs, and every output chunk
        // maps this array, so an unbounded list turns each chunk into quadratic work.
        const next = prev.length >= MAX_RUNS ? prev.slice(prev.length - MAX_RUNS + 1) : prev
        return [...next, ev.run]
      }
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
  function switchApp(target: AppView): void {
    if (target === view) return
    setSplash(APP_LABEL[target])
    // Swap the view only once the splash has fully faded in to cover the screen
    // (splashSeq is opaque from ~350ms), so the destination never flashes underneath.
    window.setTimeout(() => setView(target), 450)
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
  function addToCart(item: BatchItem): void {
    setCart((c) => (c.some((i) => i.ref === item.ref) ? c : [...c, item]))
  }
  function removeFromCart(ref: string): void {
    setCart((c) => c.filter((i) => i.ref !== ref))
  }
  async function assignCart(agent: string): Promise<void> {
    if (!cart.length) return
    const items = cart
    setCart([]) // clear immediately so a repeated click can't enqueue the same picks again
    try {
      await window.tangos.assignBatch(
        { title: `Custom batch (${items.length})`, prompt: 'Match these hand-picked targets.', items },
        agent
      )
    } catch (e) {
      setCart(items) // restore the cart if the assign failed
      alert(String((e as Error).message ?? e))
    }
  }

  const descriptorOk = !!repo?.descriptor && (repo?.validationErrors?.length ?? 0) === 0
  const showControls = !!repo?.path && descriptorOk
  const detailAgent = detailName ? agents.find((a) => a.name === detailName) ?? null : null

  const mcpPill = (
    <div className="pop-wrap" data-tour="mcp" ref={popRef}>
      <button className={`tb-btn ${mcp?.running ? 'on' : 'off'}`} onClick={() => setMcpOpen((o) => !o)}>
        <span className="dot" />
        MCP: {mcp?.running ? 'ON' : 'OFF'}
      </button>
      <div className={`bubble-pop aero-panel solid${mcpOpen ? ' open' : ''}`}>
        {mcpOpen && <McpBubble mcp={mcp} onMcp={setMcp} />}
      </div>
    </div>
  )

  const consoleBody = (
    <div className="workspace ctl-workspace">
      <Controller
        agents={agents}
        runs={runs}
        batches={batches}
        looping={looping}
        cartCount={cart.length}
        onAssignCart={assignCart}
        onClearCart={() => setCart([])}
        onOpenViewer={() => switchApp('atlas')}
        allowMutations={allowMutations}
        safeMode={safeMode}
        autoPush={autoPush}
        onToggleWrites={toggleMutations}
        onToggleReview={toggleSafeMode}
        onOpenDetail={setDetailName}
        mcpControl={mcpPill}
      />
      <div className="right-rail aero-scroll">
        <ToolPalette repo={repo!} allowMutations={allowMutations} enabledIds={enabledIds} onSetEnabled={setEnabled} />
        <div className="req-slot below">
          <Requirements repo={repo!} onStatus={setReqAllSet} />
        </div>
      </div>
    </div>
  )

  let body: JSX.Element
  if (!repo?.path) body = <div className="center-stage"><RepoPicker onChanged={setRepo} /></div>
  else if (!repo.hasDescriptor || !descriptorOk) body = <div className="center-stage"><DescriptorGate repo={repo} onChanged={setRepo} /></div>
  else body = view === 'atlas'
    ? <AtlasView
        onAdd={addToCart}
        onRemove={removeFromCart}
        draftRefs={new Set(cart.map((i) => i.ref))}
        liveEnabled={!!repo?.descriptor?.data?.committedDbUrl}
        claimsEnabled={!!repo?.descriptor?.data?.claimsApi}
      />
    : consoleBody

  return (
    <div className="app">
      <div className="topbar">
        <div className="tb-left">
          <div className="brand">
            <span>tang<span className="os">OS</span></span>
            {!showControls && <span className="sub">Chaos Controller</span>}
          </div>
        </div>
        <div className="tb-center">{showControls && <AppSwitcher view={view} onSwitch={switchApp} />}</div>
        <div className="tb-right">
          {repo?.path && !showControls && (
            <button className="repo-chip" title={repo.path} onClick={changeRepo}>
              <FolderOpen size={14} style={{ flex: 'none', opacity: 0.7 }} />
              <span className="path">{repo.path}</span>
            </button>
          )}
          {showControls && (
            <button className="tb-btn icononly" onClick={() => setBugOpen(true)} title="Report a bug">
              <Bug size={15} />
            </button>
          )}
          {showControls && repo?.descriptor?.project?.discord && (
            <button
              className="tb-btn icononly discord"
              onClick={() => window.tangos.openExternal(repo.descriptor!.project.discord!)}
              title="Join the Discord"
            >
              <MessageCircle size={15} />
            </button>
          )}
          {showControls && (
            <button className="tb-btn icononly" onClick={reloadDescriptor} title="Reload tangos.json from disk">
              <RefreshCw size={15} />
            </button>
          )}
          {showControls && (
            <div className="pop-wrap" data-tour="settings" ref={settingsRef}>
              <button
                className={`tb-btn icononly ${settingsOpen ? 'active' : ''}`}
                onClick={() => setSettingsOpen((o) => !o)}
                title="Settings — keys, theme, repo"
              >
                <Settings2 size={15} />
              </button>
              <div className={`bubble-pop aero-panel solid${settingsOpen ? ' open' : ''}`}>
                {settingsOpen && (
                  <SettingsPanel
                    repo={repo}
                    theme={theme}
                    themes={THEMES}
                    onTheme={setTheme}
                    onPickRepo={changeRepo}
                    reportsEnabled={reportsEnabled}
                    useAgents={useAgents}
                    autoLand={autoLand}
                  />
                )}
              </div>
            </div>
          )}
          <WindowControls />
        </div>
      </div>

      {repo?.path && repo.isGit === false && (
        <div className="repo-warn">
          <AlertTriangle size={14} />
          <span>
            This folder isn&apos;t a git checkout — looks like a <b>Download ZIP</b>. You can&apos;t commit or push from
            here, and the tooling may be out of date. Use <code>git clone</code> for a working setup.
          </span>
        </div>
      )}

      {body}

      {showControls && reviews.length > 0 && <ReviewPanel reviews={reviews} baseBranch={baseBranch} />}
      {showControls && view === 'console' && tourSeen && <TangoHelper firstRun={false} />}
      {showControls && view === 'console' && !tourSeen && (
        <TangoTour onDone={() => window.tangos.markTourSeen()} />
      )}
      {detailAgent && <AiDetail agent={detailAgent} runs={runs} onClose={() => setDetailName(null)} />}
      {splash && <Splash label={splash} />}
      {bugOpen && <BugReport repoName={repo?.descriptor?.project?.title} onClose={() => setBugOpen(false)} />}
      {reloadNote && <div className="reload-toast aero-glass">{reloadNote}</div>}
      {version && <div className="app-version" title="Running version">v{version}</div>}
    </div>
  )
}
