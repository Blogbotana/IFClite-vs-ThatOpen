import { useEffect, useMemo, useRef, useState } from 'react';
import { getPersistedArtifactUrl } from './lib/file-system';
import {
  type BenchPhase,
  type EngineResult,
  clearBenchSession,
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
      // Start the model-open stopwatch for this viewer. Called right before the
      // adapter begins work so each engine is timed in isolation.
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

// ---------------------------------------------------------------------------
// Comparison table (the core side-by-side metric view)
// ---------------------------------------------------------------------------
interface CompareRow {
  label: string;
  ifc: string;
  that: string;
  /** When set, the lower value wins; the badge wording depends on the kind. */
  kind?: 'time' | 'size';
}

function ComparisonTable({ ifc, that }: { ifc: ViewerState; that: ViewerState }) {
  const m = (state: ViewerState, label: string) => viewerLabelValue(state.metrics, label);
  const open = (state: ViewerState) => (state.openMs !== undefined ? formatSeconds(state.openMs) : '—');
  const schemaThat = m(that, 'Schema') === '—' ? m(ifc, 'Schema') : m(that, 'Schema');

  const rows: CompareRow[] = [
    { label: 'Open time', ifc: open(ifc), that: open(that), kind: 'time' },
    { label: 'End-to-end', ifc: m(ifc, 'End-to-end time'), that: m(that, 'End-to-end time'), kind: 'time' },
    { label: 'Parse / convert', ifc: m(ifc, 'IFC parsing time'), that: m(that, 'IFC conversion time'), kind: 'time' },
    { label: 'Render ready', ifc: m(ifc, 'Render ready time'), that: m(that, 'Render ready time'), kind: 'time' },
    { label: 'Artifact size', ifc: m(ifc, 'Artifact size'), that: m(that, 'Artifact size'), kind: 'size' },
    { label: 'Entities', ifc: m(ifc, 'Entities'), that: m(that, 'Entities') },
    { label: 'Meshes / Fragments', ifc: m(ifc, 'Meshes'), that: m(that, 'Fragments') },
    { label: 'Schema', ifc: m(ifc, 'Schema'), that: schemaThat },
  ];

  const hasData = ifc.metrics.length > 0 || that.metrics.length > 0;
  if (!hasData) {
    return <div className="cmp-empty">Open an IFC file — both engines are benchmarked one at a time, then compared here.</div>;
  }

  return (
    <div className="cmp-table" role="table" aria-label="Engine comparison">
      <div className="cmp-row cmp-head" role="row">
        <span className="cmp-label" role="columnheader">Metric</span>
        <span className="cmp-cell cmp-engine ifclite" role="columnheader">IFClite</span>
        <span className="cmp-cell cmp-engine thatopen" role="columnheader">ThatOpen</span>
      </div>
      {rows.map((row) => {
        const a = row.kind ? parseMetricNumber(row.ifc) : null;
        const b = row.kind ? parseMetricNumber(row.that) : null;
        let ifcWins = false;
        let thatWins = false;
        let badge: string | null = null;
        if (a !== null && b !== null && a !== b) {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          ifcWins = a < b;
          thatWins = b < a;
          const ratio = lo > 0 ? hi / lo : 0;
          if (ratio >= 1.05) {
            badge = `×${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)} ${row.kind === 'size' ? 'smaller' : 'faster'}`;
          }
        }
        return (
          <div className="cmp-row" role="row" key={row.label}>
            <span className="cmp-label" role="rowheader">{row.label}</span>
            <span className={`cmp-cell${ifcWins ? ' win' : ''}`} role="cell">
              <span className="cmp-value">{row.ifc}</span>
              {ifcWins && badge && <span className="cmp-badge">{badge}</span>}
            </span>
            <span className={`cmp-cell${thatWins ? ' win' : ''}`} role="cell">
              <span className="cmp-value">{row.that}</span>
              {thatWins && badge && <span className="cmp-badge">{badge}</span>}
            </span>
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
function Dock({ ifc, that }: { ifc: ViewerState; that: ViewerState }) {
  const [tab, setTab] = useState<'comparison' | 'logs'>('comparison');

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
            <ComparisonTable ifc={ifc} that={that} />
            <div className="artifacts-row">
              <div className="artifact-col">
                <h4 className="cmp-engine ifclite">IFClite artifacts</h4>
                <ArtifactLinks artifacts={ifc.artifacts} />
              </div>
              <div className="artifact-col">
                <h4 className="cmp-engine thatopen">ThatOpen artifacts</h4>
                <ArtifactLinks artifacts={that.artifacts} />
              </div>
            </div>
          </>
        ) : (
          <div className="logs-view">
            <div className="logs-col">
              <h4 className="cmp-engine ifclite">IFClite</h4>
              <pre className="log-pre">{ifc.logs.join('\n')}</pre>
            </div>
            <div className="logs-col">
              <h4 className="cmp-engine thatopen">ThatOpen</h4>
              <pre className="log-pre">{that.logs.join('\n')}</pre>
            </div>
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
  title,
  accent,
  state,
  canvasRef,
  hostRef,
  onReset,
  note,
}: {
  title: string;
  accent: 'ifclite' | 'thatopen';
  state: ViewerState;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  hostRef?: React.RefObject<HTMLDivElement | null>;
  onReset: () => void;
  note?: string;
}) {
  const percent = Math.round(state.progress.percent);
  const showProgress = state.busy && percent < 100;

  return (
    <section className="viewer-panel">
      <header className="viewer-header">
        <div className="viewer-title">
          <span className={`viewer-dot ${accent}`} aria-hidden="true" />
          <h2>{title}</h2>
          {state.busy && <span className="viewer-phase">{state.progress.phase}</span>}
        </div>
        <div className="viewer-header-actions" role="toolbar" aria-label={`${title} viewer tools`}>
          <IconToolbarButton label="Reset view" onClick={onReset}>
            <HomeIcon />
          </IconToolbarButton>
        </div>
      </header>

      <div className="viewer-top">
        <div className="canvas-shell">
          {canvasRef ? <canvas ref={canvasRef} className="viewer-canvas" /> : <div ref={hostRef} className="viewer-host" />}
          {note && <div className="viewport-note">{note}</div>}
          <ViewerHud state={state} />
          {showProgress && (
            <div className="viewer-progress" aria-hidden="true">
              <div className={`viewer-progress-bar ${accent}`} style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const ifcLiteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const thatOpenHostRef = useRef<HTMLDivElement | null>(null);
  const ifcLiteAdapterRef = useRef<ViewerAdapter | null>(null);
  const thatOpenAdapterRef = useRef<ViewerAdapter | null>(null);

  // The benchmark phase is fixed for the lifetime of a page load; transitions
  // happen via setBenchPhase(...) + a reload so each engine is measured fresh.
  // A genuine fresh visit (navigation type "navigate", e.g. new tab / typed URL)
  // must not resume a stale benchmark from a previous session, so it is reset to
  // idle. Programmatic continuation between engines uses reload(), which reports
  // navigation type "reload" and is therefore preserved.
  const [phase] = useState<BenchPhase>(() => {
    const raw = getBenchPhase();
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === 'navigate' && raw !== 'idle') {
      clearBenchSession();
      return 'idle';
    }
    return raw;
  });

  const selectedFileName = getBenchFileName() ?? 'No IFC file selected';
  const benchSize = getBenchFileSize();
  const selectedFileSize = benchSize !== null ? formatBytes(benchSize) : null;

  const ifcLite = useViewerState('IFClite');
  const thatOpen = useViewerState('ThatOpen');

  // IFClite is measured on its own page, so in later phases its panel is
  // hydrated from the stored result and its canvas stays empty.
  const ifcLiteMeasuredOnly = phase === 'thatopen' || phase === 'done';
  const ifcLiteStored = useMemo(() => loadEngineResult('ifclite'), []);

  const schemaFromIfcLite = viewerLabelValue(ifcLite.state.metrics, 'Schema');
  const schemaFromThatOpen = viewerLabelValue(thatOpen.state.metrics, 'Schema');
  const selectedFileSchema =
    schemaFromIfcLite !== '—' ? schemaFromIfcLite : schemaFromThatOpen !== '—' ? schemaFromThatOpen : null;

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
      return { metrics, artifacts, logs, openMs, error };
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

      // Restore the IFClite panel from its stored (previous-page) result.
      if (ifcLiteStored) {
        ifcLite.api.hydrate(ifcLiteStored);
      }

      // phase === 'done' (a reload after the benchmark already finished): just
      // restore both metric sets. Do NOT re-load ThatOpen's heavy 3D model — that
      // would make the previous model load itself again on every refresh.
      if (phase === 'done') {
        const stored = loadEngineResult('thatopen');
        if (stored) {
          thatOpen.api.hydrate(stored);
        }
        return;
      }

      // phase === 'thatopen': measure ThatOpen live; its 3D view stays on screen.
      thatOpenAdapter = createThatOpenAdapter(host);
      thatOpenAdapterRef.current = thatOpenAdapter;
      await thatOpenAdapter.init();
      if (disposed) return;
      thatOpen.api.markReady();

      const result = await measure(thatOpenAdapter, thatOpen.api, 'ThatOpen', file);
      if (disposed) return;
      saveEngineResult('thatopen', result);
      setBenchPhase('done');
      // Stay on this page: ThatOpen's 3D view is live and both metric sets are shown.
    };

    void orchestrate();

    return () => {
      disposed = true;
      ifcLiteAdapter?.dispose();
      thatOpenAdapter?.dispose();
    };
  }, [phase, ifcLite.api, thatOpen.api, ifcLiteStored]);

  const onBrowse = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) {
      return;
    }
    // Persist the file + arm the benchmark, then reload so IFClite runs on a
    // clean page (fresh V8 heap → honest per-engine timing).
    await startBench(file);
    window.location.reload();
  };

  const ifcLiteNote = ifcLiteMeasuredOnly
    ? 'Measured in isolation on a separate page — see comparison below'
    : undefined;
  const thatOpenNote =
    phase === 'ifclite'
      ? 'Queued — runs after the page reloads'
      : phase === 'done'
      ? 'Benchmark complete — open a file to run again'
      : undefined;

  const statusLabel =
    phase === 'ifclite'
      ? 'Measuring IFClite…'
      : phase === 'thatopen'
      ? 'Measuring ThatOpen…'
      : phase === 'done'
      ? 'Benchmark complete'
      : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <label className="browse-button" htmlFor="ifc-file-input">
          Browse
        </label>
        <input id="ifc-file-input" type="file" accept=".ifc" onChange={onBrowse} hidden />
        <div className="file-pill">
          <span className="file-pill-name" title={selectedFileName}>{selectedFileName}</span>
          {selectedFileSize && <span className="file-chip">{selectedFileSize}</span>}
          {selectedFileSchema && <span className="file-chip">{selectedFileSchema}</span>}
          {statusLabel && <span className={`file-status${phase === 'done' ? ' done' : ''}`}>{statusLabel}</span>}
        </div>
      </header>

      <section className="comparison-grid">
        <ViewerPanel
          title="IFClite"
          accent="ifclite"
          state={ifcLite.state}
          canvasRef={ifcLiteCanvasRef}
          onReset={() => void ifcLiteAdapterRef.current?.reset()}
          note={ifcLiteNote}
        />
        <ViewerPanel
          title="ThatOpen"
          accent="thatopen"
          state={thatOpen.state}
          hostRef={thatOpenHostRef}
          onReset={() => void thatOpenAdapterRef.current?.reset()}
          note={thatOpenNote}
        />
      </section>

      <Dock ifc={ifcLite.state} that={thatOpen.state} />
    </main>
  );
}
