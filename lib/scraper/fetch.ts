import type { BrowserContext } from 'playwright';
import { FDR_GRAPHQL_HTTP_URL, type GraphQLOperation } from './queries';

/**
 * Authed HTTP GraphQL request via the Playwright context's `request` API.
 * Uses the cookies/origin from the BrowserContext so we don't rebuild the
 * session manually.
 */

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export class FdrRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FdrRequestError';
    this.status = status;
  }
}

/**
 * PerimeterX / HUMAN bot-challenge intercepted our request. The page is
 * showing "Please verify you are a human" and HTTP queries return HTML
 * instead of JSON. Surfaces all the way up to the dashboard so the user
 * can click into the Chrome window and complete the "Press & Hold" check.
 */
export class BotChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotChallengeError';
  }
}

/** Signature strings that show up in PerimeterX / HUMAN challenge HTML. */
const BOT_CHALLENGE_MARKERS: readonly string[] = [
  'Please verify you are a human',
  '_pxAppId',
  'px-captcha',
  'captcha-delivery',
  'Access to this page has been denied because we believe you are using automation',
];

function looksLikeBotChallenge(body: string): boolean {
  if (!body) return false;
  return BOT_CHALLENGE_MARKERS.some((m) => body.includes(m));
}

export interface FetchGraphQLOptions {
  context: BrowserContext;
  operation: GraphQLOperation;
  variables?: Record<string, unknown>;
  /** Override the GraphQL endpoint — defaults to FDR_GRAPHQL_HTTP_URL. */
  url?: string;
}

export interface GraphQLEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string; [key: string]: unknown }>;
}

export async function fetchGraphQL<T = unknown>(
  options: FetchGraphQLOptions,
): Promise<T> {
  const { context, operation, variables = {}, url = FDR_GRAPHQL_HTTP_URL } = options;
  const response = await context.request.post(url, {
    data: {
      operationName: operation.operationName,
      variables,
      query: operation.query,
    },
    headers: {
      'content-type': 'application/json',
      'x-tvg-context': 'tvg5-fdr',
      accept: '*/*',
    },
    failOnStatusCode: false,
  });

  const status = response.status();
  const contentType = (response.headers()['content-type'] ?? '').toLowerCase();
  // PerimeterX swaps in an HTML challenge page. Detect by content-type or
  // body markers BEFORE the JSON parse, otherwise we'd just hit a
  // useless "Unexpected token <" error and lose the diagnostic.
  if (contentType.includes('text/html')) {
    const body = await response.text().catch(() => '');
    if (looksLikeBotChallenge(body)) {
      throw new BotChallengeError(
        `FanDuel returned a bot-challenge page for ${operation.operationName}. The user must complete the Press & Hold check.`,
      );
    }
  }

  if (status === 401 || status === 403) {
    // 403 with a challenge marker is bot-challenge, not session expiry.
    const peek = await response.text().catch(() => '');
    if (looksLikeBotChallenge(peek)) {
      throw new BotChallengeError(
        `FanDuel bot-challenge intercepted ${operation.operationName} (status ${status}).`,
      );
    }
    throw new SessionExpiredError(
      `FDR session is no longer valid (status ${status}). Re-run \`pnpm run login\`.`,
    );
  }
  if (status >= 400) {
    throw new FdrRequestError(
      `FDR GraphQL request failed: ${operation.operationName} → ${status} ${response.statusText()}`,
      status,
    );
  }

  const envelope = (await response.json()) as GraphQLEnvelope<T>;
  if (envelope.errors && envelope.errors.length > 0) {
    throw new FdrRequestError(
      `FDR GraphQL returned errors for ${operation.operationName}: ${envelope.errors.map((e) => e.message).join('; ')}`,
      status,
    );
  }
  if (envelope.data === undefined) {
    throw new FdrRequestError(`FDR GraphQL returned no data for ${operation.operationName}`, status);
  }
  return envelope.data;
}

/** Shape returned by the getRacesMtpStatus operation (subset we use). */
export interface RacesMtpStatusResponse {
  raceDate: string | null;
  mtpRaces: Array<{
    number: string;
    mtp: number;
    trackCode: string;
    trackName: string;
    postTime: string;
    track?: { perfAbbr?: string };
    status: { code: string };
  }>;
}
