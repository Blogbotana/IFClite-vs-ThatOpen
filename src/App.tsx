import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPersistedArtifactUrl } from './lib/file-system';
import type { EntitySummary, TreeNode, ViewerAdapter, ViewerMetric, ViewerState } from './types';

function IconBase({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function TreeIcon() {
  return (
    <IconBase>
      <circle cx="7" cy="5" r="2" />
      <circle cx="17" cy="12" r="2" />
      <circle cx="11" cy="19" r="2" />
      <path d="M7 7v10" />
      <path d="M7 12h8" />
      <path d="M7 19h2" />
    </IconBase>
  );
}

function PropertiesIcon() {
  return (
    <IconBase>
      <circle cx="7" cy="7" r="2" />
      <circle cx="17" cy="12" r="2" />
      <circle cx="9" cy="17" r="2" />
      <path d="M9 7h12" />
      <path d="M3 12h12" />
      <path d="M11 17h10" />
    </IconBase>
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
// Draggable panel hook
// ---------------------------------------------------------------------------
function useDraggablePanel(initialX: number, initialY: number) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y };
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.ox + e.clientX - dragRef.current.sx,
        y: dragRef.current.oy + e.clientY - dragRef.current.sy,
      });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return { pos, onHeaderMouseDown };
}

function useDraggablePanelFromRight(initialRight: number, initialY: number) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | { right: number; top: number }>({
    right: initialRight,
    top: initialY,
  });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
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
  }, []);

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

  const style = 'left' in pos ? ({ left: pos.left, top: pos.top } as const) : ({ right: pos.right, top: pos.top } as const);
  return { panelRef, style, onHeaderMouseDown };
}

function useDraggablePanelFromBottom(initialX: number, initialBottom: number) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | { left: number; bottom: number }>({
    left: initialX,
    bottom: initialBottom,
  });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
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
  }, []);

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

// ---------------------------------------------------------------------------
// Spatial tree components
// ---------------------------------------------------------------------------
function SpatialTreeNode({
  node,
  entityIndex,
  selectedId,
  forcedExpandedIds,
  onSelect,
}: {
  node: TreeNode;
  entityIndex: Record<number, EntitySummary>;
  selectedId?: number;
  forcedExpandedIds: Set<number>;
  onSelect: (entity: EntitySummary) => void;
}) {
  const [userExpanded, setUserExpanded] = useState(node.children.length > 0 && node.children.length < 10);
  const isSelected = selectedId === node.expressId;
  const entity = entityIndex[node.expressId];
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && (forcedExpandedIds.has(node.expressId) || userExpanded);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isSelected) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  return (
    <div className="tree-item">
      <div
        ref={rowRef}
        data-tree-express-id={node.expressId}
        className={`tree-row${isSelected ? ' selected' : ''}`}
        onClick={() => entity && onSelect(entity)}
      >
        {hasChildren ? (
          <button
            className="tree-toggle"
            type="button"
            onClick={(e) => { e.stopPropagation(); setUserExpanded((v) => !v); }}
          >
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tree-toggle-placeholder" />
        )}
        <span className="tree-label">
          <span className="tree-name">{node.name || node.type}</span>
          <span className="tree-type">{node.type}</span>
        </span>
      </div>
      {isExpanded && (
        <div className="tree-children">
          {node.children.map((child) => (
            <SpatialTreeNode
              key={child.expressId}
              node={child}
              entityIndex={entityIndex}
              selectedId={selectedId}
              forcedExpandedIds={forcedExpandedIds}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SpatialTreePanel({
  tree,
  entityIndex,
  selected,
  onSelect,
  onClose,
}: {
  tree: TreeNode[];
  entityIndex: Record<number, EntitySummary>;
  selected?: EntitySummary;
  onSelect: (entity: EntitySummary) => void;
  onClose: () => void;
}) {
  const { pos, onHeaderMouseDown } = useDraggablePanel(10, 10);

  const expandedPathIds = useMemo(() => {
    const selectedExpressId = selected?.expressId;
    if (!selectedExpressId) {
      return new Set<number>();
    }

    const path = new Set<number>();
    const walk = (nodes: TreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.expressId === selectedExpressId) {
          path.add(node.expressId);
          return true;
        }
        if (walk(node.children)) {
          path.add(node.expressId);
          return true;
        }
      }
      return false;
    };

    walk(tree);
    return path;
  }, [tree, selected?.expressId]);

  useEffect(() => {
    const selectedExpressId = selected?.expressId;
    if (!selectedExpressId) {
      return;
    }

    const handle = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLDivElement>(`[data-tree-express-id="${selectedExpressId}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    });

    return () => cancelAnimationFrame(handle);
  }, [selected?.expressId, expandedPathIds]);

  return (
    <div className="floating-panel tree-panel" style={{ left: pos.x, top: pos.y }}>
      <div className="floating-panel-header" onMouseDown={onHeaderMouseDown}>
        <PanelTitle icon={<TreeIcon />} text="Spatial Tree" />
        <button className="floating-close" type="button" onClick={onClose}>✕</button>
      </div>
      <div className="floating-panel-body tree-body">
        {tree.map((node) => (
          <SpatialTreeNode
            key={node.expressId}
            node={node}
            entityIndex={entityIndex}
            selectedId={selected?.expressId}
            forcedExpandedIds={expandedPathIds}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function PropertiesPanel({
  entity,
  onClose,
}: {
  entity: EntitySummary;
  onClose: () => void;
}) {
  const { panelRef, style, onHeaderMouseDown } = useDraggablePanelFromRight(10, 10);
  return (
    <div ref={panelRef} className="floating-panel props-panel" style={style}>
      <div className="floating-panel-header" onMouseDown={onHeaderMouseDown}>
        <span className="floating-panel-title" title={entity.name || entity.type}>
          <PanelTitle icon={<PropertiesIcon />} text={entity.name || entity.type} />
        </span>
        <button className="floating-close" type="button" onClick={onClose}>✕</button>
      </div>
      <div className="floating-panel-body props-body">
        <div className="props-summary">
          <span className="props-type-badge">{entity.type}</span>
          {entity.globalId && <span className="props-guid" title={entity.globalId}>{entity.globalId}</span>}
        </div>
        {entity.propertyGroups.map((group) => (
          <section className="info-group" key={group.name}>
            <h4>{group.name}</h4>
            {group.entries.map((entry) => (
              <div className="property-row" key={entry.name}>
                <span>{entry.name}</span>
                <strong>{entry.value}</strong>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
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

function useViewerState(title: string) {
  const [state, setState] = useState<ViewerState>(initialViewerState);

  const api = useMemo(
    () => ({
      resetForRun() {
        setState({
          ready: true,
          busy: true,
          progress: { phase: 'Initializing', percent: 0 },
          logs: [`${title}: reset`, `${title}: waiting for parsing pipeline`],
          metrics: [],
          artifacts: [],
          tree: [],
          entityIndex: {},
        });
      },
      markReady() {
        setState((current) => ({ ...current, ready: true }));
      },
      setError(error: string) {
        setState((current) => ({
          ...current,
          busy: false,
          error,
          logs: [...current.logs, `${title}: ERROR ${error}`],
        }));
      },
      finish() {
        setState((current) => ({ ...current, busy: false }));
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
      'IFC paring time',
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

function ViewerPanel({
  title,
  state,
  canvasRef,
  hostRef,
  onReset,
  onSelectEntity,
}: {
  title: string;
  state: ViewerState;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  hostRef?: React.RefObject<HTMLDivElement | null>;
  onReset: () => void;
  onSelectEntity: (entity: EntitySummary) => void;
}) {
  const [activeTab, setActiveTab] = useState<'info' | 'logs'>('info');
  const [showTree, setShowTree] = useState(false);
  const [showProps, setShowProps] = useState(false);
  const [showBottomPanel, setShowBottomPanel] = useState(true);

  const treePopulated = state.tree.length > 0;
  useEffect(() => {
    if (treePopulated) setShowTree(true);
  }, [treePopulated]);

  const selectedId = state.selected?.expressId;
  useEffect(() => {
    if (selectedId !== undefined) setShowProps(true);
  }, [selectedId]);

  return (
    <section className="viewer-panel">
      <header className="viewer-header">
        <div>
          <h2>{title}</h2>
        </div>
        <div className="viewer-header-actions" role="toolbar" aria-label={`${title} viewer tools`}>
          {treePopulated && (
            <IconToolbarButton
              label={showTree ? 'Hide spatial tree' : 'Show spatial tree'}
              onClick={() => setShowTree((v) => !v)}
              pressed={showTree}
            >
              <TreeIcon />
            </IconToolbarButton>
          )}
          {state.selected && (
            <IconToolbarButton
              label={showProps ? 'Hide properties' : 'Show properties'}
              onClick={() => setShowProps((v) => !v)}
              pressed={showProps}
            >
              <PropertiesIcon />
            </IconToolbarButton>
          )}
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
          {showTree && treePopulated && (
            <SpatialTreePanel
              tree={state.tree}
              entityIndex={state.entityIndex}
              selected={state.selected}
              onSelect={onSelectEntity}
              onClose={() => setShowTree(false)}
            />
          )}
          {showProps && state.selected && (
            <PropertiesPanel
              entity={state.selected}
              onClose={() => setShowProps(false)}
            />
          )}
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

export default function App() {
  const ifcLiteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const thatOpenHostRef = useRef<HTMLDivElement | null>(null);
  const ifcLiteAdapterRef = useRef<ViewerAdapter | null>(null);
  const thatOpenAdapterRef = useRef<ViewerAdapter | null>(null);

  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const selectedFileName = currentFile?.name ?? 'No IFC file selected';
  const selectedFileSize = currentFile ? formatBytes(currentFile.size) : '—';

  const ifcLite = useViewerState('IFClite');
  const thatOpen = useViewerState('ThatOpen');
  const schemaFromIfcLite = viewerLabelValue(ifcLite.state.metrics, 'Schema');
  const schemaFromThatOpen = viewerLabelValue(thatOpen.state.metrics, 'Schema');
  const selectedFileSchema =
    currentFile && schemaFromIfcLite !== '—'
      ? schemaFromIfcLite
      : currentFile && schemaFromThatOpen !== '—'
      ? schemaFromThatOpen
      : '—';

  useEffect(() => {
    if (!ifcLiteCanvasRef.current || !thatOpenHostRef.current) {
      return undefined;
    }

    let disposed = false;
    let ifcLiteAdapter: import('./types').ViewerAdapter | null = null;
    let thatOpenAdapter: import('./types').ViewerAdapter | null = null;

    const canvas = ifcLiteCanvasRef.current;
    const host = thatOpenHostRef.current;

    void Promise.all([
      import(/* webpackChunkName: "viewer-ifclite" */ './lib/ifclite'),
      import(/* webpackChunkName: "viewer-thatopen" */ './lib/thatopen'),
    ]).then(([{ createIfcLiteAdapter }, { createThatOpenAdapter }]) => {
      if (disposed) return;
      ifcLiteAdapter = createIfcLiteAdapter(canvas);
      thatOpenAdapter = createThatOpenAdapter(host);
      ifcLiteAdapterRef.current = ifcLiteAdapter;
      thatOpenAdapterRef.current = thatOpenAdapter;

      return Promise.all([ifcLiteAdapter.init(), thatOpenAdapter.init()]);
    }).then(() => {
      if (disposed) return;
      ifcLite.api.markReady();
      thatOpen.api.markReady();
      ifcLite.api.appendLog('IFClite viewer initialized.');
      thatOpen.api.appendLog('ThatOpen viewer initialized.');
    });

    return () => {
      disposed = true;
      ifcLiteAdapter?.dispose();
      thatOpenAdapter?.dispose();
    };
  }, [ifcLite.api, thatOpen.api]);

  useEffect(() => {
    if (!currentFile || !ifcLiteAdapterRef.current || !thatOpenAdapterRef.current) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      ifcLite.api.resetForRun();
      thatOpen.api.resetForRun();

      const buffer = await currentFile.arrayBuffer();
      const execute = async (
        adapter: ViewerAdapter,
        api: ReturnType<typeof useViewerState>['api'],
        title: string,
      ) => {
        try {
          await adapter.load({
            file: currentFile,
            buffer,
            onProgress: ({ phase, percent }) => !cancelled && api.setProgress(phase, percent),
            onLog: (message) => !cancelled && api.appendLog(message),
            onMetrics: (metrics) => !cancelled && api.setMetrics(metrics),
            onArtifacts: (artifacts) => !cancelled && api.setArtifacts(artifacts),
            onTree: (tree) => !cancelled && api.setTree(tree),
            onEntityIndex: (entityIndex) => !cancelled && api.setEntityIndex(entityIndex),
            onSelected: (entity) => !cancelled && api.setSelected(entity),
          });
          if (!cancelled) {
            api.finish();
            api.appendLog(`${title}: pipeline completed.`);
          }
        } catch (error) {
          if (!cancelled) {
            api.setError(error instanceof Error ? error.message : String(error));
          }
        }
      };

      const ifcLiteAdapter = ifcLiteAdapterRef.current;
      const thatOpenAdapter = thatOpenAdapterRef.current;
      if (!ifcLiteAdapter || !thatOpenAdapter) {
        return;
      }

      await Promise.allSettled([
        execute(ifcLiteAdapter, ifcLite.api, 'IFClite'),
        execute(thatOpenAdapter, thatOpen.api, 'ThatOpen'),
      ]);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [currentFile, ifcLite.api, thatOpen.api]);

  const onBrowse = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setCurrentFile(file);
    event.currentTarget.value = '';
  };

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
        </div>
      </header>

      <section className="comparison-grid">
        <ViewerPanel
          title="IFClite"
          state={ifcLite.state}
          canvasRef={ifcLiteCanvasRef}
          onReset={() => void ifcLiteAdapterRef.current?.reset()}
          onSelectEntity={(entity) => {
            ifcLite.api.setSelected(entity);
            void ifcLiteAdapterRef.current?.select?.(entity.expressId);
          }}
        />
        <ViewerPanel
          title="ThatOpen"
          state={thatOpen.state}
          hostRef={thatOpenHostRef}
          onReset={() => void thatOpenAdapterRef.current?.reset()}
          onSelectEntity={(entity) => {
            thatOpen.api.setSelected(entity);
            void thatOpenAdapterRef.current?.select?.(entity.expressId);
          }}
        />
      </section>
    </main>
  );
}
