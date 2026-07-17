import { useEffect, useMemo, useRef, useState } from 'react'
import { Settings2, FolderOpen, RefreshCw, MessageCircle, Bug } from 'lucide-react'
import type {
  RepoState, McpState, ActivityRun, ActivityEvent, Batch, BatchItem, Review, AiAgent, BackgroundPrefs,
  MatchingPrefs
} from '../../shared/types'
import RepoPicker from './components/RepoPicker'
import DescriptorGate from './components/DescriptorGate'
import Encyclopedia from './components/Encyclopedia'
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
import RepoUpdateBanner from './components/RepoUpdateBanner'
import AppUpdateBanner from './components/AppUpdateBanner'
import GradientBackground from './components/GradientBackground'
import { paletteForTheme } from './components/gradientThemes'
import { UPDATE_NOTE } from './updateNote'

const THEMES = ['aero', 'sunset', 'deepsea', 'bubblegum', 'lemonlime']
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
  const [agentFanout, setAgentFanout] = useState(8)
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
  const [updateNoteSeen, setUpdateNoteSeen] = useState(UPDATE_NOTE.id) // assume seen until state loads
  const [detailName, setDetailName] = useState<string | null>(null)
  const [reloadNote, setReloadNote] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0) // top-bar refresh: re-check repo staleness + app update
  const [bugOpen, setBugOpen] = useState(false)
  const [encyOpen, setEncyOpen] = useState(false) // the tools Encyclopedia overlay (footer paper button)
  const [bgPrefs, setBgPrefs] = useState<BackgroundPrefs>({ enabled: true })
  const [matchingPrefs, setMatchingPrefs] = useState<MatchingPrefs>({
    allowNearMiss: true,
    allowGhidra: false
  })
  const popRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsubReload = window.tangos.onDescriptorReloaded((info) => {
      const errs = info.errors ? ` · ${info.errors} error(s)` : ''
      setReloadNote(`Descriptor reloaded · ${info.toolCount} tools${errs}`)
      window.setTimeout(() => setReloadNote(null), 2600)
    })
    const unsubDebug = window.tangos.onDebugDumped(() => {
      setReloadNote('Debug snapshot saved')
      window.setTimeout(() => setReloadNote(null), 2200)
    })
    // Subscribe SYNCHRONOUSLY, never inside the async block below. If a subscribe sits after an
    // await, StrictMode's dev mount -> cleanup -> remount runs this effect's cleanup before the
    // awaited subscribe has happened, so the listener can't be removed and a second one leaks -
    // every activity/state event then fires twice (the doubled live-viewer output).
    const unsubActivity = window.tangos.onActivity(applyActivity)
    // Popout windows relay their "Add to batch" clicks here (draft:addItem -> draft:add). This
    // subscription is what receives them - it was dropped in the v3.0.0 redesign, which silently
    // broke every popout add: the relay fired into a window with no listener.
    const unsubDraft = window.tangos.onDraftAdd((item) => {
      addToCart(item)
      setReloadNote(`Added ${item.ref} to the batch cart`)
      window.setTimeout(() => setReloadNote(null), 2200)
    })
    const unsubState = window.tangos.onState((st) => {
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
      setAgentFanout(st.agentFanout ?? 8)
      setAutoLand(st.autoLand)
      setAutoPush(st.autoPush)
      setLooping(st.looping)
      setTourSeen(st.tourSeen)
      setUpdateNoteSeen(st.updateNoteSeen)
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
      setAgentFanout(s.agentFanout ?? 8)
      setAutoLand(s.autoLand)
      setAutoPush(s.autoPush)
      setLooping(s.looping)
      setTourSeen(s.tourSeen)
      setUpdateNoteSeen(s.updateNoteSeen)
      setRuns((await window.tangos.activitySnapshot()).slice(-MAX_RUNS))
    })()
    return () => {
      unsubActivity()
      unsubDraft()
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
    window.tangos.bgPrefsGet().then(setBgPrefs).catch(() => {})
    window.tangos.matchingPrefsGet().then(setMatchingPrefs).catch(() => {})
  }, [])

  async function updateBgPrefs(p: Partial<BackgroundPrefs>): Promise<void> {
    setBgPrefs(await window.tangos.bgPrefsSet(p))
  }

  async function updateMatchingPrefs(p: Partial<MatchingPrefs>): Promise<void> {
    setMatchingPrefs(await window.tangos.matchingPrefsSet(p))
  }

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
        // Keep the list bounded - a long scan is hundreds of runs, and every output chunk
        // maps this array, so an unbounded list turns each chunk into quadratic work.
        const next = prev.length >= MAX_RUNS ? prev.slice(prev.length - MAX_RUNS + 1) : prev
        return [...next, ev.run]
      }
      if (ev.kind === 'run-output')
        // Cap the live copy like the main-process bus does (200k): an unbounded string means every
        // append copies the whole thing - O(n^2) growth and GC churn over a long drive.
        return prev.map((r) =>
          r.runId === ev.runId ? { ...r, output: (r.output + ev.chunk).slice(-200_000) } : r
        )
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
    // Also re-check local-vs-origin and the app-update feed, so one refresh clears a now-stale
    // "your local is behind" banner (e.g. a PR merged upstream) and surfaces a newer release.
    setRefreshNonce((n) => n + 1)
  }
  function addToCart(item: BatchItem): void {
    setCart((c) => (c.some((i) => i.ref === item.ref) ? c : [...c, item]))
  }
  /** Marquee replace: the box's picks BECOME the cart (deduped by ref - sibling thunks share names). */
  function replaceCart(items: BatchItem[]): void {
    const seen = new Set<string>()
    setCart(items.filter((i) => (seen.has(i.ref) ? false : (seen.add(i.ref), true))))
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
    // All requirements satisfied -> the rail collapses to hug the compact "all set" chip on the
    // right edge and the Controller takes the width back; anything missing -> full-width panel.
    <div className={`workspace ctl-workspace${reqAllSet ? ' reqs-ok' : ''}`}>
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
        onOpenEncyclopedia={() => setEncyOpen(true)}
        mcpControl={mcpPill}
      />
      <div className="right-rail aero-scroll">
        {/* The tool list moved to the Chaos Codex tab (it's reference material, not controls);
            the rail now leads with what a new contributor actually needs: setup status. */}
        <div className="req-slot below">
          <Requirements repo={repo!} onStatus={setReqAllSet} />
        </div>
      </div>
    </div>
  )

  // Stable identity so the viewer's setOptions (and its cart-node recompute) only re-runs when the
  // cart actually changes - not on every activity/state re-render that keeps the atlas mounted.
  const draftRefs = useMemo(() => new Set(cart.map((i) => i.ref)), [cart])

  let body: JSX.Element
  if (!repo?.path) body = <div className="center-stage"><RepoPicker onChanged={setRepo} /></div>
  else if (!repo.hasDescriptor || !descriptorOk) body = <div className="center-stage"><DescriptorGate repo={repo} onChanged={setRepo} /></div>
  else body = view === 'atlas'
    ? <AtlasView
        onAdd={addToCart}
        onRemove={removeFromCart}
        onReplace={replaceCart}
        draftRefs={draftRefs}
        liveEnabled={!!repo?.descriptor?.data?.committedDbUrl}
      />
    : consoleBody

  return (
    <div className="app">
      {bgPrefs.enabled && <GradientBackground palette={paletteForTheme(theme)} />}
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
            <button
              className="tb-btn icononly"
              onClick={reloadDescriptor}
              title="Refresh: reload tangos.json, re-check if your local is behind, and look for an app update"
            >
              <RefreshCw size={15} />
            </button>
          )}
          {showControls && (
            <div className="pop-wrap" data-tour="settings" ref={settingsRef}>
              <button
                className={`tb-btn icononly ${settingsOpen ? 'active' : ''}`}
                onClick={() => setSettingsOpen((o) => !o)}
                title="Settings - keys, theme, repo"
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
                    agentFanout={agentFanout}
                    autoLand={autoLand}
                    bgPrefs={bgPrefs}
                    onBgPrefs={updateBgPrefs}
                    matchingPrefs={matchingPrefs}
                    onMatchingPrefs={updateMatchingPrefs}
                  />
                )}
              </div>
            </div>
          )}
          <WindowControls />
        </div>
      </div>

      <AppUpdateBanner refreshNonce={refreshNonce} />

      {repo?.path && (
        <RepoUpdateBanner
          repo={repo}
          refreshNonce={refreshNonce}
          onRepo={(r) => {
            setRepo(r)
            setView('console')
          }}
        />
      )}

      {body}

      {showControls && reviews.length > 0 && <ReviewPanel reviews={reviews} baseBranch={baseBranch} />}
      {showControls && view === 'console' && tourSeen && (
        <TangoHelper firstRun={false} note={updateNoteSeen === UPDATE_NOTE.id ? null : UPDATE_NOTE} />
      )}
      {showControls && view === 'console' && !tourSeen && (
        <TangoTour onDone={() => window.tangos.markTourSeen()} />
      )}
      {detailAgent && <AiDetail agent={detailAgent} runs={runs} onClose={() => setDetailName(null)} />}
      {encyOpen && repo?.descriptor && (
        <Encyclopedia
          repo={repo}
          allowMutations={allowMutations}
          enabledIds={enabledIds}
          onSetEnabled={setEnabled}
          onClose={() => setEncyOpen(false)}
        />
      )}
      {splash && <Splash label={splash} palette={paletteForTheme(theme)} />}
      {bugOpen && <BugReport repoName={repo?.descriptor?.project?.title} onClose={() => setBugOpen(false)} />}
      {reloadNote && <div className="reload-toast aero-glass">{reloadNote}</div>}
      {version && <div className="app-version" title="Running version">v{version}</div>}
    </div>
  )
}
