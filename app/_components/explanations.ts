/**
 * Plain-English text shown in the dashboard's hover tooltips and legend.
 * Written for someone who doesn't speak pari-mutuel jargon. The dashboard's
 * job is BETTING RECOMMENDATIONS — every explanation should make clear what
 * action the user should take when they see this metric or signal.
 */

export const EXPLANATIONS = {
  // ── Signals (the primary "what should I do?" output) ────────────────────
  signal:
    'The bet recommendation for this horse. SLAM DUNK = strong bet candidate. LEAN = consider a smaller bet. DRIFT = check manually first. NONE = skip.',
  slamDunk:
    'BET this horse to PLACE or SHOW (whichever edge is positive). The strongest signal: even the worst-case projected payout (when paired with the heaviest-pool other finisher) still beats the math\'s fair price. This is exactly the kind of pool distortion the tool is looking for.',
  lean:
    'CONSIDER a smaller place or show bet. The average projected payout across all possible companion finishers is at least 5% above fair. Not as strong as a slam dunk — pool dynamics could erase the edge before post — but a reasonable spot.',
  drift:
    'INVESTIGATE before betting. Current odds have lengthened more than 50% from morning line. Often signals late money flowing to a different horse, sometimes signals a connections-side red flag. Worth a manual look at the program/news before acting.',
  none:
    'No actionable signal. Skip this horse for the place/show arbitrage thesis.',

  // ── Per-column explanations ─────────────────────────────────────────────
  programNumber:
    'Saddlecloth / program number. The number painted on the horse\'s saddlecloth and listed in the program. Same identifier the track announcer uses.',
  horseName: 'Horse name, jockey, trainer.',
  morningLineOdds:
    'Morning line — the track handicapper\'s pre-race estimate of fair odds, set the night before. Shown as decimal odds (e.g., 5.0 = 4-to-1, you risk $1 to win $4 plus your stake back).',
  currentOdds:
    'Live decimal odds derived from the win pool. Updates every few seconds as bets come in. The number you actually get paid against if this horse wins.',
  drift_metric:
    'Drift % = (current − morning_line) / morning_line. Positive = horse is "drifting out" (current is longer than ML; less money on it than the handicapper expected). Negative = horse is "shortening" (more money than expected). >+50% triggers the DRIFT signal.',
  pWin:
    'Estimated probability that this horse WINS. Computed from live win-pool dollars (preferred — the win pool is the most efficient market) or from current decimal odds with the bookmaker overround stripped. Sums to 1 across all non-scratched horses.',

  // ── Place / Show columns ────────────────────────────────────────────────
  placeActual:
    'Projected $2 PLACE payout you\'d collect right now if this horse finishes top-2. Three numbers because the actual payout depends on which OTHER horse finishes top-2 with it. FLOOR = paired with the horse holding the most place-pool money (worst case for you). MID = average across all possible companions. CEILING = paired with the smallest-pool horse (best case).',
  placeFair:
    'What the place payout SHOULD be if the place pool perfectly tracked the horse\'s true placing probability. Two models shown — HARV (Harville order-statistics, the rigorous one used for signal classification) and HEUR (Ryan\'s simple "top-2 cash place at ~2× win-prob" heuristic, shown for sanity).',
  placeEdge:
    '(actual / fair) − 1, expressed as a percent. POSITIVE = the projected payout is HIGHER than fair = +EV bet. Floor edge >0 fires SLAM DUNK; mid edge >5% fires LEAN. Both shown so you can see how much the worst-case vs. average scenario differ.',

  showActual:
    'Projected $2 SHOW payout you\'d collect right now if this horse finishes top-3. Three numbers because the payout depends on which two OTHER horses finish top-3 with it. FLOOR = paired with the two largest-pool other horses (worst case). MID = average across all pairs. CEILING = paired with the two smallest-pool horses (best case). The 2/3 factor in the formula is because show pool splits 3 ways.',
  showFair:
    'What the show payout SHOULD be at this horse\'s true top-3 probability. HARV = Harville. HEUR = ~3× win-prob capped at 99.9%, Ryan\'s heuristic.',
  showEdge:
    '(actual / fair) − 1 as a percent for show. Same signal logic as place — floor edge >0 = SLAM DUNK, mid edge >5% = LEAN.',

  winActual:
    'Projected $2 WIN payout if this horse finishes 1st. Single number — there is no companion finisher; the entire net pool goes to bettors who picked the winner. After 5% breakage and the $2.10 minimum.',
  winFair:
    'What the win payout SHOULD be at this horse\'s true win probability: 2 / pWin. The "fair" price ignoring takeout.',
  winEdge:
    '(actual / fair) − 1 for the win pool. Note: the win pool is the most efficient market — track takeout (~16%) is paid by all bettors, so this edge is structurally near -16% for almost every horse. Real +EV win bets are rare and usually only show up on heavy favorites where the $2.10 minimum exceeds fair price. Mostly informational.',

  // ── Header / status ─────────────────────────────────────────────────────
  probSource:
    'Where the math\'s win-probability estimates come from. WIN_POOL = derived from win-pool $ (preferred and most accurate). DECIMAL_ODDS = derived from live odds (used when pool data is briefly unavailable). UNIFORM_FALLBACK = 1/n flat fallback (degraded mode — math is unreliable).',
  postTime:
    'Scheduled post time in UTC. Pari-mutuel wagering closes when the gates open (status flips to RO).',
  mtp:
    'Minutes To Post — how long until the race goes off. Pool dynamics get most volatile in the last 60-90 seconds.',
  raceStatus:
    'OPEN = wagering is live. CLOSED = gates open / race running, no more bets. OFFICIAL = results posted, payouts finalized.',
  lastUpdate:
    'Timestamp of the most recent WebSocket frame from FanDuel for this race. Stale > ~30 seconds means the WS subscription may have dropped — refresh the page or hit /api/refresh.',

  // ── Legend headlines ────────────────────────────────────────────────────
  thesis:
    'Pari-mutuel pools are funded by everyone betting. The track keeps ~17%; the rest is split among winners. The WIN pool is large and efficient. PLACE and SHOW pools are smaller — and when somebody dumps a big bet on one horse, those pools get distorted. Mathematically, that distortion forces other horses\' projected payouts higher than they "should" be relative to their win-pool-implied probability of finishing in the money. THIS TOOL FINDS THOSE MOMENTS.',
} as const;

/** Quick-reference recommended action per signal — used in the legend panel. */
export const SIGNAL_ACTIONS: Record<string, { label: string; action: string; tone: 'green' | 'yellow' | 'red' | 'gray' }> = {
  slam_dunk: {
    label: 'Slam Dunk',
    action: 'Bet place or show. Strongest signal — even worst-case payout beats fair.',
    tone: 'green',
  },
  lean: {
    label: 'Lean',
    action: 'Consider a smaller bet. Average projection ≥5% above fair.',
    tone: 'yellow',
  },
  drift: {
    label: 'Drift',
    action: 'Check manually first. Live odds have drifted >50% from morning line.',
    tone: 'red',
  },
  none: {
    label: 'None',
    action: 'No actionable signal. Skip.',
    tone: 'gray',
  },
};
