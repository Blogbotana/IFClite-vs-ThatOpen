import {
  extractEntityAttributesOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { EntitySummary, TreeNode } from '../types';

type SpatialNodeLike = {
  expressId?: number;
  id?: number;
  type?: number | string;
  ifcType?: number | string;
  name?: string;
  longName?: string;
  children?: SpatialNodeLike[];
  elements?: number[];
};

const naturalNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function compareTreeNodes(a: TreeNode, b: TreeNode): number {
  const byType = naturalNameCollator.compare(a.type, b.type);
  if (byType !== 0) return byType;

  const byName = naturalNameCollator.compare(a.name, b.name);
  if (byName !== 0) return byName;

  return a.expressId - b.expressId;
}

function isIfcAnnotationType(type: string): boolean {
  return type.toUpperCase().startsWith('IFCANNOTATION');
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function buildEntitySummary(store: IfcDataStore, expressId: number, type: string): EntitySummary {
  const attrs = extractEntityAttributesOnDemand(store, expressId) as Record<string, unknown>;
  const propertySets = extractPropertiesOnDemand(store, expressId).map((set) => ({
    name: set.name,
    entries: set.properties.map((property) => ({
      name: property.name,
      value: normalizeValue(property.value),
    })),
  }));
  const quantitySets = extractQuantitiesOnDemand(store, expressId).map((set) => ({
    name: set.name,
    entries: set.quantities.map((quantity) => ({
      name: quantity.name,
      value: normalizeValue(quantity.value),
    })),
  }));

  return {
    expressId,
    type,
    name: String(attrs.name ?? attrs.Name ?? `${type} #${expressId}`),
    globalId: attrs.globalId ? String(attrs.globalId) : undefined,
    propertyGroups: [
      {
        name: 'Attributes',
        entries: Object.entries(attrs).map(([name, value]) => ({ name, value: normalizeValue(value) })),
      },
      ...propertySets,
      ...quantitySets,
    ],
  };
}

function getEntityType(store: IfcDataStore, expressId: number, fallback: unknown): string {
  try {
    const typeName = store.entities.getTypeName(expressId);
    if (typeName && typeName !== 'UNKNOWN') return typeName;
  } catch {
    // Ignore and use fallback below.
  }

  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  return 'IFCOBJECT';
}

function getEntityName(store: IfcDataStore, expressId: number, fallback?: unknown): string {
  try {
    const direct = store.entities.getName(expressId);
    if (direct && direct !== '$') return direct;
  } catch {
    // Ignore and use fallback below.
  }

  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  return `#${expressId}`;
}

function toTreeNode(node: SpatialNodeLike, store: IfcDataStore): TreeNode | null {
  const expressId = Number(node.expressId ?? node.id ?? 0);
  const type = getEntityType(store, expressId, node.type ?? node.ifcType);
  if (isIfcAnnotationType(type)) {
    return null;
  }
  const name = getEntityName(store, expressId, node.name ?? node.longName ?? node.type);

  const spatialChildren: TreeNode[] = Array.isArray(node.children)
    ? node.children.flatMap((child) => {
        const childNode = toTreeNode(child, store);
        return childNode ? [childNode] : [];
      })
    : [];

  const elementChildren: TreeNode[] = Array.isArray(node.elements)
    ? node.elements.flatMap((elementId) => {
        const elementType = getEntityType(store, elementId, undefined);
        if (isIfcAnnotationType(elementType)) {
          return [];
        }
        const elementName = getEntityName(store, elementId, undefined);
        return [{
          expressId: elementId,
          type: elementType,
          name: elementName,
          children: [],
        }];
      })
    : [];

  return {
    expressId,
    type,
    name,
    children: [...spatialChildren, ...elementChildren].sort(compareTreeNodes),
  };
}

export function buildSpatialTree(store: IfcDataStore): TreeNode[] {
  const hierarchy = (store as any).spatialHierarchy;
  if (!hierarchy) return [];

  if (hierarchy.project) {
    const projectNode = toTreeNode(hierarchy.project as SpatialNodeLike, store);
    return projectNode ? [projectNode] : [];
  }

  if (Array.isArray(hierarchy)) {
    return hierarchy.flatMap((node) => {
      const builtNode = toTreeNode(node, store);
      return builtNode ? [builtNode] : [];
    });
  }
  if (Array.isArray(hierarchy.roots)) {
    return hierarchy.roots.flatMap((node: unknown) => {
      const builtNode = toTreeNode(node as SpatialNodeLike, store);
      return builtNode ? [builtNode] : [];
    });
  }
  const rootNode = toTreeNode(hierarchy as SpatialNodeLike, store);
  return rootNode ? [rootNode] : [];
}

export function buildEntityIndex(store: IfcDataStore, nodes: TreeNode[]): Record<number, EntitySummary> {
  const index: Record<number, EntitySummary> = {};
  const visit = (node: TreeNode) => {
    index[node.expressId] = buildEntitySummary(store, node.expressId, node.type);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return index;
}
