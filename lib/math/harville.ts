export function harvillePlaceProbs(probs: number[]): number[] {
  const n = probs.length;
  const result = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const pi = probs[i];
    if (!Number.isFinite(pi) || pi < 0) continue;
    let p2nd = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const pj = probs[j];
      if (!Number.isFinite(pj) || pj < 0) continue;
      const denom = 1 - pj;
      if (denom <= 0) continue;
      p2nd += (pj * pi) / denom;
    }
    result[i] = pi + p2nd;
  }
  return result;
}

export function harvilleShowProbs(probs: number[]): number[] {
  const n = probs.length;
  const place = harvillePlaceProbs(probs);
  const result = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const pi = probs[i];
    if (!Number.isFinite(pi) || pi < 0) {
      result[i] = place[i];
      continue;
    }
    let p3rd = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const pj = probs[j];
      if (!Number.isFinite(pj) || pj < 0) continue;
      const denomJ = 1 - pj;
      if (denomJ <= 0) continue;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const pk = probs[k];
        if (!Number.isFinite(pk) || pk < 0) continue;
        const denomJK = 1 - pj - pk;
        if (denomJK <= 0) continue;
        p3rd += pj * (pk / denomJ) * (pi / denomJK);
      }
    }
    result[i] = place[i] + p3rd;
  }
  return result;
}
