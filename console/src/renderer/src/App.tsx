import { Fragment, useEffect, useMemo, useState } from 'react'
import { Settings2, FolderOpen, RefreshCw, MessageCircle, Bug, KeyRound } from 'lucide-react'
import type {
  RepoState, McpState, ActivityRun, ActivityEvent, Batch, BatchItem, Review, AiAgent, BackgroundPrefs,
  MatchingPrefs, ProjectSummary
} from '../../shared/types'
import RepoPicker from './components/RepoPicker'
import ProjectMenu from './components/ProjectMenu'
import { useDismiss } from './useDismiss'
import DescriptorGate from './components/DescriptorGate'
import Encyclopedia from './components/Encyclopedia'
import McpBubble from './components/McpBubble'
import Requirements from './components/Requirements'
import Controller from './components/Controller'
import AiDetail from './components/AiDetail'
import SettingsPanel from './components/Settings'
import KeyVault from './components/KeyVault'
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
import ClaimsKeyBanner from './components/ClaimsKeyBanner'
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
  const [vaultOpen, setVaultOpen] = useState(false)
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
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [switchingProject, setSwitchingProject] = useState(false)
  const [splashKey, setSplashKey] = useState(0)
  const popRef = useDismiss<HTMLDivElement>(mcpOpen, () => setMcpOpen(false))
  const settingsRef = useDismiss<HTMLDivElement>(settingsOpen, () => setSettingsOpen(false))
  const vaultRef = useDismiss<HTMLDivElement>(vaultOpen, () => setVaultOpen(false))

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
      setProjects(st.projects ?? [])
      setSwitchingProject(!!st.switchingProject)
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
      setProjects(s.projects ?? [])
      setSwitchingProject(!!s.switchingProject)
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
  // App-level state a component key can't reach, cleared when the project changes.
  //
  // `cart` is the one that matters: its entries are function refs from the OLD project, and
  // assignCart would post them as a batch here, sending an agent after addresses that don't exist
  // in this ROM. The rest is staleness - the run feed, an open AI overlay, popovers describing a
  // project that is no longer open.
  useEffect(() => {
    setCart([])
    setDetailName(null)
    setMcpOpen(false)
    setSettingsOpen(false)
    setVaultOpen(false)
    setEncyOpen(false)
    void window.tangos.activitySnapshot().then((r) => setRuns(r.slice(-MAX_RUNS)))
  }, [repo?.projectId])

  /** Raise the splash. Bumping the key REMOUNTS it, which is what actually replays the animation:
   *  splashSeq only runs on mount, and Splash's pose is a mount-time useMemo. Without this, a
   *  splash raised while one is already showing would sit there frozen and invisible over the
   *  whole window (position: fixed, z-index 200) swallowing every click. */
  function raiseSplash(label: string): void {
    setSplashKey((k) => k + 1)
    setSplash(label)
  }
  function switchApp(target: AppView): void {
    if (target === view) return
    raiseSplash(APP_LABEL[target])
    // Swap the view only once the splash has fully faded in to cover the screen
    // (splashSeq is opaque from ~350ms), so the destination never flashes underneath.
    window.setTimeout(() => setView(target), 450)
    window.setTimeout(() => setSplash(null), 1750)
  }
  /** Switch the whole console to another decomp. Same whoosh as an app switch, and the view is
   *  deliberately kept - switching project while sitting in the Viewer is the point of having
   *  this in the titlebar. */
  async function pickProject(id: string): Promise<void> {
    if (switchingProject) return
    const target = projects.find((p) => p.id === id)
    setSwitchingProject(true)
    raiseSplash(target?.title ?? 'Loading project')
    try {
      // Swap under the opaque part of the splash, as switchApp does.
      await new Promise((r) => window.setTimeout(r, 450))
      setRepo(await window.tangos.switchProject(id))
    } catch (e) {
      setSplash(null)
      setReloadNote(String((e as Error).message ?? e))
      return
    } finally {
      setSwitchingProject(false)
    }
    window.setTimeout(() => setSplash(null), 1300) // 450 + 1300 = the splash's own 1750ms
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

  // Keyed by project so both halves REMOUNT on a switch. AtlasView holds ~20 pieces of state and
  // loads its db, cosmetics, stars and counts from mount-only effects; Controller keeps per-agent
  // busy/size state and the scheduler's output tail. Without the key, switching while sitting in
  // the Viewer leaves the previous decomp's atlas on screen under the new project's name.
  let body: JSX.Element
  if (!repo?.path) body = <div className="center-stage"><RepoPicker onChanged={setRepo} /></div>
  else if (!repo.hasDescriptor || !descriptorOk) body = <div className="center-stage"><DescriptorGate repo={repo} onChanged={setRepo} /></div>
  else body = view === 'atlas'
    ? <AtlasView
        key={repo.projectId ?? repo.path}
        onAdd={addToCart}
        onRemove={removeFromCart}
        onReplace={replaceCart}
        draftRefs={draftRefs}
        liveEnabled={!!repo?.descriptor?.data?.committedDbUrl}
      />
    : <Fragment key={repo.projectId ?? repo.path}>{consoleBody}</Fragment>

  return (
    <div className="app">
      {bgPrefs.enabled && <GradientBackground palette={paletteForTheme(theme)} />}
      <div className="topbar">
        <div className="tb-left">
          <div className="brand">
            <span>tang<span className="os">OS</span></span>
            {!showControls && !repo?.projectId && <span className="sub">Chaos Controller</span>}
          </div>
          {!!repo?.projectId && (
            <ProjectMenu projects={projects} busy={switchingProject} onPick={pickProject} />
          )}
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
                title="Settings - theme, repo, matching"
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
          {showControls && (
            <div className="pop-wrap" data-tour="keyvault" ref={vaultRef}>
              <button
                className={`tb-btn icononly ${vaultOpen ? 'active' : ''}`}
                onClick={() => setVaultOpen((o) => !o)}
                title="API keys - stored encrypted on this machine"
              >
                <KeyRound size={15} />
              </button>
              <div className={`bubble-pop aero-panel solid${vaultOpen ? ' open' : ''}`}>
                {vaultOpen && (
                  <>
                    <div className="section-title">API keys</div>
                    <KeyVault />
                  </>
                )}
              </div>
            </div>
          )}
          <WindowControls />
        </div>
      </div>

      <AppUpdateBanner refreshNonce={refreshNonce} />
      <ClaimsKeyBanner onOpenVault={() => setVaultOpen(true)} />

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
      {splash && <Splash key={splashKey} label={splash} palette={paletteForTheme(theme)} />}
      {bugOpen && <BugReport repoName={repo?.descriptor?.project?.title} onClose={() => setBugOpen(false)} />}
      {reloadNote && <div className="reload-toast aero-glass">{reloadNote}</div>}
      {version && <div className="app-version" title="Running version">v{version}</div>}
    </div>
  )
}
