/**
 * Tavily web-search wrapper. The chat-with-the-bookmaker feature calls this
 * via Claude tool use to pull fresh information that's not in the dashboard
 * — jockey/trainer news, scratches, weather, recent form, etc.
 *
 * Tavily docs: https://docs.tavily.com/docs/rest-api/api-reference
 */

const TAVILY_URL = 'https://api.tavily.com/search';

export type TavilyDepth = 'basic' | 'advanced';

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  raw_content?: string | null;
}

export interface TavilyImage {
  url: string;
  description?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer: string | null;
  results: TavilyResult[];
  images?: Array<TavilyImage | string>;
  response_time?: number;
}

export interface TavilySearchOptions {
  depth?: TavilyDepth;
  maxResults?: number;
  includeAnswer?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeImages?: boolean;
}

export async function tavilySearch(
  query: string,
  options: TavilySearchOptions = {},
): Promise<TavilySearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY not set in .env');
  }

  const body = {
    api_key: apiKey,
    query,
    search_depth: options.depth ?? 'basic',
    max_results: options.maxResults ?? 5,
    include_answer: options.includeAnswer ?? true,
    include_domains: options.includeDomains,
    exclude_domains: options.excludeDomains,
    include_images: options.includeImages ?? false,
    include_image_descriptions: options.includeImages ?? false,
  };

  const response = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Tavily HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as TavilySearchResponse;
}
