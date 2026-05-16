/**
 * GraphQL queries used by the scraper. Captured verbatim from
 * `auth/network-capture-prepost.jsonl` on 2026-05-02. If FDR rotates the
 * schema, re-run `pnpm run login` and `pnpm run analyze-capture`, find the
 * relevant operations, and update these strings in place.
 *
 * See `auth/discovered-endpoints.md` for the full discovery context.
 */

export const FDR_GRAPHQL_HTTP_URL = 'https://api.racing.fanduel.com/cosmo/v1/graphql';
export const FDR_GRAPHQL_WS_URL = 'wss://api.racing.fanduel.com/cosmo/v1/graphql';

export interface GraphQLOperation {
  operationName: string;
  query: string;
}

/** Bootstrap query — returns the live race calendar with tvgRaceIds + mtp + status. */
export const GET_RACES_MTP_STATUS: GraphQLOperation = {
  operationName: 'getRacesMtpStatus',
  query: `query getRacesMtpStatus($wagerProfile: String, $sortBy: RaceListSort, $filterBy: RaceListFilter, $page: Pagination) {
  raceDate
  mtpRaces: races(filter: $filterBy, profile: $wagerProfile, sort: $sortBy) {
    number
    mtp
    trackCode
    trackName
    postTime
    track {
      perfAbbr
      __typename
    }
    status {
      code
      __typename
    }
    __typename
  }
  nextRace: races(page: $page, profile: $wagerProfile, sort: $sortBy) {
    number
    mtp
    trackCode
    trackName
    postTime
    track {
      perfAbbr
      __typename
    }
    status {
      code
      __typename
    }
    __typename
  }
}
`,
};

export const GET_RACES_MTP_STATUS_DEFAULT_VARIABLES = {
  wagerProfile: 'FDR-Generic',
  sortBy: { byPostTime: 'ASC' },
  filterBy: {
    startIn: 60,
    status: ['MO', 'O', 'SK', 'IC'],
  },
  page: { current: 0, results: 1 },
};

/**
 * Per-track race list — returns every race on a track's card today, including
 * finished races (with `results` populated) and crucially each race's
 * `tvgRaceId`, which `getRacesMtpStatus` does NOT include. Use this to feed
 * the WebSocket subscription's `tvgRaceIds` variable.
 */
export const GET_GRAPH_RACE: GraphQLOperation = {
  operationName: 'getGraphRace',
  query: `query getGraphRace($trackAbbr: String, $wagerProfile: String, $product: String, $device: String, $brand: String) {
  races: races(
    filter: {trackCode: [$trackAbbr]}
    profile: $wagerProfile
    sort: {byRaceNumber: ASC}
  ) {
    id
    tvgRaceId
    ...RaceDetails
    ...TimeAndStatus
    ...Track
    ...Video
    ...WagerTypes
    ...BettingInterests
    ...Probables
    ...RacePools
    ...Promos
    ...Results
    __typename
  }
}

fragment BettingInterests on Race {
  bettingInterests {
    biNumber
    favorite
    currentOdds { numerator denominator __typename }
    morningLineOdds { numerator denominator __typename }
    recentOdds(pages: [{current: 0, results: 4}]) { trending odd __typename }
    biPools {
      wagerType { id code name __typename }
      poolRunnersData { amount __typename }
      __typename
    }
    runners {
      runnerId
      scratched
      jockey
      trainer
      horseName
      hasJockeyChanges
      __typename
    }
    __typename
  }
  __typename
}

fragment Probables on Race {
  probables {
    amount
    minWagerAmount
    wagerType { id code name __typename }
    betCombos { runner1 runner2 payout __typename }
    __typename
  }
  __typename
}

fragment RacePools on Race {
  racePools {
    wagerType { id code name __typename }
    amount
    __typename
  }
  __typename
}

fragment WagerTypes on Race {
  wagerTypes {
    positionCount
    minWagerAmount
    wagerAmounts
    columnCount
    legCount
    isBox
    isKey
    isWheel
    unitedWagerTypeCode
    allowAlternateSelection
    type { id name code __typename }
    group { id name code __typename }
    __typename
  }
  __typename
}

fragment TimeAndStatus on Race {
  mtp
  postTime
  status { code __typename }
  raceDate
  __typename
}

fragment RaceDetails on Race {
  raceNumber: number
  description
  specialCardSourceRace {
    raceDate
    trackCode
    trackName
    raceNumber
    poolCloseTime
    __typename
  }
  distance
  purse
  isGreyhound
  highlighted(product: $product, device: $device, brand: $brand) {
    description
    style
    __typename
  }
  numRunners
  numWagerableRunners
  claimingPrice
  surface { name shortName defaultCondition __typename }
  type { name code shortName __typename }
  raceClass { name shortName __typename }
  talentPicks { id __typename }
  timeform { analystVerdict __typename }
  ...Changes
  __typename
}

fragment Changes on Race {
  changes: changes {
    surface {
      course { oldValue newValue date __typename }
      distance {
        date
        oldValue { value code name shortName __typename }
        newValue { value code name shortName __typename }
        __typename
      }
      tempRailDistance { oldValue newValue date __typename }
      condition { oldValue newValue date __typename }
      __typename
    }
    horse {
      scratched { runnerId horseName date scratched reason __typename }
      jockey { runnerId horseName date oldValue newValue __typename }
      __typename
    }
    __typename
  }
  __typename
}

fragment Video on Race {
  video {
    liveStreaming
    onTvg
    onTvg2
    streams
    hasReplay
    replayFileName
    mobileAvailable
    isStreamHighDefinition
    __typename
  }
  __typename
}

fragment Track on Race {
  track {
    id
    trackName: name
    trackCode: code
    perfAbbr
    shortName
    featured
    numberOfRaces
    specialCardTypes: specialCardTypes {
      specialCardTypeAbbreviation
      specialCardTypeName
      __typename
    }
    trackLocation: location { country __typename }
    trackDataSource
    __typename
  }
  __typename
}

fragment Promos on Race {
  promos(product: $product, brand: $brand) {
    rootParentPromoID
    isAboveTheLine
    promoPath
    isPromoTagShown
    __typename
  }
  __typename
}

fragment Results on Race {
  results {
    runners {
      betAmount
      biNumber
      finishPosition
      placePayoff
      runnerName
      showPayoff
      winPayoff
      runnerNumber
      __typename
    }
    payoffs {
      selections { payoutAmount selection __typename }
      wagerAmount
      wagerType { code name __typename }
      __typename
    }
    winningTime
    __typename
  }
  __typename
}
`,
};

export const GET_GRAPH_RACE_DEFAULT_PINS = {
  wagerProfile: 'FDR-PA',
  brand: 'FDR',
  product: 'TVG5',
  device: 'Desktop',
} as const;

/** getGraphRace response (subset of fields the bootstrap consumes). */
export interface GetGraphRaceResponse {
  races: Array<{
    id: string;
    tvgRaceId: number;
    raceNumber: string;
    postTime: string;
    mtp: number;
    status: { code: string };
    track?: { trackCode?: string };
  }>;
}

/**
 * WebSocket subscription — pushes full Race objects (bettingInterests, biPools,
 * racePools, results) on every update. Variables: `tvgRaceIds: number[]` (the
 * tvgRaceId from getRacesMtpStatus).
 */
export const RACE_UPDATE_BY_TVG_RACE_IDS: GraphQLOperation = {
  operationName: 'raceUpdateByTvgRaceIds',
  query: `subscription raceUpdateByTvgRaceIds($wagerProfile: String!, $product: String, $device: String, $brand: String, $tvgRaceIds: [Long!]) {
  raceUpdateByTvgRaceIds(profile: $wagerProfile, tvgRaceIds: $tvgRaceIds) {
    id
    tvgRaceId
    ...RaceDetails
    ...TimeAndStatus
    ...Video
    ...WagerTypes
    ...BettingInterests
    ...Probables
    ...RacePools
    ...Results
    ...Promos
    __typename
  }
}

fragment WagerTypes on Race {
  wagerTypes {
    positionCount
    minWagerAmount
    wagerAmounts
    columnCount
    legCount
    isBox
    isKey
    isWheel
    unitedWagerTypeCode
    allowAlternateSelection
    type { id name code __typename }
    group { id name code __typename }
    __typename
  }
  __typename
}

fragment TimeAndStatus on Race {
  mtp
  postTime
  status { code __typename }
  raceDate
  __typename
}

fragment RaceDetails on Race {
  raceNumber: number
  description
  specialCardSourceRace {
    raceDate
    trackCode
    trackName
    raceNumber
    poolCloseTime
    __typename
  }
  distance
  purse
  isGreyhound
  highlighted(product: $product, device: $device, brand: $brand) {
    description
    style
    __typename
  }
  numRunners
  numWagerableRunners
  claimingPrice
  surface { name shortName defaultCondition __typename }
  type { name code shortName __typename }
  raceClass { name shortName __typename }
  talentPicks { id __typename }
  timeform { analystVerdict __typename }
  ...Changes
  __typename
}

fragment Changes on Race {
  changes: changes {
    surface {
      course { oldValue newValue date __typename }
      distance {
        date
        oldValue { value code name shortName __typename }
        newValue { value code name shortName __typename }
        __typename
      }
      tempRailDistance { oldValue newValue date __typename }
      condition { oldValue newValue date __typename }
      __typename
    }
    horse {
      scratched { runnerId horseName date scratched reason __typename }
      jockey { runnerId horseName date oldValue newValue __typename }
      __typename
    }
    __typename
  }
  __typename
}

fragment Video on Race {
  video {
    liveStreaming
    onTvg
    onTvg2
    streams
    hasReplay
    replayFileName
    mobileAvailable
    isStreamHighDefinition
    __typename
  }
  __typename
}

fragment BettingInterests on Race {
  bettingInterests {
    biNumber
    favorite
    currentOdds { numerator denominator __typename }
    morningLineOdds { numerator denominator __typename }
    recentOdds(pages: [{current: 0, results: 4}]) { trending odd __typename }
    biPools {
      wagerType { id code name __typename }
      poolRunnersData { amount __typename }
      __typename
    }
    runners {
      runnerId
      scratched
      jockey
      trainer
      horseName
      hasJockeyChanges
      __typename
    }
    __typename
  }
  __typename
}

fragment Probables on Race {
  probables {
    amount
    minWagerAmount
    wagerType { id code name __typename }
    betCombos { runner1 runner2 payout __typename }
    __typename
  }
  __typename
}

fragment RacePools on Race {
  racePools {
    wagerType { id code name __typename }
    amount
    __typename
  }
  __typename
}

fragment Results on Race {
  results {
    runners {
      betAmount
      biNumber
      finishPosition
      placePayoff
      runnerName
      showPayoff
      winPayoff
      runnerNumber
      __typename
    }
    payoffs {
      selections { payoutAmount selection __typename }
      wagerAmount
      wagerType { code name __typename }
      __typename
    }
    winningTime
    __typename
  }
  __typename
}

fragment Promos on Race {
  promos(product: $product, brand: $brand) {
    rootParentPromoID
    isAboveTheLine
    promoPath
    isPromoTagShown
    __typename
  }
  __typename
}
`,
};

export interface RaceUpdateSubscriptionVariables {
  wagerProfile: string;
  product: string;
  device: string;
  brand: string;
  tvgRaceIds: number[];
}

export const RACE_UPDATE_DEFAULT_PINS = {
  wagerProfile: 'FDR-PA',
  brand: 'FDR',
  product: 'TVG5',
  device: 'Desktop',
} as const;
