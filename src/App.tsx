import { useEffect, useMemo, useRef, useState } from 'react';
import { getPersistedArtifactUrl } from './lib/file-system';
import {
  type BenchPhase,
  type EngineId,
  type EngineResult,
  type OrderKey,
  ALL_ENGINES,
  ORDERS,
  clearBenchSession,
  getBenchPhase,
  getBenchFileName,
  getBenchFileSize,
  getOrderPref,
  getRunOrder,
  loadBenchFile,
  loadEngineResult,
  nextEngine,
  saveEngineResult,
  setBenchPhase,
  setOrderPref,
  startBench,
} from './lib/bench-store';
import type {
  ArtifactInfo,
  EntitySummary,
  TreeNode,
  ViewerAdapter,
  ViewerMetric,
  ViewerState,
} from './types';

type Accent = 'ifclite' | 'flat' | 'thatopen';

interface EngineDef {
  id: EngineId;
  title: string;
  subtitle: string;
  accent: Accent;
  kind: 'canvas' | 'host';
}

const ENGINE_DEFS: Record<EngineId, EngineDef> = {
  'ifclite-new': { id: 'ifclite-new', title: 'ifc-lite', subtitle: 'instancing on', accent: 'ifclite', kind: 'canvas' },
  'ifclite-old': { id: 'ifclite-old', title: 'ifc-lite', subtitle: 'instancing off', accent: 'flat', kind: 'canvas' },
  thatopen: { id: 'thatopen', title: 'ThatOpen', subtitle: 'web-ifc', accent: 'thatopen', kind: 'host' },
};

async function createAdapter(id: EngineId, el: HTMLElement): Promise<ViewerAdapter> {
  if (id === 'ifclite-new') {
    const { createIfcLiteAdapter } = await import(/* webpackChunkName: "viewer-ifclite" */ './lib/ifclite');
    return createIfcLiteAdapter(el as HTMLCanvasElement);
  }
  if (id === 'ifclite-old') {
    const { createIfcLiteNoInstancingAdapter } = await import(/* webpackChunkName: "viewer-ifclite-noinst" */ './lib/ifclite-noinstancing');
    return createIfcLiteNoInstancingAdapter(el as HTMLCanvasElement);
  }
  const { createThatOpenAdapter } = await import(/* webpackChunkName: "viewer-thatopen" */ './lib/thatopen');
  return createThatOpenAdapter(el as HTMLDivElement);
}

function IconBase({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
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
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className="toolbar-icon-btn" onClick={onClick} type="button" title={label} aria-label={label}>
      {children}
    </button>
  );
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

// Extract a comparable number from a formatted metric string, normalising to a
// base unit (time → ms, size → bytes, counts → plain).
function parseMetricNumber(value: string): number | null {
  const match = value.match(/([\d.,]+)\s*(ms|s|MB|KB|B)?/i);
  if (!match) return null;
  const n = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  switch ((match[2] ?? '').toLowerCase()) {
    case 's':
      return n * 1000;
    case 'mb':
      return n * 1024 * 1024;
    case 'kb':
      return n * 1024;
    default:
      return n;
  }
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
      hydrate(result: EngineResult) {
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

type ViewerApi = ReturnType<typeof useViewerState>['api'];

// ---------------------------------------------------------------------------
// Comparison table (N engines side by side, in run order)
// ---------------------------------------------------------------------------
interface CompareEngine {
  def: EngineDef;
  state: ViewerState;
}

interface CompareRow {
  label: string;
  get: (state: ViewerState, id: EngineId) => string;
  kind?: 'time' | 'size';
}

const COMPARE_ROWS: CompareRow[] = [
  { label: 'Open time', get: (s) => (s.openMs !== undefined ? formatSeconds(s.openMs) : '—'), kind: 'time' },
  { label: 'End-to-end', get: (s) => viewerLabelValue(s.metrics, 'End-to-end time'), kind: 'time' },
  {
    label: 'Parse / convert',
    get: (s, id) => viewerLabelValue(s.metrics, id === 'thatopen' ? 'IFC conversion time' : 'IFC parsing time'),
    kind: 'time',
  },
  { label: 'Render ready', get: (s) => viewerLabelValue(s.metrics, 'Render ready time'), kind: 'time' },
  {
    label: 'First frame',
    get: (s, id) => (id === 'thatopen' ? '—' : viewerLabelValue(s.metrics, 'First geometry frame')),
    kind: 'time',
  },
  { label: 'Artifact size', get: (s) => viewerLabelValue(s.metrics, 'Artifact size'), kind: 'size' },
  { label: 'Entities', get: (s, id) => (id === 'thatopen' ? '—' : viewerLabelValue(s.metrics, 'Entities')) },
  {
    label: 'Meshes / Fragments',
    get: (s, id) => viewerLabelValue(s.metrics, id === 'thatopen' ? 'Fragments' : 'Meshes'),
  },
  { label: 'Schema', get: (s) => viewerLabelValue(s.metrics, 'Schema') },
];

function ComparisonTable({ engines }: { engines: CompareEngine[] }) {
  const gridStyle = { ['--cols' as string]: String(engines.length) } as React.CSSProperties;
  const hasData = engines.some((e) => e.state.metrics.length > 0);

  if (!hasData) {
    return <div className="cmp-empty">Open an IFC file — each engine is benchmarked on its own fresh page, then compared here.</div>;
  }

  return (
    <div className="cmp-table" role="table" aria-label="Engine comparison" style={gridStyle}>
      <div className="cmp-row cmp-head" role="row">
        <span className="cmp-label" role="columnheader">Metric</span>
        {engines.map((e) => (
          <span className={`cmp-cell cmp-engine ${e.def.accent}`} role="columnheader" key={e.def.id}>
            {e.def.title} <span className="cmp-sub">{e.def.subtitle}</span>
          </span>
        ))}
      </div>
      {COMPARE_ROWS.map((row) => {
        const values = engines.map((e) => row.get(e.state, e.def.id));
        const nums = values.map((v) => (row.kind ? parseMetricNumber(v) : null));
        const valid = nums.filter((n): n is number => n !== null);

        let winnerIdx = -1;
        let badge: string | null = null;
        if (row.kind && valid.length >= 2) {
          const min = Math.min(...valid);
          const max = Math.max(...valid);
          if (min !== max) {
            winnerIdx = nums.findIndex((n) => n === min);
            const ratio = min > 0 ? max / min : 0;
            if (ratio >= 1.05) {
              badge = `×${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)} ${row.kind === 'size' ? 'smaller' : 'faster'}`;
            }
          }
        }

        return (
          <div className="cmp-row" role="row" key={row.label}>
            <span className="cmp-label" role="rowheader">{row.label}</span>
            {engines.map((e, i) => (
              <span className={`cmp-cell${i === winnerIdx ? ' win' : ''}`} role="cell" key={e.def.id}>
                <span className="cmp-value">{values[i]}</span>
                {i === winnerIdx && badge && <span className="cmp-badge">{badge}</span>}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Artifact download links per engine
// ---------------------------------------------------------------------------
function ArtifactLinks({ artifacts }: { artifacts: ArtifactInfo[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const created: string[] = [];
    void (async () => {
      const entries = await Promise.all(
        artifacts.map(async (a) => {
          if (a.path === 'browser-memory') return [a.path, ''] as const;
          const url = await getPersistedArtifactUrl(a.path);
          if (url) created.push(url);
          return [a.path, url ?? ''] as const;
        }),
      );
      if (!active) {
        created.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      setUrls(Object.fromEntries(entries.filter((e): e is readonly [string, string] => Boolean(e[1]))));
    })();
    return () => {
      active = false;
      created.forEach((u) => URL.revokeObjectURL(u));
      setUrls({});
    };
  }, [artifacts]);

  if (artifacts.length === 0) {
    return <span className="artifact-empty">—</span>;
  }

  return (
    <ul className="artifact-list">
      {artifacts.map((a) => (
        <li key={a.path}>
          {urls[a.path] ? (
            <a className="artifact-link" href={urls[a.path]} target="_blank" rel="noreferrer" download={a.name}>
              {a.name}
            </a>
          ) : (
            <span>{a.name}</span>
          )}
          <span className="artifact-size">{(a.size / 1024).toFixed(1)} KB</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Bottom dock: comparison / logs
// ---------------------------------------------------------------------------
function Dock({ engines }: { engines: CompareEngine[] }) {
  const [tab, setTab] = useState<'comparison' | 'logs'>('comparison');
  const gridStyle = { ['--cols' as string]: String(engines.length) } as React.CSSProperties;

  return (
    <section className="dock">
      <div className="dock-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'comparison'}
          className={`dock-tab${tab === 'comparison' ? ' active' : ''}`}
          onClick={() => setTab('comparison')}
        >
          Comparison
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'logs'}
          className={`dock-tab${tab === 'logs' ? ' active' : ''}`}
          onClick={() => setTab('logs')}
        >
          Logs
        </button>
      </div>

      <div className="dock-body">
        {tab === 'comparison' ? (
          <>
            <ComparisonTable engines={engines} />
            <div className="artifacts-row" style={gridStyle}>
              <span className="cmp-label">Artifacts</span>
              {engines.map((e) => (
                <div className="artifact-col" key={e.def.id}>
                  <ArtifactLinks artifacts={e.state.artifacts} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="logs-view" style={gridStyle}>
            {engines.map((e) => (
              <div className="logs-col" key={e.def.id}>
                <h4 className={`cmp-engine ${e.def.accent}`}>
                  {e.def.title} <span className="cmp-sub">{e.def.subtitle}</span>
                </h4>
                <pre className="log-pre">{e.state.logs.join('\n')}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Heads-up display: live model-open timer
// ---------------------------------------------------------------------------
function ViewerHud({ state }: { state: ViewerState }) {
  const [, forceTick] = useState(0);

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
    if (state.openMs !== undefined) return formatSeconds(state.openMs);
    if (isTiming && state.openStartedAt !== undefined) return formatSeconds(performance.now() - state.openStartedAt);
    return '—';
  })();

  return (
    <div className="viewer-hud" aria-label="Open time">
      <span className="hud-label">Open time</span>
      <span className={`hud-value${isTiming ? ' active' : ''}`}>{openLabel}</span>
    </div>
  );
}

function ViewerPanel({
  def,
  state,
  elRef,
  onReset,
  note,
}: {
  def: EngineDef;
  state: ViewerState;
  elRef: React.RefObject<HTMLCanvasElement | null> | React.RefObject<HTMLDivElement | null>;
  onReset: () => void;
  note?: string;
}) {
  const percent = Math.round(state.progress.percent);
  const showProgress = state.busy && percent < 100;

  return (
    <section className="viewer-panel">
      <header className="viewer-header">
        <div className="viewer-title">
          <span className={`viewer-dot ${def.accent}`} aria-hidden="true" />
          <h2>{def.title}</h2>
          <span className="viewer-sub">{def.subtitle}</span>
          {state.busy && <span className="viewer-phase">{state.progress.phase}</span>}
        </div>
        <div className="viewer-header-actions" role="toolbar" aria-label={`${def.title} viewer tools`}>
          <IconToolbarButton label="Reset view" onClick={onReset}>
            <HomeIcon />
          </IconToolbarButton>
        </div>
      </header>

      <div className="viewer-top">
        <div className="canvas-shell">
          {def.kind === 'canvas' ? (
            <canvas ref={elRef as React.RefObject<HTMLCanvasElement | null>} className="viewer-canvas" />
          ) : (
            <div ref={elRef as React.RefObject<HTMLDivElement | null>} className="viewer-host" />
          )}
          {note && <div className="viewport-note">{note}</div>}
          <ViewerHud state={state} />
          {showProgress && (
            <div className="viewer-progress" aria-hidden="true">
              <div className={`viewer-progress-bar ${def.accent}`} style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  // One DOM ref + adapter ref + viewer state per engine (fixed count).
  const canvasNewRef = useRef<HTMLCanvasElement | null>(null);
  const canvasOldRef = useRef<HTMLCanvasElement | null>(null);
  const hostThatRef = useRef<HTMLDivElement | null>(null);
  const adapterNewRef = useRef<ViewerAdapter | null>(null);
  const adapterOldRef = useRef<ViewerAdapter | null>(null);
  const adapterThatRef = useRef<ViewerAdapter | null>(null);

  const sNew = useViewerState('ifc-lite instancing on');
  const sOld = useViewerState('ifc-lite instancing off');
  const sThat = useViewerState('ThatOpen');

  const elRefs: Record<EngineId, React.RefObject<HTMLCanvasElement | null> | React.RefObject<HTMLDivElement | null>> = {
    'ifclite-new': canvasNewRef,
    'ifclite-old': canvasOldRef,
    thatopen: hostThatRef,
  };
  const adapterRefs: Record<EngineId, React.MutableRefObject<ViewerAdapter | null>> = {
    'ifclite-new': adapterNewRef,
    'ifclite-old': adapterOldRef,
    thatopen: adapterThatRef,
  };
  const states: Record<EngineId, { state: ViewerState; api: ViewerApi }> = {
    'ifclite-new': sNew,
    'ifclite-old': sOld,
    thatopen: sThat,
  };

  // Phase is fixed for the page's lifetime; transitions happen via setBenchPhase
  // + reload. A genuine fresh visit (navigation type "navigate") must not resume a
  // stale benchmark, so it is reset to idle; programmatic continuation reload()s.
  const [phase] = useState<BenchPhase>(() => {
    const raw = getBenchPhase();
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === 'navigate' && raw !== 'idle') {
      clearBenchSession();
      return 'idle';
    }
    return raw;
  });

  const [orderPref, setOrderPrefState] = useState<OrderKey>(getOrderPref);

  const selectedFileName = getBenchFileName() ?? 'No IFC file selected';
  const benchSize = getBenchFileSize();
  const selectedFileSize = benchSize !== null ? formatBytes(benchSize) : null;

  const fileSchema = (() => {
    for (const id of ALL_ENGINES) {
      const s = viewerLabelValue(states[id].state.metrics, 'Schema');
      if (s !== '—') return s;
    }
    return null;
  })();

  // Display / run order: while idle follow the live preference, otherwise the
  // snapshot taken for the active run.
  const order: EngineId[] = phase === 'idle' ? ORDERS[orderPref] : getRunOrder();
  const measuring = phase !== 'idle' && phase !== 'done';

  useEffect(() => {
    let disposed = false;
    let createdAdapter: ViewerAdapter | null = null;

    const measure = async (api: ViewerApi, adapter: ViewerAdapter, title: string, file: { name: string; buffer: ArrayBuffer }): Promise<EngineResult> => {
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
      return { metrics, artifacts, logs, openMs, error };
    };

    const orchestrate = async () => {
      if (phase === 'idle') {
        return;
      }
      if (phase === 'done') {
        for (const id of ALL_ENGINES) {
          const stored = loadEngineResult(id);
          if (stored) states[id].api.hydrate(stored);
        }
        return;
      }

      // Restore engines already measured on previous pages (those before this one).
      const runOrder = getRunOrder();
      const currentIndex = runOrder.indexOf(phase);
      for (let i = 0; i < currentIndex; i += 1) {
        const stored = loadEngineResult(runOrder[i]);
        if (stored) states[runOrder[i]].api.hydrate(stored);
      }

      const def = ENGINE_DEFS[phase];
      const el = elRefs[phase].current;
      if (!def || !el) return;

      const file = await loadBenchFile();
      if (!file || disposed) return;

      createdAdapter = await createAdapter(phase, el);
      adapterRefs[phase].current = createdAdapter;
      await createdAdapter.init();
      if (disposed) return;
      states[phase].api.markReady();

      const result = await measure(states[phase].api, createdAdapter, `${def.title} ${def.subtitle}`, file);
      if (disposed) return;
      saveEngineResult(phase, result);

      const next = nextEngine(phase);
      if (next) {
        setBenchPhase(next);
        window.setTimeout(() => window.location.reload(), 700);
      } else {
        setBenchPhase('done');
      }
    };

    void orchestrate();

    return () => {
      disposed = true;
      createdAdapter?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const onBrowse = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) {
      return;
    }
    await startBench(file);
    window.location.reload();
  };

  const selectOrder = (key: OrderKey) => {
    setOrderPref(key);
    setOrderPrefState(key);
  };

  const currentIndex = order.indexOf(phase as EngineId);
  const noteFor = (index: number): string | undefined => {
    if (phase === 'idle') return undefined;
    if (phase === 'done') return 'Measured in isolation — see comparison below';
    if (index < currentIndex) return 'Measured in isolation — see comparison below';
    if (index > currentIndex) return 'Queued — runs after the page reloads';
    return undefined;
  };

  const measuringDef = measuring ? ENGINE_DEFS[phase as EngineId] : null;
  const statusLabel =
    phase === 'done'
      ? 'Benchmark complete'
      : measuringDef
      ? `Measuring ${measuringDef.title} ${measuringDef.subtitle}…`
      : null;

  const orderedDefs = order.map((id) => ENGINE_DEFS[id]);
  const compareEngines: CompareEngine[] = orderedDefs.map((def) => ({ def, state: states[def.id].state }));
  const gridStyle = { ['--cols' as string]: String(orderedDefs.length) } as React.CSSProperties;

  return (
    <main className="app-shell">
      <header className="topbar">
        <label className="browse-button" htmlFor="ifc-file-input">
          Browse
        </label>
        <input id="ifc-file-input" type="file" accept=".ifc" onChange={onBrowse} hidden />

        <div className="order-toggle" role="group" aria-label="Benchmark order" title="Which engine runs first">
          {(['ifclite-first', 'thatopen-first'] as OrderKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`order-btn${orderPref === key ? ' active' : ''}`}
              aria-pressed={orderPref === key}
              disabled={measuring}
              onClick={() => selectOrder(key)}
            >
              {key === 'ifclite-first' ? 'ifc-lite first' : 'ThatOpen first'}
            </button>
          ))}
        </div>

        <div className="file-pill">
          <span className="file-pill-name" title={selectedFileName}>{selectedFileName}</span>
          {selectedFileSize && <span className="file-chip">{selectedFileSize}</span>}
          {fileSchema && <span className="file-chip">{fileSchema}</span>}
          {statusLabel && <span className={`file-status${phase === 'done' ? ' done' : ''}`}>{statusLabel}</span>}
        </div>
      </header>

      <section className="comparison-grid" style={gridStyle}>
        {orderedDefs.map((def, index) => (
          <ViewerPanel
            key={def.id}
            def={def}
            state={states[def.id].state}
            elRef={elRefs[def.id]}
            onReset={() => void adapterRefs[def.id].current?.reset()}
            note={noteFor(index)}
          />
        ))}
      </section>

      <Dock engines={compareEngines} />
    </main>
  );
}
