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
}

export interface ViewerAdapter {
  init: () => Promise<void>;
  dispose: () => void;
  reset: () => Promise<void> | void;
  load: (context: ViewerLoadContext) => Promise<void>;
  select?: (expressId?: number) => Promise<void> | void;
}
