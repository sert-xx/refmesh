import { PUBLIC_EDGE_TYPE_NAMES } from './edge-types.js';

export interface RegisterInput {
  reference: {
    url: string;
    title: string;
    publishedAt?: string;
    fetchedAt?: string;
  };
  concepts: Array<{
    id: string;
    description: string;
    details?: string;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    type: string;
    reason: string;
  }>;
}

export const REGISTER_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'refmesh register input',
  type: 'object',
  required: ['reference', 'concepts', 'relationships'],
  additionalProperties: false,
  properties: {
    reference: {
      type: 'object',
      required: ['url', 'title'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', format: 'uri', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        publishedAt: { type: 'string', format: 'date-time' },
        fetchedAt: { type: 'string', format: 'date-time' },
      },
    },
    concepts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'description'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          details: { type: 'string' },
        },
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'target', 'type', 'reason'],
        additionalProperties: false,
        properties: {
          source: { type: 'string', minLength: 1 },
          target: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: [...PUBLIC_EDGE_TYPE_NAMES] },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;
