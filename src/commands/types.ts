import {
  CATEGORY_LABELS,
  type EdgeCategory,
  PUBLIC_EDGE_TYPES,
  groupedByCategory,
} from '../schema/edge-types.js';
import { REGISTER_JSON_SCHEMA } from '../schema/register-schema.js';

export interface TypesCommandOptions {
  format: 'text' | 'json';
}

export function renderTypesText(): string {
  const grouped = groupedByCategory();
  const lines: string[] = [];

  lines.push('# refmesh: Available Edge Types');
  lines.push('');

  const order: EdgeCategory[] = [
    'structure',
    'dependency',
    'dataflow',
    'comparison',
    'identity',
    'lifecycle',
  ];

  for (const category of order) {
    const edges = grouped[category];
    if (edges.length === 0) continue;
    lines.push(`## ${CATEGORY_LABELS[category]}`);
    for (const edge of edges) {
      lines.push(`- ${edge.type}: ${edge.description}`);
    }
    lines.push('');
  }

  lines.push('# refmesh register: Input JSON Schema');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(REGISTER_JSON_SCHEMA, null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

export function renderTypesJson(): string {
  const payload = {
    edgeTypes: PUBLIC_EDGE_TYPES.map((e) => ({
      type: e.type,
      category: e.category,
      description: e.description,
    })),
    categories: CATEGORY_LABELS,
    registerInputSchema: REGISTER_JSON_SCHEMA,
  };
  return JSON.stringify(payload, null, 2);
}

export function runTypesCommand(options: TypesCommandOptions): string {
  return options.format === 'json' ? renderTypesJson() : renderTypesText();
}
