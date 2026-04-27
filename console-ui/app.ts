import cytoscape, {
  type Core,
  type EdgeDefinition,
  type EventObject,
  type NodeDefinition,
} from 'cytoscape';

interface StatsResponse {
  graph: { path: string; sizeBytes: number };
  vector: { path: string; sizeBytes: number; rowCount: number };
  counts: {
    concepts: number;
    archivedConcepts: number;
    references: number;
    edgesTotal: number;
    edgesByType: Record<string, number>;
  };
  lastSeenAt: string | null;
}

interface ConceptListItem {
  id: string;
  description: string;
  details: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  touchCount: number;
  accessCount: number;
  archived: boolean;
  archivedAt: string | null;
  archiveReason: string | null;
}

interface ConceptListResponse {
  total: number;
  limit: number;
  offset: number;
  items: ConceptListItem[];
}

interface ConceptDetailResponse extends ConceptListItem {
  references: { url: string; title: string }[];
}

interface NeighborNode {
  id: string;
  description: string;
  details: string | null;
  archived: boolean;
  isRoot: boolean;
}

interface NeighborEdge {
  source: string;
  target: string;
  type: string;
  reason: string | null;
}

interface NeighborsResponse {
  rootId: string;
  depth: number;
  nodes: NeighborNode[];
  edges: NeighborEdge[];
  references: { url: string; title: string; conceptId: string }[];
}

interface SearchHit {
  id: string;
  description: string;
  details?: string;
  score?: number;
  finalScore?: number;
  freshness?: number;
  ageDays?: number;
  reinforcement?: number;
  accessCount?: number;
  demoted?: boolean;
  lexical?: number;
  bm25?: number;
}

interface SearchResult {
  query: string;
  matchedConcepts: SearchHit[];
  relatedConcepts: SearchHit[];
  references: { url: string; title: string }[];
  edges: { source: string; target: string; type: string; reason?: string }[];
}

interface SearchTraceVectorHit {
  id: string;
  text: string;
  cosine: number;
  distance: number;
  passedThreshold: boolean;
}

interface SearchTraceGraphQuery {
  label: string;
  cypher: string;
  idsPreview: string[];
}

interface SearchTraceCandidate {
  id: string;
  cosine: number;
  freshness: number;
  ageDays: number | null;
  accessCount: number;
  reinforcement: number;
  lexical: number;
  bm25: number;
  demoted: boolean;
  archived: boolean;
  finalScore: number;
  excluded?: 'archived' | 'maxAge' | 'demoted-zero' | 'concept-missing';
}

interface SearchTraceFtsHit {
  id: string;
  bm25: number;
  rawRank: number;
}

interface SearchTraceLevel {
  level: number;
  frontier: string[];
  edgesAdded: number;
}

interface SearchTrace {
  queryEmbedding: { dim: number; l2Norm: number; preview: number[]; full: number[] };
  queryTokens: string[];
  vectorRequest: { limit: number; oversample: number; threshold: number };
  vectorHits: SearchTraceVectorHit[];
  ftsHits: SearchTraceFtsHit[];
  graphQueries: SearchTraceGraphQuery[];
  candidates: SearchTraceCandidate[];
  traversal: { depth: number; levels: SearchTraceLevel[] };
}

interface SearchDebugResponse {
  result: SearchResult;
  trace: SearchTrace;
}

const EDGE_COLORS: Record<string, string> = {
  IS_A: '#58a6ff',
  PART_OF: '#58a6ff',
  CONTAINS: '#58a6ff',
  DEPENDS_ON: '#3fb950',
  IMPLEMENTS: '#3fb950',
  EXTENDS: '#3fb950',
  CONSUMES: '#d29922',
  PRODUCES: '#d29922',
  MUTATES: '#d29922',
  ALTERNATIVE_TO: '#bc8cff',
  INTEGRATES_WITH: '#bc8cff',
  RELATED_TO: '#bc8cff',
  SAME_AS: '#39c5cf',
  REPLACES: '#f85149',
  DEPRECATES: '#f85149',
};

const DEFAULT_EDGE_COLOR = '#8b949e';

function $(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el as HTMLElement;
}

function $$<T extends HTMLElement = HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll(selector)) as T[];
}

function setStatus(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.querySelector('#status-line');
  if (!el) return;
  el.textContent = message;
  el.className = kind === 'error' ? 'danger' : 'muted';
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Reference URLs originate from external register inputs, so prevent
// `javascript:` and other dangerous schemes from sneaking into anchor hrefs.
function safeHref(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      return u.toString();
    }
  } catch {
    // not a parseable absolute URL — fall through
  }
  return '#';
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

// --- Tab routing ----------------------------------------------------------

type TabName = 'overview' | 'concepts' | 'search' | 'search-debug' | 'graph';
let activeTab: TabName = 'overview';

function switchTab(tab: TabName): void {
  activeTab = tab;
  for (const btn of $$<HTMLButtonElement>('.tab')) {
    btn.classList.toggle('active', btn.dataset['tab'] === tab);
  }
  for (const view of $$('.view')) {
    view.hidden = view.dataset['view'] !== tab;
  }
  if (tab === 'overview') void renderOverview();
  if (tab === 'concepts') void renderConcepts();
  if (tab === 'graph') void ensureGraphReady();
}

// --- Overview --------------------------------------------------------------

async function renderOverview(): Promise<void> {
  setStatus('Loading stats…');
  try {
    const stats = await api<StatsResponse>('/api/stats');
    const cards = $('#stats-cards');
    cards.innerHTML = '';
    const items: { label: string; value: string; sub?: string }[] = [
      {
        label: 'Concepts',
        value: String(stats.counts.concepts),
        sub:
          stats.counts.archivedConcepts > 0
            ? `${stats.counts.archivedConcepts} archived`
            : undefined,
      },
      { label: 'References', value: String(stats.counts.references) },
      { label: 'Edges (total)', value: String(stats.counts.edgesTotal) },
      { label: 'Vector rows', value: String(stats.vector.rowCount) },
      {
        label: 'Last update',
        value: stats.lastSeenAt ? formatDate(stats.lastSeenAt) : '—',
      },
    ];
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="label">${escapeHtml(item.label)}</div>
        <div class="value">${escapeHtml(item.value)}</div>
        ${item.sub ? `<div class="sub">${escapeHtml(item.sub)}</div>` : ''}
      `;
      cards.appendChild(card);
    }

    const bars = $('#edge-bars');
    bars.innerHTML = '';
    const edgeEntries = Object.entries(stats.counts.edgesByType).sort((a, b) => b[1] - a[1]);
    const max = edgeEntries.reduce((m, [, v]) => Math.max(m, v), 0);
    for (const [name, count] of edgeEntries) {
      const row = document.createElement('div');
      row.className = 'edge-bar';
      const pct = max > 0 ? (count / max) * 100 : 0;
      const color = EDGE_COLORS[name] ?? DEFAULT_EDGE_COLOR;
      row.innerHTML = `
        <span class="name">${escapeHtml(name)}</span>
        <div class="track"><div class="fill" style="width:${pct.toFixed(1)}%; background:${color};"></div></div>
        <span class="count">${count}</span>
      `;
      bars.appendChild(row);
    }

    const storage = $('#storage-info');
    storage.innerHTML = '';
    const storageItems = [
      { label: 'Graph (Kùzu)', path: stats.graph.path, size: stats.graph.sizeBytes },
      { label: 'Vector (LanceDB)', path: stats.vector.path, size: stats.vector.sizeBytes },
    ];
    for (const item of storageItems) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="label">${escapeHtml(item.label)}</div>
        <div class="value" style="font-size:14px; word-break:break-all;">${escapeHtml(item.path)}</div>
        <div class="sub">${escapeHtml(formatBytes(item.size))}</div>
      `;
      storage.appendChild(card);
    }

    setStatus(
      `stats: concepts=${stats.counts.concepts}, edges=${stats.counts.edgesTotal}, refs=${stats.counts.references}`,
    );
  } catch (err) {
    showError($('#stats-cards'), err);
    setStatus('failed to load stats', 'error');
  }
}

// --- Concepts list ---------------------------------------------------------

interface ConceptsState {
  offset: number;
  limit: number;
  sort: 'lastSeenAt' | 'touchCount' | 'id';
  includeArchived: boolean;
  filter: string;
  cache: ConceptListResponse | null;
}

const conceptsState: ConceptsState = {
  offset: 0,
  limit: 50,
  sort: 'lastSeenAt',
  includeArchived: false,
  filter: '',
  cache: null,
};

async function renderConcepts(): Promise<void> {
  const params = new URLSearchParams({
    limit: String(conceptsState.limit),
    offset: String(conceptsState.offset),
    sort: conceptsState.sort,
    includeArchived: conceptsState.includeArchived ? 'true' : 'false',
  });
  setStatus('Loading concepts…');
  try {
    const data = await api<ConceptListResponse>(`/api/concepts?${params.toString()}`);
    conceptsState.cache = data;
    drawConceptsTable();
    setStatus(`concepts: ${data.total} total`);
  } catch (err) {
    showError($('#concepts-table'), err);
    setStatus('failed to load concepts', 'error');
  }
}

function drawConceptsTable(): void {
  const data = conceptsState.cache;
  const wrap = $('#concepts-table');
  if (!data) {
    wrap.innerHTML = '';
    return;
  }
  const filter = conceptsState.filter.trim().toLowerCase();
  const rows = filter
    ? data.items.filter(
        (c) => c.id.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter),
      )
    : data.items;

  if (rows.length === 0) {
    wrap.innerHTML = '<p class="muted" style="padding: 16px;">該当する Concept はありません。</p>';
    updatePager();
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>id</th>
          <th>description</th>
          <th>lastSeenAt</th>
          <th>touch</th>
          <th>access</th>
          <th>flags</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((c) => {
            const flags = [c.archived ? '<span class="badge archived">archived</span>' : '']
              .filter(Boolean)
              .join(' ');
            return `
              <tr class="${c.archived ? 'archived-row' : ''}">
                <td class="id-cell" data-id="${escapeHtml(c.id)}">${escapeHtml(c.id)}</td>
                <td>${escapeHtml(c.description)}</td>
                <td>${escapeHtml(formatDate(c.lastSeenAt))}</td>
                <td>${c.touchCount}</td>
                <td>${c.accessCount}</td>
                <td>${flags}</td>
              </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  `;
  wrap.innerHTML = html;
  for (const cell of wrap.querySelectorAll<HTMLElement>('.id-cell')) {
    cell.addEventListener('click', () => {
      const id = cell.dataset['id'];
      if (id) openInGraph(id);
    });
  }
  updatePager(rows.length);
}

function updatePager(filteredCount?: number): void {
  const data = conceptsState.cache;
  const info = $('#concepts-pageinfo');
  const prev = $('#concepts-prev') as HTMLButtonElement;
  const next = $('#concepts-next') as HTMLButtonElement;
  if (!data) {
    info.textContent = '';
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  const start = data.total === 0 ? 0 : data.offset + 1;
  const end = Math.min(data.offset + data.items.length, data.total);
  // The text filter only narrows the current page; surface that explicitly
  // so 50 件目以降のヒットが取りこぼされていることが分かるようにする。
  const filterNote =
    filteredCount !== undefined && filteredCount !== data.items.length
      ? ` · filter: ${filteredCount} / ${data.items.length} on this page`
      : '';
  info.textContent = `${start}–${end} / ${data.total}${filterNote}`;
  prev.disabled = data.offset <= 0;
  next.disabled = data.offset + data.items.length >= data.total;
}

// --- Search ----------------------------------------------------------------

let lastSearchSeed: string | null = null;

async function runSearch(event?: Event): Promise<void> {
  event?.preventDefault();
  const q = ($('#search-query') as HTMLInputElement).value.trim();
  if (q.length === 0) return;
  const limit = ($('#search-limit') as HTMLInputElement).value;
  const depth = ($('#search-depth') as HTMLInputElement).value;
  const threshold = ($('#search-threshold') as HTMLInputElement).value;
  const includeArchived = ($('#search-archived') as HTMLInputElement).checked;

  const params = new URLSearchParams({
    q,
    limit,
    depth,
    threshold,
    includeArchived: includeArchived ? 'true' : 'false',
  });

  setStatus(`searching: ${q}…`);
  const result = $('#search-result');
  result.innerHTML = '<p class="muted">…</p>';

  try {
    const data = await api<SearchResult>(`/api/search?${params.toString()}`);
    lastSearchSeed = data.matchedConcepts[0]?.id ?? null;
    ($('#search-graph-btn') as HTMLButtonElement).disabled = lastSearchSeed === null;

    const renderHit = (hit: SearchHit, isMatched: boolean): string => {
      const scoreParts: string[] = [];
      if (hit.score !== undefined) scoreParts.push(`score=${hit.score.toFixed(3)}`);
      if (hit.finalScore !== undefined) scoreParts.push(`final=${hit.finalScore.toFixed(3)}`);
      if (hit.freshness !== undefined && hit.freshness !== 0)
        scoreParts.push(`fresh=${hit.freshness.toFixed(3)}`);
      if (hit.demoted) scoreParts.push('demoted');
      const scores = scoreParts.length > 0 ? scoreParts.join(' · ') : '';
      const label = isMatched ? '' : '<span class="badge">related</span>';
      return `
        <div class="search-hit">
          <div class="head">
            <span class="id-cell" data-id="${escapeHtml(hit.id)}">${escapeHtml(hit.id)}</span>
            ${label}
            <span class="scores">${escapeHtml(scores)}</span>
          </div>
          <div class="desc">${escapeHtml(hit.description)}</div>
          ${hit.details ? `<div class="details">${escapeHtml(hit.details)}</div>` : ''}
        </div>
      `;
    };

    const matchedHtml = data.matchedConcepts.map((h) => renderHit(h, true)).join('');
    const relatedHtml = data.relatedConcepts.map((h) => renderHit(h, false)).join('');
    if (data.matchedConcepts.length === 0) {
      result.innerHTML = '<p class="muted">no results</p>';
      setStatus('no results');
      return;
    }
    result.innerHTML = `
      <div class="search-result">
        <h3>matched (${data.matchedConcepts.length})</h3>
        ${matchedHtml}
        ${
          data.relatedConcepts.length > 0
            ? `<h3>related (${data.relatedConcepts.length})</h3>${relatedHtml}`
            : ''
        }
      </div>
    `;
    for (const cell of result.querySelectorAll<HTMLElement>('.id-cell')) {
      cell.addEventListener('click', () => {
        const id = cell.dataset['id'];
        if (id) openInGraph(id);
      });
    }
    setStatus(`matched ${data.matchedConcepts.length} / related ${data.relatedConcepts.length}`);
  } catch (err) {
    showError(result, err);
    setStatus('search failed', 'error');
  }
}

function openInGraph(id: string): void {
  ($('#graph-seed') as HTMLInputElement).value = id;
  switchTab('graph');
  void loadGraph();
}

// --- Search Debug ----------------------------------------------------------

let lastDebugSeed: string | null = null;

function readOptionalNumberValue(selector: string): string | null {
  const raw = ($(selector) as HTMLInputElement).value.trim();
  return raw.length > 0 ? raw : null;
}

async function runSearchDebug(event?: Event): Promise<void> {
  event?.preventDefault();
  const q = ($('#search-debug-query') as HTMLInputElement).value.trim();
  if (q.length === 0) return;
  const params = new URLSearchParams({
    q,
    limit: ($('#search-debug-limit') as HTMLInputElement).value,
    depth: ($('#search-debug-depth') as HTMLInputElement).value,
    threshold: ($('#search-debug-threshold') as HTMLInputElement).value,
    includeArchived: ($('#search-debug-archived') as HTMLInputElement).checked ? 'true' : 'false',
  });
  const optionalParams: Array<[string, string]> = [
    ['freshnessWeight', '#search-debug-freshness-weight'],
    ['halfLifeDays', '#search-debug-half-life'],
    ['maxAgeDays', '#search-debug-max-age'],
    ['demoteDeprecated', '#search-debug-demote'],
    ['reinforcementWeight', '#search-debug-reinforcement-weight'],
    ['lexicalWeight', '#search-debug-lexical-weight'],
    ['bm25Weight', '#search-debug-bm25-weight'],
  ];
  for (const [key, selector] of optionalParams) {
    const v = readOptionalNumberValue(selector);
    if (v !== null) params.set(key, v);
  }

  setStatus(`debug-searching: ${q}…`);
  const result = $('#search-debug-result');
  result.innerHTML = '<p class="muted">…</p>';

  try {
    const data = await api<SearchDebugResponse>(`/api/search/debug?${params.toString()}`);
    lastDebugSeed = data.result.matchedConcepts[0]?.id ?? null;
    ($('#search-debug-graph-btn') as HTMLButtonElement).disabled = lastDebugSeed === null;
    renderSearchDebug(result, data);
    setStatus(
      `trace: vec hits=${data.trace.vectorHits.length} (passed=${data.trace.vectorHits.filter((h) => h.passedThreshold).length}) · candidates=${data.trace.candidates.length}`,
    );
  } catch (err) {
    showError(result, err);
    setStatus('search debug failed', 'error');
  }
}

function renderSearchDebug(target: HTMLElement, data: SearchDebugResponse): void {
  const { result, trace } = data;
  const passed = trace.vectorHits.filter((h) => h.passedThreshold).length;
  const rejected = trace.vectorHits.length - passed;
  const matchedSet = new Set(result.matchedConcepts.map((c) => c.id));

  target.innerHTML = `
    <section class="debug-section">
      <h3>Query embedding</h3>
      <div class="debug-meta">
        dim=${trace.queryEmbedding.dim} · L2=${trace.queryEmbedding.l2Norm.toFixed(4)}
      </div>
      <div class="debug-mono">[${trace.queryEmbedding.preview
        .map((v) => v.toFixed(4))
        .join(', ')}, …]</div>
      <details>
        <summary>全 ${trace.queryEmbedding.full.length} 次元を表示</summary>
        <pre class="debug-pre">[${trace.queryEmbedding.full
          .map((v) => v.toFixed(6))
          .join(', ')}]</pre>
      </details>
      <div class="debug-meta" style="margin-top:6px;">
        query tokens (lexical scorer 用):
        ${
          trace.queryTokens.length === 0
            ? '<em>(none)</em>'
            : trace.queryTokens.map((t) => `<code>${escapeHtml(t)}</code>`).join(' ')
        }
      </div>
    </section>

    <section class="debug-section">
      <h3>Vector request</h3>
      <div class="debug-meta">
        limit (oversample) = ${trace.vectorRequest.oversample} ·
        threshold = ${trace.vectorRequest.threshold}
      </div>
    </section>

    <section class="debug-section">
      <h3>FTS5 hits (BM25, ${trace.ftsHits.length} 件)</h3>
      ${
        trace.ftsHits.length === 0
          ? '<p class="muted">no fts hits</p>'
          : `<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>bm25 (normalised)</th>
              <th>raw rank</th>
            </tr>
          </thead>
          <tbody>
            ${trace.ftsHits
              .map(
                (h) => `
                  <tr>
                    <td class="id-cell" data-id="${escapeHtml(h.id)}">${escapeHtml(h.id)}</td>
                    <td>${h.bm25.toFixed(4)}</td>
                    <td>${h.rawRank.toFixed(4)}</td>
                  </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`
      }
    </section>

    <section class="debug-section">
      <h3>Vector hits (threshold 前 ${trace.vectorHits.length} 件 · 通過 ${passed} · 棄却 ${rejected})</h3>
      ${
        trace.vectorHits.length === 0
          ? '<p class="muted">no hits</p>'
          : `<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>text</th>
              <th>cosine</th>
              <th>distance</th>
              <th>threshold</th>
            </tr>
          </thead>
          <tbody>
            ${trace.vectorHits
              .map(
                (h) => `
                  <tr class="${h.passedThreshold ? '' : 'debug-rejected-row'}">
                    <td class="id-cell" data-id="${escapeHtml(h.id)}">${escapeHtml(h.id)}</td>
                    <td>${escapeHtml(h.text)}</td>
                    <td>${h.cosine.toFixed(4)}</td>
                    <td>${h.distance.toFixed(4)}</td>
                    <td>${h.passedThreshold ? '✓' : '✗ rejected'}</td>
                  </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`
      }
    </section>

    <section class="debug-section">
      <h3>Graph queries (${trace.graphQueries.length})</h3>
      ${trace.graphQueries
        .map(
          (q) => `
            <div class="debug-query">
              <div class="debug-meta">
                <strong>${escapeHtml(q.label)}</strong>
                ${
                  q.idsPreview.length > 0
                    ? ` · ids: [${q.idsPreview
                        .map((id) => escapeHtml(id))
                        .join(', ')}${q.idsPreview.length >= 5 ? ', …' : ''}]`
                    : ''
                }
              </div>
              <pre class="debug-pre">${escapeHtml(q.cypher)}</pre>
            </div>`,
        )
        .join('')}
    </section>

    <section class="debug-section">
      <h3>Scoring breakdown (${trace.candidates.length})</h3>
      ${
        trace.candidates.length === 0
          ? '<p class="muted">no candidates</p>'
          : `<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>cosine</th>
              <th>freshness</th>
              <th>age (d)</th>
              <th>access</th>
              <th>reinf</th>
              <th>lexical</th>
              <th>bm25</th>
              <th>flags</th>
              <th>final</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            ${trace.candidates
              .map((c) => {
                const status = c.excluded
                  ? `<span class="badge debug-excluded">${escapeHtml(c.excluded)}</span>`
                  : matchedSet.has(c.id)
                    ? '<span class="badge debug-matched">matched</span>'
                    : '<span class="badge">candidate</span>';
                const flags = [c.demoted ? 'demoted' : '', c.archived ? 'archived' : '']
                  .filter((s) => s.length > 0)
                  .join(' · ');
                return `
                  <tr class="${c.excluded ? 'debug-rejected-row' : ''}">
                    <td class="id-cell" data-id="${escapeHtml(c.id)}">${escapeHtml(c.id)}</td>
                    <td>${c.cosine.toFixed(4)}</td>
                    <td>${c.freshness.toFixed(4)}</td>
                    <td>${c.ageDays === null ? '—' : c.ageDays.toFixed(1)}</td>
                    <td>${c.accessCount}</td>
                    <td>${c.reinforcement.toFixed(4)}</td>
                    <td>${c.lexical.toFixed(4)}</td>
                    <td>${c.bm25.toFixed(4)}</td>
                    <td>${flags}</td>
                    <td>${c.finalScore.toFixed(4)}</td>
                    <td>${status}</td>
                  </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>`
      }
    </section>

    <section class="debug-section">
      <h3>Graph traversal (depth=${trace.traversal.depth})</h3>
      ${
        trace.traversal.levels.length === 0
          ? '<p class="muted">no traversal (depth 0 か matched 0 件)</p>'
          : `<ul class="debug-traversal">
              ${trace.traversal.levels
                .map(
                  (l) => `
                  <li>
                    <strong>level ${l.level}</strong>:
                    frontier ${l.frontier.length} 件 · edges +${l.edgesAdded}
                    ${
                      l.frontier.length > 0
                        ? `<div class="debug-mono">[${l.frontier
                            .slice(0, 8)
                            .map(escapeHtml)
                            .join(', ')}${l.frontier.length > 8 ? ', …' : ''}]</div>`
                        : ''
                    }
                  </li>`,
                )
                .join('')}
            </ul>`
      }
    </section>
  `;

  for (const cell of target.querySelectorAll<HTMLElement>('.id-cell')) {
    cell.addEventListener('click', () => {
      const id = cell.dataset['id'];
      if (id) openInGraph(id);
    });
  }
}

// --- Graph -----------------------------------------------------------------

let cy: Core | null = null;
const expanded = new Set<string>();

function ensureGraphReady(): void {
  if (cy) return;
  cy = cytoscape({
    container: document.getElementById('cy'),
    style: [
      {
        selector: 'node',
        style: {
          'background-color': '#1f6feb',
          label: 'data(label)',
          color: '#e6edf3',
          'font-size': '8px',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '160px',
          'border-width': 1,
          'border-color': '#2a313c',
          width: 36,
          height: 36,
        },
      },
      {
        selector: 'node[?root]',
        style: {
          'background-color': '#58a6ff',
          'border-color': '#e6edf3',
          'border-width': 2,
          width: 50,
          height: 50,
        },
      },
      {
        selector: 'node[?archived]',
        style: {
          'background-color': '#3a3f47',
          'border-style': 'dashed',
          color: '#8b949e',
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1.4,
          'line-color': 'data(color)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          label: 'data(label)',
          'font-size': '9px',
          color: '#8b949e',
          'text-rotation': 'autorotate',
          'text-background-color': '#0e1116',
          'text-background-opacity': 0.7,
          'text-background-padding': '2px',
        },
      },
      {
        selector: 'node:selected',
        style: {
          'border-color': '#f0883e',
          'border-width': 3,
        },
      },
    ],
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
  });
  cy.on('tap', 'node', (event: EventObject) => {
    const node = event.target;
    const id = node.id();
    showGraphDetail(id);
    void expandNode(id);
  });
}

async function loadGraph(): Promise<void> {
  ensureGraphReady();
  if (!cy) return;
  const seed = ($('#graph-seed') as HTMLInputElement).value.trim();
  if (seed.length === 0) {
    setStatus('graph seed must not be empty', 'error');
    return;
  }
  const depth = ($('#graph-depth') as HTMLInputElement).value;
  const includeArchived = ($('#graph-archived') as HTMLInputElement).checked;
  setStatus(`loading neighbors of ${seed}…`);
  try {
    const data = await api<NeighborsResponse>(
      `/api/concepts/${encodeURIComponent(seed)}/neighbors?depth=${depth}&includeArchived=${
        includeArchived ? 'true' : 'false'
      }`,
    );
    cy.elements().remove();
    expanded.clear();
    addToCy(data);
    expanded.add(data.rootId);
    runLayout();
    showGraphDetail(data.rootId);
    setStatus(`graph: ${data.nodes.length} nodes / ${data.edges.length} edges`);
  } catch (err) {
    setStatus(`graph load failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function expandNode(id: string): Promise<void> {
  if (!cy) return;
  if (expanded.has(id)) return;
  const includeArchived = ($('#graph-archived') as HTMLInputElement).checked;
  setStatus(`expanding ${id}…`);
  try {
    const data = await api<NeighborsResponse>(
      `/api/concepts/${encodeURIComponent(id)}/neighbors?depth=1&includeArchived=${
        includeArchived ? 'true' : 'false'
      }`,
    );
    addToCy(data);
    expanded.add(id);
    runLayout();
    setStatus(`expanded ${id} (+${data.nodes.length} nodes)`);
  } catch (err) {
    setStatus(`expand failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

function addToCy(data: NeighborsResponse): void {
  if (!cy) return;
  const nodeAdds: NodeDefinition[] = [];
  for (const n of data.nodes) {
    if (cy.getElementById(n.id).length > 0) continue;
    nodeAdds.push({
      data: {
        id: n.id,
        label: n.id,
        description: n.description,
        details: n.details,
        archived: n.archived ? 1 : 0,
        root: n.id === data.rootId ? 1 : 0,
      },
    });
  }
  const edgeAdds: EdgeDefinition[] = [];
  for (const e of data.edges) {
    const key = `${e.source}|${e.type}|${e.target}`;
    if (cy.getElementById(key).length > 0) continue;
    if (cy.getElementById(e.source).length === 0 && !nodeAdds.some((n) => n.data.id === e.source))
      continue;
    if (cy.getElementById(e.target).length === 0 && !nodeAdds.some((n) => n.data.id === e.target))
      continue;
    edgeAdds.push({
      data: {
        id: key,
        source: e.source,
        target: e.target,
        label: e.type,
        type: e.type,
        reason: e.reason,
        color: EDGE_COLORS[e.type] ?? DEFAULT_EDGE_COLOR,
      },
    });
  }
  cy.add(nodeAdds);
  cy.add(edgeAdds);
}

function runLayout(): void {
  if (!cy) return;
  cy.layout({
    name: 'cose',
    animate: false,
    fit: true,
    padding: 30,
    // biome-ignore lint/suspicious/noExplicitAny: cytoscape layout type unions
  } as any).run();
}

function showGraphDetail(id: string): void {
  const aside = $('#graph-detail');
  aside.innerHTML = '<p class="muted">読み込み中…</p>';
  api<ConceptDetailResponse>(`/api/concepts/${encodeURIComponent(id)}`)
    .then((concept) => {
      if (!cy) return;
      // Cytoscape selectors can break on ids that contain CSS-significant
      // characters (spaces, '#', '.'). Use the node API instead.
      const node = cy.getElementById(id);
      const connected = node.length > 0 ? node.connectedEdges() : cy.collection();
      const incoming = connected.filter((edge) => edge.data('target') === id);
      const outgoing = connected.filter((edge) => edge.data('source') === id);
      const refs = concept.references
        .map(
          (r) =>
            `<li><a href="${escapeHtml(safeHref(r.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title)}</a></li>`,
        )
        .join('');
      aside.innerHTML = `
        <h4>${escapeHtml(concept.id)}</h4>
        <div class="meta">
          ${concept.archived ? '<span class="badge archived">archived</span> ' : ''}
          touch=${concept.touchCount} · access=${concept.accessCount}
          ${concept.lastSeenAt ? `<br/>lastSeenAt ${escapeHtml(formatDate(concept.lastSeenAt))}` : ''}
        </div>
        <p>${escapeHtml(concept.description)}</p>
        ${concept.details ? `<pre style="white-space:pre-wrap; font-size:12px;">${escapeHtml(concept.details)}</pre>` : ''}
        <div class="neighbor-list">
          <strong>connections</strong>
          <ul>
            <li>incoming: ${incoming.length}</li>
            <li>outgoing: ${outgoing.length}</li>
          </ul>
        </div>
        ${
          refs ? `<div class="neighbor-list"><strong>references</strong><ul>${refs}</ul></div>` : ''
        }
      `;
    })
    .catch((err: Error) => {
      aside.innerHTML = `<p class="error-banner">${escapeHtml(err.message)}</p>`;
    });
}

// --- Misc UI plumbing ------------------------------------------------------

function showError(target: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  target.innerHTML = `<div class="error-banner">${escapeHtml(message)}</div>`;
}

function bindUI(): void {
  for (const btn of $$<HTMLButtonElement>('.tab')) {
    btn.addEventListener('click', () => {
      const tab = btn.dataset['tab'] as TabName | undefined;
      if (tab) switchTab(tab);
    });
  }

  $('#refresh').addEventListener('click', () => {
    if (activeTab === 'overview') void renderOverview();
    if (activeTab === 'concepts') void renderConcepts();
    if (activeTab === 'graph' && cy && cy.elements().length > 0) void loadGraph();
  });

  $('#concepts-sort').addEventListener('change', () => {
    conceptsState.sort = ($('#concepts-sort') as HTMLSelectElement).value as ConceptsState['sort'];
    conceptsState.offset = 0;
    void renderConcepts();
  });
  $('#concepts-archived').addEventListener('change', () => {
    conceptsState.includeArchived = ($('#concepts-archived') as HTMLInputElement).checked;
    conceptsState.offset = 0;
    void renderConcepts();
  });
  $('#concepts-filter').addEventListener('input', () => {
    conceptsState.filter = ($('#concepts-filter') as HTMLInputElement).value;
    drawConceptsTable();
  });
  $('#concepts-prev').addEventListener('click', () => {
    conceptsState.offset = Math.max(0, conceptsState.offset - conceptsState.limit);
    void renderConcepts();
  });
  $('#concepts-next').addEventListener('click', () => {
    conceptsState.offset += conceptsState.limit;
    void renderConcepts();
  });

  $('#search-form').addEventListener('submit', runSearch);
  $('#search-graph-btn').addEventListener('click', () => {
    if (lastSearchSeed) openInGraph(lastSearchSeed);
  });

  $('#search-debug-form').addEventListener('submit', runSearchDebug);
  $('#search-debug-graph-btn').addEventListener('click', () => {
    if (lastDebugSeed) openInGraph(lastDebugSeed);
  });

  $('#graph-load').addEventListener('click', () => {
    void loadGraph();
  });
  $('#graph-fit').addEventListener('click', () => {
    if (cy) cy.fit(undefined, 30);
  });
  $('#graph-reset').addEventListener('click', () => {
    if (!cy) return;
    cy.elements().remove();
    expanded.clear();
    $('#graph-detail').innerHTML = '<p class="muted">ノードを選択すると詳細を表示します。</p>';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  switchTab('overview');
});
