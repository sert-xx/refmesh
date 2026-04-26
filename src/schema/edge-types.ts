export type EdgeCategory =
  | 'structure'
  | 'dependency'
  | 'dataflow'
  | 'comparison'
  | 'identity'
  | 'lifecycle'
  | 'internal';

export interface EdgeTypeDefinition {
  type: string;
  category: EdgeCategory;
  description: string;
  internal?: boolean;
}

export const EDGE_TYPES: readonly EdgeTypeDefinition[] = [
  { type: 'IS_A', category: 'structure', description: 'AはBの一種である' },
  { type: 'PART_OF', category: 'structure', description: 'AはBの一部・構成要素である' },
  { type: 'CONTAINS', category: 'structure', description: 'AはBを内包している' },

  { type: 'DEPENDS_ON', category: 'dependency', description: 'Aが機能するにはBが必要である' },
  { type: 'IMPLEMENTS', category: 'dependency', description: 'AはB(仕様等)を実装している' },
  { type: 'EXTENDS', category: 'dependency', description: 'AはBの機能を拡張・継承している' },

  { type: 'CONSUMES', category: 'dataflow', description: 'AはB(データ等)を受け取る' },
  { type: 'PRODUCES', category: 'dataflow', description: 'AはBを生成・出力する' },
  { type: 'MUTATES', category: 'dataflow', description: 'AはBを変更・破壊する' },

  { type: 'ALTERNATIVE_TO', category: 'comparison', description: 'AはBの代替手段である' },
  { type: 'INTEGRATES_WITH', category: 'comparison', description: 'AはBと連携・接続できる' },
  { type: 'RELATED_TO', category: 'comparison', description: 'AとBは関連している' },

  {
    type: 'SAME_AS',
    category: 'identity',
    description: '表記揺れ等で別ノードになっているがAとBは同一概念である',
  },

  { type: 'REPLACES', category: 'lifecycle', description: 'AはBを置き換える新しい技術である' },
  { type: 'DEPRECATES', category: 'lifecycle', description: 'AはBを非推奨としている' },

  {
    type: 'DESCRIBES',
    category: 'internal',
    description: '(内部用) Reference→Concept の説明関係。registerコマンドが自動で張る。',
    internal: true,
  },
] as const;

export const PUBLIC_EDGE_TYPES: readonly EdgeTypeDefinition[] = EDGE_TYPES.filter(
  (e) => !e.internal,
);

export const PUBLIC_EDGE_TYPE_NAMES: readonly string[] = PUBLIC_EDGE_TYPES.map((e) => e.type);

export const ALL_EDGE_TYPE_NAMES: readonly string[] = EDGE_TYPES.map((e) => e.type);

export const INTERNAL_DESCRIBES_EDGE = 'DESCRIBES' as const;

export function isPublicEdgeType(type: string): boolean {
  return PUBLIC_EDGE_TYPE_NAMES.includes(type);
}

export function groupedByCategory(): Record<EdgeCategory, EdgeTypeDefinition[]> {
  const grouped: Record<EdgeCategory, EdgeTypeDefinition[]> = {
    structure: [],
    dependency: [],
    dataflow: [],
    comparison: [],
    identity: [],
    lifecycle: [],
    internal: [],
  };
  for (const edge of EDGE_TYPES) {
    grouped[edge.category].push(edge);
  }
  return grouped;
}

export const CATEGORY_LABELS: Record<EdgeCategory, string> = {
  structure: '構造・分類',
  dependency: '依存・実装',
  dataflow: 'データフロー',
  comparison: '比較・関連',
  identity: '同一性解決',
  lifecycle: 'ライフサイクル',
  internal: '内部利用',
};
