import { useEffect, useMemo, useRef, useState } from 'react';
import { getPersistedArtifactUrl } from './lib/file-system';
import {
  type BenchPhase,
  type EngineResult,
  getBenchPhase,
  getBenchFileName,
  getBenchFileSize,
  loadBenchFile,
  loadEngineResult,
  saveEngineResult,
  setBenchPhase,
  startBench,
} from './lib/bench-store';
import type {
  ArtifactInfo,
  EntitySummary,
  RuntimeStats,
  TreeNode,
  ViewerAdapter,
  ViewerMetric,
  ViewerState,
} from './types';

function IconBase({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function DetailsIcon() {
  return (
    <IconBase>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h10" />
    </IconBase>
  );
}

function HomeIcon() {
  return (
    <IconBase>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M6 10.5V20h12v-9.5" />
    </IconBase>
  );
}

function IconToolbarButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`toolbar-icon-btn${pressed ? ' active' : ''}`}
      onClick={onClick}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

function PanelTitle({
  icon,
  text,
}: {
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <span className="floating-panel-caption">
      <span className="floating-panel-icon" aria-hidden="true">{icon}</span>
      <span>{text}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Draggable panel hook (bottom-anchored details panel)
// ---------------------------------------------------------------------------
function useDraggablePanelFromBottom(initialX: number, initialBottom: number) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | { left: number; bottom: number }>({
    left: initialX,
    bottom: initialBottom,
  });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    const panelEl = panelRef.current;
    if (!panelEl) {
      return;
    }

    const parentEl = panelEl.offsetParent as HTMLElement | null;
    const parentRect = parentEl?.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const currentLeft = panelRect.left - (parentRect?.left ?? 0);
    const currentTop = panelRect.top - (parentRect?.top ?? 0);

    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: currentLeft, oy: currentTop };
    setPos({ left: currentLeft, top: currentTop });
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        left: dragRef.current.ox + e.clientX - dragRef.current.sx,
        top: dragRef.current.oy + e.clientY - dragRef.current.sy,
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const style = 'top' in pos ? ({ left: pos.left, top: pos.top } as const) : ({ left: pos.left, bottom: pos.bottom } as const);
  return { panelRef, style, onHeaderMouseDown };
}

const initialViewerState = (): ViewerState => ({
  ready: false,
  busy: false,
  progress: { phase: 'Idle', percent: 0 },
  logs: ['Waiting for IFC file...'],
  metrics: [],
  artifacts: [],
  tree: [],
  entityIndex: {},
});

function viewerLabelValue(metrics: ViewerMetric[], label: string): string {
  return metrics.find((metric) => metric.label === label)?.value ?? '—';
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function useViewerState(title: string) {
  const [state, setState] = useState<ViewerState>(initialViewerState);

  const api = useMemo(
    () => ({
      resetForRun(phase = 'Initializing') {
        setState({
          ready: true,
          busy: true,
          progress: { phase, percent: 0 },
          logs: [`${title}: reset`, `${title}: waiting for parsing pipeline`],
          metrics: [],
          artifacts: [],
          tree: [],
          entityIndex: {},
          openStartedAt: undefined,
          openMs: undefined,
        });
      },
      // Start the model-open stopwatch for this viewer. Called right before the
      // adapter begins work so each engine is timed in isolation (sequential runs).
      startTimer() {
        setState((current) => ({ ...current, openStartedAt: performance.now(), openMs: undefined }));
      },
      markReady() {
        setState((current) => ({ ...current, ready: true }));
      },
      setError(error: string) {
        setState((current) => ({
          ...current,
          busy: false,
          error,
          openMs: current.openStartedAt !== undefined ? performance.now() - current.openStartedAt : current.openMs,
          logs: [...current.logs, `${title}: ERROR ${error}`],
        }));
      },
      finish() {
        setState((current) => ({
          ...current,
          busy: false,
          openMs: current.openStartedAt !== undefined ? performance.now() - current.openStartedAt : current.openMs,
        }));
      },
      setProgress(phase: string, percent: number) {
        setState((current) => ({ ...current, progress: { phase, percent } }));
      },
      appendLog(message: string) {
        setState((current) => ({ ...current, logs: [...current.logs, message].slice(-120) }));
      },
      setMetrics(metrics: ViewerMetric[]) {
        setState((current) => ({ ...current, metrics }));
      },
      setArtifacts(artifacts: ViewerState['artifacts']) {
        setState((current) => ({ ...current, artifacts }));
      },
      setTree(tree: TreeNode[]) {
        setState((current) => ({ ...current, tree }));
      },
      setEntityIndex(entityIndex: Record<number, EntitySummary>) {
        setState((current) => ({ ...current, entityIndex }));
      },
      setSelected(entity?: EntitySummary) {
        setState((current) => ({ ...current, selected: entity }));
      },
      // Restore a finished viewer from a stored benchmark result (used for the
      // engine that was measured on a previous, now-reloaded, page).
      hydrate(result: { metrics: ViewerMetric[]; artifacts: ArtifactInfo[]; logs: string[]; openMs?: number; error?: string }) {
        setState((current) => ({
          ...current,
          ready: true,
          busy: false,
          error: result.error,
          progress: { phase: result.error ? 'Error' : 'Complete', percent: 100 },
          logs: result.logs,
          metrics: result.metrics,
          artifacts: result.artifacts,
          openMs: result.openMs,
        }));
      },
    }),
    [title],
  );

  return { state, api };
}

const INFO_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Model', keys: ['Entities', 'Meshes', 'Fragments', 'Spatial roots'] },
  {
    label: 'Performance',
    keys: [
      'IFC parsing time',
      'IFC conversion time',
      'First geometry frame',
      'Render ready time',
      'Fragment buffer encode time',
      'Artifact save time',
      'End-to-end time',
    ],
  },
  { label: 'Output', keys: ['Artifact size'] },
];

function InfoTab({ state }: { state: ViewerState }) {
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const createdUrls: string[] = [];

    const loadArtifactUrls = async () => {
      const entries = await Promise.all(
        state.artifacts.map(async (artifact) => {
          if (artifact.path === 'browser-memory') {
            return [artifact.path, ''] as const;
          }
          const url = await getPersistedArtifactUrl(artifact.path);
          if (url) {
            createdUrls.push(url);
          }
          return [artifact.path, url ?? ''] as const;
        }),
      );

      if (!active) {
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }

      setArtifactUrls(
        Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))),
      );
    };

    void loadArtifactUrls();

    return () => {
      active = false;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      setArtifactUrls({});
    };
  }, [state.artifacts]);

  const metricMap = new Map(state.metrics.map((m) => [m.label, m.value]));
  const assignedKeys = new Set(INFO_GROUPS.flatMap((g) => g.keys));
  const ungrouped = state.metrics.filter((m) => !assignedKeys.has(m.label) && m.label !== 'Schema');

  if (state.metrics.length === 0) {
    return <div className="empty-state">Stats will appear once parsing completes.</div>;
  }

  return (
    <div className="info-tab">
      {INFO_GROUPS.map((group) => {
        const rows = group.keys.filter((k) => metricMap.has(k));
        if (!rows.length) {
          return null;
        }

        return (
          <section className="info-group" key={group.label}>
            <h4>{group.label}</h4>
            {rows.map((k) => (
              <div className="property-row" key={k}>
                <span>{k}</span>
                <strong>{metricMap.get(k)}</strong>
              </div>
            ))}
          </section>
        );
      })}
      {ungrouped.length > 0 && (
        <section className="info-group" key="other">
          <h4>Other</h4>
          {ungrouped.map((m) => (
            <div className="property-row" key={m.label}>
              <span>{m.label}</span>
              <strong>{m.value}</strong>
            </div>
          ))}
        </section>
      )}
      {state.artifacts.length > 0 && (
        <section className="info-group" key="artifacts">
          <h4>Artifacts</h4>
          {state.artifacts.map((a) => (
            <div className="property-row" key={a.path}>
              <span>
                {artifactUrls[a.path] ? (
                  <a
                    className="artifact-link"
                    href={artifactUrls[a.path]}
                    target="_blank"
                    rel="noreferrer"
                    download={a.name}
                  >
                    {a.name}
                  </a>
                ) : (
                  a.name
                )}
              </span>
              <span>{(a.size / 1024).toFixed(1)} KB</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function ProgressLogsTab({ state }: { state: ViewerState }) {
  return (
    <div className="progress-tab">
      <section className="info-group">
        <h4>Progress</h4>
        <div className="property-row">
          <span>Progress</span>
          <strong>{Math.round(state.progress.percent)}%</strong>
        </div>
        <div className="property-row">
          <span>Phase</span>
          <strong>{state.progress.phase}</strong>
        </div>
        <div className="property-row">
          <span>Total runtime</span>
          <strong>{viewerLabelValue(state.metrics, 'End-to-end time')}</strong>
        </div>
      </section>
      <section className="info-group">
        <h4>Logs</h4>
        <pre className="log-pre">{state.logs.join('\n')}</pre>
      </section>
    </div>
  );
}

function BottomInfoPanel({
  state,
  activeTab,
  setActiveTab,
  onClose,
}: {
  state: ViewerState;
  activeTab: 'info' | 'logs';
  setActiveTab: (tab: 'info' | 'logs') => void;
  onClose: () => void;
}) {
  const { panelRef, style, onHeaderMouseDown } = useDraggablePanelFromBottom(10, 10);

  return (
    <div ref={panelRef} className="floating-panel bottom-panel" style={style}>
      <div className="floating-panel-header" onMouseDown={onHeaderMouseDown}>
        <PanelTitle icon={<DetailsIcon />} text="Details" />
        <button className="floating-close" type="button" onClick={onClose}>✕</button>
      </div>
      <div className="tab-bar">
        <button
          className={`tab-btn${activeTab === 'info' ? ' active' : ''}`}
          onClick={() => setActiveTab('info')}
          type="button"
        >
          Stats &amp; Info
        </button>
        <button
          className={`tab-btn${activeTab === 'logs' ? ' active' : ''}`}
          onClick={() => setActiveTab('logs')}
          type="button"
        >
          Progress / Logs
        </button>
      </div>
      <div className="tab-content">
        {activeTab === 'info' ? <InfoTab state={state} /> : <ProgressLogsTab state={state} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heads-up display: live model-open timer, frame rate, and heap memory
// ---------------------------------------------------------------------------
function ViewerHud({ state, stats }: { state: ViewerState; stats: RuntimeStats | null }) {
  const [, forceTick] = useState(0);

  // While a model is opening, repaint the live stopwatch each frame.
  const isTiming = state.busy && state.openStartedAt !== undefined && state.openMs === undefined;
  useEffect(() => {
    if (!isTiming) {
      return undefined;
    }
    let raf = 0;
    const loop = () => {
      forceTick((n) => (n + 1) & 0xffff);
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [isTiming]);

  const openLabel = (() => {
    if (state.openMs !== undefined) {
      return formatSeconds(state.openMs);
    }
    if (isTiming && state.openStartedAt !== undefined) {
      return formatSeconds(performance.now() - state.openStartedAt);
    }
    return '—';
  })();

  const fpsLabel = stats && stats.fps > 0 ? `${Math.round(stats.fps)} fps` : '—';
  const heapLabel = stats?.heapUsedBytes !== undefined ? formatBytes(stats.heapUsedBytes) : 'n/a';

  return (
    <div className="viewer-hud" aria-label="Viewer runtime statistics">
      <div className={`hud-metric${isTiming ? ' active' : ''}`}>
        <span className="hud-label">Open time</span>
        <span className="hud-value">{openLabel}</span>
      </div>
      <div className="hud-metric">
        <span className="hud-label">Frame rate</span>
        <span className="hud-value">{fpsLabel}</span>
      </div>
      <div className="hud-metric">
        <span className="hud-label">Memory (heap)</span>
        <span className="hud-value">{heapLabel}</span>
      </div>
    </div>
  );
}

function ViewerPanel({
  title,
  state,
  stats,
  canvasRef,
  hostRef,
  onReset,
  note,
}: {
  title: string;
  state: ViewerState;
  stats: RuntimeStats | null;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  hostRef?: React.RefObject<HTMLDivElement | null>;
  onReset: () => void;
  note?: string;
}) {
  const [activeTab, setActiveTab] = useState<'info' | 'logs'>('info');
  const [showBottomPanel, setShowBottomPanel] = useState(true);

  return (
    <section className="viewer-panel">
      <header className="viewer-header">
        <div>
          <h2>{title}</h2>
        </div>
        <div className="viewer-header-actions" role="toolbar" aria-label={`${title} viewer tools`}>
          <IconToolbarButton
            label={showBottomPanel ? 'Hide details panel' : 'Show details panel'}
            onClick={() => setShowBottomPanel((v) => !v)}
            pressed={showBottomPanel}
          >
            <DetailsIcon />
          </IconToolbarButton>
          <IconToolbarButton label="Reset view" onClick={onReset}>
            <HomeIcon />
          </IconToolbarButton>
        </div>
      </header>

      <div className="viewer-top">
        <div className="canvas-shell">
          {canvasRef ? <canvas ref={canvasRef} className="viewer-canvas" /> : <div ref={hostRef} className="viewer-host" />}
          {note && <div className="viewport-note">{note}</div>}
          <ViewerHud state={state} stats={stats} />
          {showBottomPanel && (
            <BottomInfoPanel
              state={state}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              onClose={() => setShowBottomPanel(false)}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function resultToStats(result: EngineResult | null): RuntimeStats | null {
  if (!result) {
    return null;
  }
  return { fps: result.fps ?? 0, frameTimeMs: 0, heapUsedBytes: result.heapUsedBytes };
}

export default function App() {
  const ifcLiteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const thatOpenHostRef = useRef<HTMLDivElement | null>(null);
  const ifcLiteAdapterRef = useRef<ViewerAdapter | null>(null);
  const thatOpenAdapterRef = useRef<ViewerAdapter | null>(null);

  // The benchmark phase is fixed for the lifetime of a page load; transitions
  // happen via setBenchPhase(...) + a reload so each engine is measured fresh.
  const [phase] = useState<BenchPhase>(getBenchPhase);

  const selectedFileName = getBenchFileName() ?? 'No IFC file selected';
  const benchSize = getBenchFileSize();
  const selectedFileSize = benchSize !== null ? formatBytes(benchSize) : '—';

  const ifcLite = useViewerState('IFClite');
  const thatOpen = useViewerState('ThatOpen');

  const [ifcLiteStats, setIfcLiteStats] = useState<RuntimeStats | null>(null);
  const [thatOpenStats, setThatOpenStats] = useState<RuntimeStats | null>(null);

  // IFClite is measured on its own page, so in later phases its panel is
  // hydrated from the stored result and its canvas stays empty.
  const ifcLiteMeasuredOnly = phase === 'thatopen' || phase === 'done';
  const ifcLiteStored = useMemo(() => loadEngineResult('ifclite'), []);

  const schemaFromIfcLite = viewerLabelValue(ifcLite.state.metrics, 'Schema');
  const schemaFromThatOpen = viewerLabelValue(thatOpen.state.metrics, 'Schema');
  const selectedFileSchema =
    schemaFromIfcLite !== '—' ? schemaFromIfcLite : schemaFromThatOpen !== '—' ? schemaFromThatOpen : '—';

  useEffect(() => {
    const canvas = ifcLiteCanvasRef.current;
    const host = thatOpenHostRef.current;
    if (!canvas || !host) {
      return undefined;
    }

    let disposed = false;
    let ifcLiteAdapter: ViewerAdapter | null = null;
    let thatOpenAdapter: ViewerAdapter | null = null;

    // Run one engine's pipeline, mirroring progress into the live UI while also
    // collecting a serialisable result to persist across the reload.
    const measure = async (
      adapter: ViewerAdapter,
      api: ReturnType<typeof useViewerState>['api'],
      title: string,
      file: { name: string; buffer: ArrayBuffer },
    ): Promise<EngineResult> => {
      const logs: string[] = [];
      let metrics: ViewerMetric[] = [];
      let artifacts: ArtifactInfo[] = [];
      let error: string | undefined;

      api.resetForRun();
      api.startTimer();
      const startedAt = performance.now();
      try {
        await adapter.load({
          file: new File([file.buffer], file.name),
          buffer: file.buffer,
          onProgress: ({ phase: p, percent }) => !disposed && api.setProgress(p, percent),
          onLog: (message) => {
            logs.push(message);
            if (!disposed) api.appendLog(message);
          },
          onMetrics: (m) => {
            metrics = m;
            if (!disposed) api.setMetrics(m);
          },
          onArtifacts: (a) => {
            artifacts = a;
            if (!disposed) api.setArtifacts(a);
          },
          onTree: () => {},
          onEntityIndex: () => {},
          onSelected: (entity) => !disposed && api.setSelected(entity),
        });
        logs.push(`${title}: pipeline completed.`);
        if (!disposed) {
          api.finish();
          api.appendLog(`${title}: pipeline completed.`);
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        if (!disposed) api.setError(error);
      }

      const openMs = performance.now() - startedAt;
      const snap = adapter.getStats?.();
      return { metrics, artifacts, logs, openMs, error, fps: snap?.fps, heapUsedBytes: snap?.heapUsedBytes };
    };

    const orchestrate = async () => {
      const [{ createIfcLiteAdapter }, { createThatOpenAdapter }] = await Promise.all([
        import(/* webpackChunkName: "viewer-ifclite" */ './lib/ifclite'),
        import(/* webpackChunkName: "viewer-thatopen" */ './lib/thatopen'),
      ]);
      if (disposed) return;

      // Idle: no benchmark in progress — initialise both viewers as empty previews.
      if (phase === 'idle') {
        ifcLiteAdapter = createIfcLiteAdapter(canvas);
        thatOpenAdapter = createThatOpenAdapter(host);
        ifcLiteAdapterRef.current = ifcLiteAdapter;
        thatOpenAdapterRef.current = thatOpenAdapter;
        await Promise.all([ifcLiteAdapter.init(), thatOpenAdapter.init()]);
        if (disposed) return;
        ifcLite.api.markReady();
        thatOpen.api.markReady();
        ifcLite.api.appendLog('IFClite viewer initialized.');
        thatOpen.api.appendLog('ThatOpen viewer initialized.');
        return;
      }

      const file = await loadBenchFile();
      if (!file || disposed) return;

      if (phase === 'ifclite') {
        // Fresh page: only IFClite exists, so it is measured in isolation.
        ifcLiteAdapter = createIfcLiteAdapter(canvas);
        ifcLiteAdapterRef.current = ifcLiteAdapter;
        await ifcLiteAdapter.init();
        if (disposed) return;
        ifcLite.api.markReady();
        const result = await measure(ifcLiteAdapter, ifcLite.api, 'IFClite', file);
        if (disposed) return;
        saveEngineResult('ifclite', result);
        setBenchPhase('thatopen');
        // Let the completed state paint briefly, then reload into the ThatOpen run.
        window.setTimeout(() => window.location.reload(), 700);
        return;
      }

      // phase === 'thatopen' | 'done': IFClite panel is restored from its stored
      // result; ThatOpen is the live viewer.
      if (ifcLiteStored) {
        ifcLite.api.hydrate(ifcLiteStored);
      }
      thatOpenAdapter = createThatOpenAdapter(host);
      thatOpenAdapterRef.current = thatOpenAdapter;
      await thatOpenAdapter.init();
      if (disposed) return;
      thatOpen.api.markReady();

      if (phase === 'thatopen') {
        const result = await measure(thatOpenAdapter, thatOpen.api, 'ThatOpen', file);
        if (disposed) return;
        saveEngineResult('thatopen', result);
        setBenchPhase('done');
        // Stay on this page: ThatOpen's 3D view is live and both metric sets are shown.
        return;
      }

      // phase === 'done' (manual reload after completion): restore metrics and
      // re-load ThatOpen purely for viewing, without overwriting stored metrics.
      const stored = loadEngineResult('thatopen');
      if (stored) {
        thatOpen.api.hydrate(stored);
      }
      await thatOpenAdapter.load({
        file: new File([file.buffer], file.name),
        buffer: file.buffer,
        onProgress: () => {},
        onLog: () => {},
        onMetrics: () => {},
        onArtifacts: () => {},
        onTree: () => {},
        onEntityIndex: () => {},
        onSelected: (entity) => !disposed && thatOpen.api.setSelected(entity),
      });
    };

    void orchestrate();

    return () => {
      disposed = true;
      ifcLiteAdapter?.dispose();
      thatOpenAdapter?.dispose();
    };
  }, [phase, ifcLite.api, thatOpen.api, ifcLiteStored]);

  // Poll live frame-rate / memory statistics from both adapters.
  useEffect(() => {
    const interval = window.setInterval(() => {
      setIfcLiteStats(ifcLiteAdapterRef.current?.getStats?.() ?? null);
      setThatOpenStats(thatOpenAdapterRef.current?.getStats?.() ?? null);
    }, 250);
    return () => window.clearInterval(interval);
  }, []);

  const onBrowse = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) {
      return;
    }
    // Persist the file + arm the benchmark, then reload so IFClite runs on a
    // clean page (fresh V8 heap → honest per-engine timing and memory).
    await startBench(file);
    window.location.reload();
  };

  const ifcLiteNote = ifcLiteMeasuredOnly
    ? 'Measured in isolation on a separate page — see metrics below'
    : undefined;
  const thatOpenNote = phase === 'ifclite' ? 'Queued — runs after the page reloads' : undefined;

  return (
    <main className="app-shell">
      <header className="topbar">
        <label className="browse-button" htmlFor="ifc-file-input">
          Browse
        </label>
        <input id="ifc-file-input" type="file" accept=".ifc" onChange={onBrowse} hidden />
        <div className="file-pill">
          <span>Selected file:</span>
          <strong>{selectedFileName}</strong>
          <span className="file-meta file-meta-size">{selectedFileSize}</span>
          <span className="file-meta">Schema: {selectedFileSchema}</span>
          {phase !== 'idle' && (
            <span className="file-meta">
              {phase === 'ifclite'
                ? 'Measuring IFClite…'
                : phase === 'thatopen'
                ? 'Measuring ThatOpen…'
                : 'Sequential isolated benchmark'}
            </span>
          )}
        </div>
      </header>

      <section className="comparison-grid">
        <ViewerPanel
          title="IFClite"
          state={ifcLite.state}
          stats={ifcLiteMeasuredOnly ? resultToStats(ifcLiteStored) : ifcLiteStats}
          canvasRef={ifcLiteCanvasRef}
          onReset={() => void ifcLiteAdapterRef.current?.reset()}
          note={ifcLiteNote}
        />
        <ViewerPanel
          title="ThatOpen"
          state={thatOpen.state}
          stats={thatOpenStats}
          hostRef={thatOpenHostRef}
          onReset={() => void thatOpenAdapterRef.current?.reset()}
          note={thatOpenNote}
        />
      </section>
    </main>
  );
}
