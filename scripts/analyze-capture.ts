import * as fs from 'node:fs';
import * as path from 'node:path';

const POOL_FIELD_REGEXES: RegExp[] = [
  /pool/i,
  /^amount/i,
  /amount$/i,
  /dollars?/i,
  /^total/i,
  /total$/i,
];

const RUNNER_ARRAY_KEY_REGEXES: RegExp[] = [
  /^runners?$/i,
  /^horses?$/i,
  /^entries$/i,
  /^participants$/i,
  /^selections$/i,
  /^contestants$/i,
  /^bettinginterests?$/i,
];

const LARGE_VALUE_THRESHOLD = 1000;
const SAMPLE_BODY_PREVIEW_CHARS = 500;

export interface CaptureRecord {
  kind?: 'http' | 'ws';
  ts: string;
  url: string;
  // HTTP-only fields (optional so older captures without `kind` still validate)
  method?: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string | null;
  requestBodyTruncated?: boolean;
  // WS-only fields
  direction?: 'sent' | 'received';
  // Common
  body: string;
  truncated: boolean;
}

export interface FieldHit {
  path: string;
  reason: 'name-match' | 'large-numeric-array';
  sampleValue: number;
}

export interface EndpointCandidate {
  pattern: string;
  hits: number;
  cadenceSecondsMean: number | null;
  poolFields: FieldHit[];
  sampleUrl: string;
  sampleStatus: number | null;
  sampleBodyPreview: string;
  score: number;
}

export interface AnalysisResult {
  totalRecords: number;
  validJsonRecords: number;
  uniquePatterns: number;
  patternFrequency: Array<{ pattern: string; count: number }>;
  candidates: EndpointCandidate[];
}

export function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').map((seg) => {
      if (seg.length === 0) return seg;
      if (/^\d{2,}$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      if (seg.length > 12 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) return ':token';
      return seg;
    });
    return u.origin + segments.join('/');
  } catch {
    return url;
  }
}

export function loadCaptureFile(filePath: string): CaptureRecord[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const records: CaptureRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CaptureRecord);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function parseBodyJson(record: CaptureRecord): unknown | null {
  try {
    return JSON.parse(record.body);
  } catch {
    return null;
  }
}

export function extractOperationName(record: CaptureRecord): string | null {
  if (record.kind === 'ws') return null;
  if (!record.requestBody) return null;
  try {
    const parsed = JSON.parse(record.requestBody);
    if (parsed && typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const name = obj.operationName;
      if (typeof name === 'string' && name.length > 0) return name;
    }
  } catch {
    // not JSON — not a GraphQL request
  }
  return null;
}

export function clusterKey(record: CaptureRecord): string {
  const pat = urlPattern(record.url);
  if (record.kind === 'ws') {
    const dir = record.direction ?? 'unknown';
    return `${pat} [ws:${dir}]`;
  }
  const opName = extractOperationName(record);
  if (opName) return `${pat} [op:${opName}]`;
  return pat;
}

/**
 * Strip a GraphQL transport envelope so pool-field detection runs on the actual
 * data payload. Handles three shapes:
 *   - HTTP GraphQL response: { data: {...}, errors?: [...] }
 *   - graphql-ws subscription frame: { id, type: 'next', payload: { data: {...} } }
 *   - Anything else: returned unchanged.
 */
export function extractGraphQLData(json: unknown): unknown {
  if (!json || typeof json !== 'object') return json;
  const obj = json as Record<string, unknown>;
  if (obj.payload && typeof obj.payload === 'object' && obj.payload !== null) {
    const payload = obj.payload as Record<string, unknown>;
    if ('data' in payload) return payload.data;
  }
  if ('data' in obj) return obj.data;
  return json;
}

export function findPoolFields(json: unknown, basePath = ''): FieldHit[] {
  const hits: FieldHit[] = [];
  walk(json, basePath, hits);
  return dedupePathPrefix(hits);
}

function walk(node: unknown, p: string, hits: FieldHit[]): void {
  if (Array.isArray(node)) {
    if (node.length > 0) walk(node[0], `${p}[0]`, hits);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const sub = p ? `${p}.${key}` : key;
    if (typeof value === 'number') {
      if (POOL_FIELD_REGEXES.some((rx) => rx.test(key))) {
        hits.push({ path: sub, reason: 'name-match', sampleValue: value });
      }
    } else if (Array.isArray(value)) {
      if (RUNNER_ARRAY_KEY_REGEXES.some((rx) => rx.test(key))) {
        hits.push(...findRunnerArrayPoolFields(value, sub));
      }
      if (value.length > 0) walk(value[0], `${sub}[0]`, hits);
    } else {
      walk(value, sub, hits);
    }
  }
}

function findRunnerArrayPoolFields(arr: unknown[], basePath: string): FieldHit[] {
  if (arr.length === 0) return [];
  const numericFields = new Map<string, number[]>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (typeof v === 'number') {
        if (!numericFields.has(k)) numericFields.set(k, []);
        numericFields.get(k)!.push(v);
      }
    }
  }
  const hits: FieldHit[] = [];
  for (const [fieldName, values] of numericFields) {
    if (
      values.length === arr.length &&
      values.every((v) => Number.isFinite(v) && v > LARGE_VALUE_THRESHOLD)
    ) {
      hits.push({
        path: `${basePath}[].${fieldName}`,
        reason: 'large-numeric-array',
        sampleValue: values[0],
      });
    }
  }
  return hits;
}

function dedupePathPrefix(hits: FieldHit[]): FieldHit[] {
  const byNormalizedPath = new Map<string, FieldHit>();
  for (const h of hits) {
    const normalized = h.path.replace(/\[\d+\]/g, '[]');
    const existing = byNormalizedPath.get(normalized);
    if (!existing) {
      byNormalizedPath.set(normalized, { ...h, path: normalized });
    } else if (existing.reason === 'name-match' && h.reason === 'large-numeric-array') {
      byNormalizedPath.set(normalized, { ...h, path: normalized });
    }
  }
  return [...byNormalizedPath.values()];
}

function meanCadenceSeconds(records: CaptureRecord[]): number | null {
  if (records.length < 2) return null;
  const times = records
    .map((r) => Date.parse(r.ts))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  let total = 0;
  let count = 0;
  for (let i = 1; i < times.length; i++) {
    const dt = (times[i] - times[i - 1]) / 1000;
    if (dt > 0) {
      total += dt;
      count += 1;
    }
  }
  return count > 0 ? total / count : null;
}

function scoreCandidate(fields: FieldHit[], records: number): number {
  const arrayHits = fields.filter((h) => h.reason === 'large-numeric-array').length;
  const nameHits = fields.filter((h) => h.reason === 'name-match').length;
  const basis = arrayHits * 3 + nameHits * 1;
  return basis * Math.log(records + 1);
}

export function analyzeRecords(records: CaptureRecord[]): AnalysisResult {
  const groups = new Map<string, CaptureRecord[]>();
  for (const r of records) {
    const key = clusterKey(r);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(r);
  }

  const patternFrequency = [...groups.entries()]
    .map(([pattern, recs]) => ({ pattern, count: recs.length }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

  let validJsonRecords = 0;
  const candidates: EndpointCandidate[] = [];
  for (const [pattern, recs] of groups.entries()) {
    const allHits: FieldHit[] = [];
    let parsedAny = false;
    for (const r of recs) {
      const json = parseBodyJson(r);
      if (json === null) continue;
      validJsonRecords += 1;
      parsedAny = true;
      const data = extractGraphQLData(json);
      allHits.push(...findPoolFields(data));
    }
    if (!parsedAny) continue;
    const poolFields = dedupePathPrefix(allHits);
    const score = scoreCandidate(poolFields, recs.length);
    const first = recs[0];
    candidates.push({
      pattern,
      hits: recs.length,
      cadenceSecondsMean: meanCadenceSeconds(recs),
      poolFields,
      sampleUrl: first.url,
      sampleStatus: typeof first.status === 'number' ? first.status : null,
      sampleBodyPreview: first.body.slice(0, SAMPLE_BODY_PREVIEW_CHARS),
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.pattern.localeCompare(b.pattern));

  return {
    totalRecords: records.length,
    validJsonRecords,
    uniquePatterns: groups.size,
    patternFrequency,
    candidates,
  };
}

export function formatStdoutSummary(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Capture analysis`);
  lines.push(`  Total records       : ${result.totalRecords}`);
  lines.push(`  Valid JSON          : ${result.validJsonRecords}`);
  lines.push(`  Unique URL patterns : ${result.uniquePatterns}`);
  lines.push('');
  lines.push(`  Top 10 patterns by frequency:`);
  for (const pf of result.patternFrequency.slice(0, 10)) {
    lines.push(`    ${pf.count.toString().padStart(5)}  ${pf.pattern}`);
  }
  lines.push('');
  lines.push(`  Candidate pool-bearing endpoints (top 5 by score):`);
  if (result.candidates.length === 0) {
    lines.push('    (none — capture file may be empty or contained no JSON responses)');
  } else {
    for (const c of result.candidates.slice(0, 5)) {
      const cadence = c.cadenceSecondsMean !== null ? `${c.cadenceSecondsMean.toFixed(1)}s` : 'n/a';
      lines.push(`    [${c.score.toFixed(2)}] ${c.pattern}`);
      lines.push(`      hits: ${c.hits}, cadence: ${cadence}`);
      if (c.poolFields.length > 0) {
        for (const f of c.poolFields.slice(0, 5)) {
          lines.push(`        - ${f.path} (${f.reason}, sample=${f.sampleValue})`);
        }
      } else {
        lines.push(`        (no pool-bearing fields detected)`);
      }
    }
  }
  return lines.join('\n');
}

export function formatMarkdown(result: AnalysisResult, capturePath: string): string {
  const lines: string[] = [];
  lines.push(`# Capture analysis`);
  lines.push('');
  lines.push(`**Source**: \`${capturePath}\``);
  lines.push(`**Generated**: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- Total records: ${result.totalRecords}`);
  lines.push(`- Valid JSON: ${result.validJsonRecords}`);
  lines.push(`- Unique patterns: ${result.uniquePatterns}`);
  lines.push('');
  lines.push(`Pattern key format: \`<url-pattern> [op:<gqlOperationName>]\` for GraphQL HTTP requests, \`<url> [ws:<direction>]\` for WebSocket frames, plain URL pattern otherwise.`);
  lines.push('');
  lines.push(`## Patterns by frequency`);
  lines.push('');
  lines.push('| Count | Pattern |');
  lines.push('|------:|---------|');
  for (const pf of result.patternFrequency.slice(0, 50)) {
    lines.push(`| ${pf.count} | \`${pf.pattern}\` |`);
  }
  lines.push('');
  lines.push(`## Candidate pool-bearing endpoints`);
  lines.push('');
  lines.push('Sorted by score = (3 × large-numeric-array hits + name-match hits) × ln(records + 1).');
  lines.push('Higher score = more likely a real pool-bearing endpoint. Review the top few before writing `auth/discovered-endpoints.md`.');
  lines.push('');
  if (result.candidates.length === 0) {
    lines.push('_No JSON responses captured. Re-run `pnpm run login` and stay on a live race page longer._');
  } else {
    for (const c of result.candidates) {
      lines.push(`### \`${c.pattern}\``);
      lines.push('');
      lines.push(`- **Score**: ${c.score.toFixed(2)}`);
      lines.push(`- **Hits**: ${c.hits}`);
      lines.push(`- **Refresh cadence (mean Δt)**: ${c.cadenceSecondsMean !== null ? c.cadenceSecondsMean.toFixed(1) + 's' : 'n/a'}`);
      lines.push(`- **Sample URL**: ${c.sampleUrl}`);
      lines.push(`- **Sample status**: ${c.sampleStatus ?? 'n/a'}`);
      if (c.poolFields.length > 0) {
        lines.push(`- **Pool-bearing fields detected**:`);
        for (const f of c.poolFields) {
          lines.push(`  - \`${f.path}\` (${f.reason}, sample value: \`${f.sampleValue}\`)`);
        }
      } else {
        lines.push(`- **Pool-bearing fields detected**: none`);
      }
      lines.push('');
      lines.push(`<details><summary>Sample body (first ${SAMPLE_BODY_PREVIEW_CHARS} chars)</summary>`);
      lines.push('');
      lines.push('```json');
      lines.push(c.sampleBodyPreview);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const capturePath = path.resolve('auth/network-capture.jsonl');
  const outputPath = path.resolve('auth/capture-analysis.md');

  if (!fs.existsSync(capturePath)) {
    console.error(`No capture file at ${capturePath}.`);
    console.error(`Run \`pnpm run login\` first to produce a capture.`);
    process.exit(1);
  }

  const records = loadCaptureFile(capturePath);
  const result = analyzeRecords(records);
  console.log(formatStdoutSummary(result));
  fs.writeFileSync(outputPath, formatMarkdown(result, capturePath), 'utf8');
  console.log(`\nFull report written to ${outputPath}\n`);
}

const entry = process.argv[1] ?? '';
if (/analyze-capture\.ts$/.test(entry) || /analyze-capture\.js$/.test(entry)) {
  void main();
}
