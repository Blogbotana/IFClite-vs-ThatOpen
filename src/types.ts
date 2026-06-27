export interface ProgressState {
  phase: string;
  percent: number;
}

export interface ArtifactInfo {
  name: string;
  size: number;
  path: string;
}

export interface ViewerMetric {
  label: string;
  value: string;
}

export interface PropertyGroup {
  name: string;
  entries: Array<{ name: string; value: string }>;
}

export interface EntitySummary {
  expressId: number;
  type: string;
  name: string;
  globalId?: string;
  propertyGroups: PropertyGroup[];
}

export interface TreeNode {
  expressId: number;
  type: string;
  name: string;
  children: TreeNode[];
}

export interface ViewerState {
  ready: boolean;
  busy: boolean;
  error?: string;
  progress: ProgressState;
  logs: string[];
  metrics: ViewerMetric[];
  artifacts: ArtifactInfo[];
  tree: TreeNode[];
  entityIndex: Record<number, EntitySummary>;
  selected?: EntitySummary;
  /** Wall-clock timestamp (performance.now) when the current load started. */
  openStartedAt?: number;
  /** Final model open duration in ms, set once the load finishes. */
  openMs?: number;
  /** Warm re-open duration in ms: reload the persisted geometry cache
   *  (ifc-lite @ifc-lite/cache blob, ThatOpen .frag) — no parse, no CSG. */
  reopenMs?: number;
}

export interface ViewerLoadContext {
  file: File;
  buffer: ArrayBuffer;
  onProgress: (progress: ProgressState) => void;
  onLog: (message: string) => void;
  onMetrics: (metrics: ViewerMetric[]) => void;
  onArtifacts: (artifacts: ArtifactInfo[]) => void;
  onTree: (tree: TreeNode[]) => void;
  onEntityIndex: (entityIndex: Record<number, EntitySummary>) => void;
  onSelected: (entity?: EntitySummary) => void;
  /** Fired at render-ready (model on screen) — BEFORE any artifact export, so
   *  the headline "Open time" measures opening the model, not serializing a
   *  side-artifact. Both adapters call it; the App stops the open-timer here. */
  onReady?: () => void;
}

export interface ViewerAdapter {
  init: () => Promise<void>;
  dispose: () => void;
  reset: () => Promise<void> | void;
  load: (context: ViewerLoadContext) => Promise<void>;
  /** Warm re-open: reload the geometry the previous load() cached, skipping
   *  parse + CSG. Resolves once the cached model is rendered. Optional — the
   *  App times it and shows the "Re-open (cache)" row only for adapters that
   *  implement it. Must be called after a successful load(). */
  reopen?: (context: ViewerLoadContext, cachedBuffer?: ArrayBuffer) => Promise<void>;
  select?: (expressId?: number) => Promise<void> | void;
}
