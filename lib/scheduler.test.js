import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { generateDraft, eligiblePlayers, selectPlaying, breakCount, matchTypeLabel, reverseMatchHistory } from "./scheduler.js";

// Deterministic PRNG so the simulated event below doesn't flake in CI --
// scheduler.js's shuffle() calls Math.random() directly.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let originalRandom;
beforeAll(() => {
  originalRandom = Math.random;
  Math.random = mulberry32(42);
});
afterAll(() => {
  Math.random = originalRandom;
});

function makePlayer(id, gender, attendance_status = "checked_in") {
  return {
    id,
    gender,
    attendance_status,
    display_name: id,
    games_played: 0,
    last_played_sequence: null,
    partner_ids: [],
    opponent_counts: {},
  };
}

// Mirrors the history-mutation half of lib/db.js's publish step, plus an
// immediate games_played increment -- standing in for "the match got scored"
// so priorityScore()/breakCount() have real numbers to balance against on the
// next generation, same as a real event where you score before drafting more.
function applyPublish(byId, matches) {
  matches.forEach((m) => {
    const [a1, a2] = m.team_a;
    const [b1, b2] = m.team_b;
    byId[a1].partner_ids.push(a2);
    byId[a2].partner_ids.push(a1);
    byId[b1].partner_ids.push(b2);
    byId[b2].partner_ids.push(b1);
    [a1, a2, b1, b2].forEach((id) => {
      byId[id].last_played_sequence = m.sequence;
      byId[id].games_played += 1;
    });
    m.team_a.forEach((a) =>
      m.team_b.forEach((b) => {
        byId[a].opponent_counts[b] = (byId[a].opponent_counts[b] || 0) + 1;
        byId[b].opponent_counts[a] = (byId[b].opponent_counts[a] || 0) + 1;
      })
    );
  });
}

// Reproduces the real test event from the handoff doc: 30 players (6 women /
// 24 men), 3 courts, generated one match at a time (the new per-match model)
// for long enough to stress the partner pool and pacing rules -- 16
// round-equivalents' worth of matches (48 matches at 3 courts).
function runEvent({ women = 6, men = 24, courts = 3, roundEquivalents = 16 } = {}) {
  const players = [
    ...Array.from({ length: women }, (_, i) => makePlayer(`w${i + 1}`, "female")),
    ...Array.from({ length: men }, (_, i) => makePlayer(`m${i + 1}`, "male")),
  ];
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));

  const allMatches = [];
  const warningsByMatch = [];
  const errors = [];
  const totalMatches = courts * roundEquivalents;

  for (let i = 0; i < totalMatches; i++) {
    const draft = generateDraft(players, allMatches, 1, courts);

    if (draft.error) {
      errors.push({ i, error: draft.error });
      continue;
    }

    warningsByMatch.push({ sequence: draft.matches[0].sequence, warnings: draft.warnings });
    applyPublish(byId, draft.matches);
    // Simulate scoring immediately, same as a real event where a match is
    // scored before the next one is drafted -- otherwise it would stay
    // status: "scheduled" forever and busyIds (real-time eligibility) would
    // exclude everyone who's ever played, not just those still mid-match.
    allMatches.push(...draft.matches.map((m) => ({ ...m, status: "completed" })));
  }

  return { players, byId, allMatches, warningsByMatch, errors, courts };
}

describe("scheduler regression audit (30 players, 6 women / 24 men, 3 courts, 16 round-equivalents, per-match generation)", () => {
  let sim;
  // Must run inside beforeAll, not directly in the describe body: describe bodies run
  // during Vitest's collection phase, before the outer beforeAll above (which seeds
  // Math.random) has fired -- calling runEvent() here would silently use real,
  // unseeded randomness and make every assertion below flaky.
  beforeAll(() => { sim = runEvent(); });

  test("every match generates without error", () => {
    expect(sim.errors).toEqual([]);
    expect(sim.allMatches.length).toBe(48);
  });

  test("every match's division is a known category and matchTypeLabel never throws", () => {
    sim.allMatches.forEach((m) => {
      expect(["women", "men", "mixed", "edge"]).toContain(m.division);
      expect(() => matchTypeLabel(m, sim.byId)).not.toThrow();
    });
  });

  test("never repeats a partnership, unless the partner pool is exhausted and a warning was logged for that match", () => {
    const exhaustedSequences = new Set();
    sim.warningsByMatch.forEach(({ sequence, warnings }) => {
      if (warnings.some((w) => w.includes("Partner pool is exhausted"))) exhaustedSequences.add(sequence);
    });

    const seenPairs = new Set();
    sim.allMatches.forEach((m) => {
      [m.team_a, m.team_b].forEach(([p1, p2]) => {
        const key = [p1, p2].sort().join("|");
        if (seenPairs.has(key)) {
          expect(exhaustedSequences.has(m.sequence), `repeat partnership ${key} at sequence ${m.sequence} with no exhaustion warning`).toBe(true);
        }
        seenPairs.add(key);
      });
    });
  });

  test("no player ever reaches a break of 3+ round-equivalents without playing (the exact real-world failure this redesign targets)", () => {
    // Walk the simulation forward, recomputing each player's break just before
    // each match is generated, using the same nextSequence/courts math the
    // real algorithm used at that moment.
    const byId = Object.fromEntries(sim.players.map((p) => [p.id, { ...p, last_played_sequence: null, games_played: 0 }]));
    let worstBreak = 0;
    sim.allMatches.forEach((m) => {
      const nextSequence = m.sequence;
      Object.values(byId).forEach((p) => {
        worstBreak = Math.max(worstBreak, breakCount(p, nextSequence, sim.courts));
      });
      [...m.team_a, ...m.team_b].forEach((id) => {
        byId[id].last_played_sequence = m.sequence;
        byId[id].games_played += 1;
      });
    });
    expect(worstBreak).toBeLessThanOrEqual(2);
  });

  test("repeat opponents stay a minority of matchups (soft constraint; calibrated against this simulation, which now also has to route around the composition-tier penalty)", () => {
    let totalOpponentPairs = 0;
    const metPairs = new Map();
    sim.allMatches.forEach((m) => {
      m.team_a.forEach((a) => m.team_b.forEach((b) => {
        totalOpponentPairs++;
        const key = [a, b].sort().join("|");
        metPairs.set(key, (metPairs.get(key) || 0) + 1);
      }));
    });
    const repeatedPairs = [...metPairs.values()].filter((c) => c > 1).length;
    expect(repeatedPairs / totalOpponentPairs).toBeLessThan(0.2);
  });

  test("games played stay tightly balanced across all players", () => {
    const counts = sim.players.map((p) => p.games_played);
    const spread = Math.max(...counts) - Math.min(...counts);
    expect(spread).toBeLessThanOrEqual(2);
  });

  test("women's and men's average games played track each other -- gender-blind matchmaking doesn't starve the smaller gender", () => {
    const avg = (arr) => (arr.length ? arr.reduce((s, p) => s + p.games_played, 0) / arr.length : 0);
    const avgWomen = avg(sim.players.filter((p) => p.gender === "female"));
    const avgMen = avg(sim.players.filter((p) => p.gender === "male"));
    expect(Math.abs(avgWomen - avgMen)).toBeLessThan(1.0);
  });

  test("heavy same-gender-pair-vs-same-gender-pair compositions are rare relative to total matches (tier 2 is genuinely discouraged)", () => {
    const heavy = sim.allMatches.filter((m) => {
      const teamASame = sim.byId[m.team_a[0]].gender === sim.byId[m.team_a[1]].gender;
      const teamBSame = sim.byId[m.team_b[0]].gender === sim.byId[m.team_b[1]].gender;
      return m.division === "edge" && teamASame && teamBSame;
    });
    expect(heavy.length / sim.allMatches.length).toBeLessThan(0.2);
  });
});

describe("generateDraft never mutates its inputs", () => {
  test("draft-only generation can't leak into history", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "female"), makePlayer("d", "female")];
    const snapshot = JSON.parse(JSON.stringify(players));
    generateDraft(players, [], 1, 1);
    expect(players).toEqual(snapshot);
  });
});

describe("real-time eligibility", () => {
  test("a player currently in an unscored (status: scheduled) match is excluded from a new draft, even mid-event", () => {
    const players = [
      makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "male"), makePlayer("d", "male"),
      makePlayer("e", "female"), makePlayer("f", "male"), makePlayer("g", "female"), makePlayer("h", "male"),
    ];
    const inProgress = { id: "m1", sequence: 1, status: "scheduled", team_a: ["a", "b"], team_b: ["c", "d"] };
    const draft = generateDraft(players, [inProgress], 1, 2);
    const appeared = new Set(draft.matches.flatMap((m) => [...m.team_a, ...m.team_b]));
    expect(appeared.has("a")).toBe(false);
    expect(appeared.has("b")).toBe(false);
    expect(appeared.has("c")).toBe(false);
    expect(appeared.has("d")).toBe(false);
  });

  test("a player whose match already finished (completed/cancelled) is eligible again, subject to the back-to-back gap", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "male"), makePlayer("d", "male")];
    const finished = { id: "m1", sequence: 1, status: "completed", team_a: ["a", "b"], team_b: ["c", "d"] };
    // courts=1 means the very next match (sequence 2) is still the "next round-equivalent" --
    // back-to-back, so excluded, but relaxed since it's the only 4 checked-in players.
    const { pool, warnings } = eligiblePlayers(players.map((p) => ({ ...p, last_played_sequence: 1 })), [finished], 2, 1);
    expect(pool.length).toBe(4);
    expect(warnings.length).toBe(1);
  });

  test("only checked_in players ever appear in a generated draft", () => {
    const statuses = ["not_arrived", "late", "checked_in", "temporarily_unavailable", "no_show", "withdrawn"];
    const pool = statuses.map((s) => makePlayer(`status_${s}`, "female", s));
    for (let i = 0; i < 7; i++) pool.push(makePlayer(`extra${i}`, "female", "checked_in"));

    const draft = generateDraft(pool, [], 2, 2);
    const appeared = new Set([...draft.matches.flatMap((m) => [...m.team_a, ...m.team_b]), ...draft.sitting]);

    statuses.filter((s) => s !== "checked_in").forEach((s) => {
      expect(appeared.has(`status_${s}`), `${s} player should never appear in a draft`).toBe(false);
    });
  });
});

describe("breakCount", () => {
  test("is 0 for a player who has never played, no matter how late in the event", () => {
    const p = makePlayer("a", "female");
    expect(breakCount(p, 500, 4)).toBe(0);
  });

  test("is 0 for a player selected into the very next round-equivalent after their last match", () => {
    const p = { ...makePlayer("a", "female"), last_played_sequence: 1 }; // round 1 of 4 courts
    expect(breakCount(p, 5, 4)).toBe(0); // sequence 5 = round 2, immediately next
  });

  test("grows by 1 per full round-equivalent skipped", () => {
    const p = { ...makePlayer("a", "female"), last_played_sequence: 1 }; // round 1 of 4 courts
    expect(breakCount(p, 9, 4)).toBe(1); // sequence 9 = round 3 -- skipped round 2 entirely
    expect(breakCount(p, 13, 4)).toBe(2); // sequence 13 = round 4 -- skipped rounds 2 and 3
  });
});

describe("selectPlaying (must-play protected tier)", () => {
  test("a player with break >= 2 is guaranteed a slot ahead of a zero-games player who'd otherwise win on priority alone", () => {
    const courts = 4;
    const nextSequence = 13; // round 4 (ceil(13/4))
    const overdue = { ...makePlayer("overdue", "female"), games_played: 3, last_played_sequence: 1 }; // round 1 -> break = 2
    const freshArrivals = ["f1", "f2", "f3"].map((id) => makePlayer(id, "male")); // 0 games, huge zero-games bonus
    const filler = ["x1", "x2", "x3", "x4"].map((id) => makePlayer(id, "male"));
    filler.forEach((p) => { p.games_played = 2; p.last_played_sequence = 9; }); // round 3 -> break = 0, normal priority

    const pool = [overdue, ...freshArrivals, ...filler];
    const { playing, mustPlayCount } = selectPlaying(pool, 1, courts, nextSequence);
    expect(mustPlayCount).toBe(1);
    expect(playing.map((p) => p.id)).toContain("overdue");
  });

  test("must-play players are seated even when there are more of them than slots, and the shortfall is reported by generateDraft", () => {
    const courts = 1;
    const overdue = ["o1", "o2", "o3", "o4", "o5", "o6"].map((id) => makePlayer(id, "male"));
    overdue.forEach((p) => { p.last_played_sequence = 1; p.games_played = 1; }); // break = 2 once nextSequence reaches round 4 (sequence 13+)
    const seed = { id: "seed", sequence: 12, status: "completed", team_a: [], team_b: [] }; // pushes nextSequence to 13
    const draft = generateDraft(overdue, [seed], 1, courts);
    // Only 6 players total -> exactly 1 match's worth selected; the other 2 are must-play but unseated.
    expect(draft.matches.length).toBe(1);
    expect(draft.warnings.some((w) => w.includes("break of 2+"))).toBe(true);
  });
});

describe("composition tiers", () => {
  const byId = (list) => Object.fromEntries(list.map((p) => [p.id, p]));

  test("classify()/matchTypeLabel report a same-gender pair vs opposite same-gender pair as 'edge' / 'Women's Pair vs Men's Pair'", () => {
    const players = [makePlayer("w1", "female"), makePlayer("w2", "female"), makePlayer("m1", "male"), makePlayer("m2", "male")];
    const match = { team_a: ["w1", "w2"], team_b: ["m1", "m2"] };
    expect(matchTypeLabel(match, byId(players))).toBe("Women's Pair vs Men's Pair");
  });

  test("given a free choice between a clean mixed-vs-mixed split and a pair-vs-pair split with identical partner/opponent history, the algorithm prefers mixed-vs-mixed", () => {
    const players = [makePlayer("w1", "female"), makePlayer("w2", "female"), makePlayer("m1", "male"), makePlayer("m2", "male")];
    const draft = generateDraft(players, [], 1, 1);
    expect(draft.matches.length).toBe(1);
    expect(draft.matches[0].division).toBe("mixed");
  });
});

describe("reverseMatchHistory", () => {
  test("removes exactly one partnership occurrence, not all of them", () => {
    const a = makePlayer("a", "female");
    a.partner_ids = ["b", "b"]; // partnered with b twice, in two different matches
    const b = makePlayer("b", "female");
    b.partner_ids = ["a", "a"];
    const c = makePlayer("c", "male");
    c.partner_ids = ["d"];
    const d = makePlayer("d", "male");
    d.partner_ids = ["c"];
    const match = { id: "m1", sequence: 2, team_a: ["a", "b"], team_b: ["c", "d"] };

    const reversed = reverseMatchHistory(match, [a, b, c, d], []);
    const byId = Object.fromEntries(reversed.map((p) => [p.id, p]));
    expect(byId.a.partner_ids).toEqual(["b"]); // one occurrence removed, one remains
    expect(byId.b.partner_ids).toEqual(["a"]);
  });

  test("decrements opponent_counts by 1 and drops the key entirely once it hits 0", () => {
    const a = makePlayer("a", "female");
    a.opponent_counts = { c: 2, d: 1 };
    const b = makePlayer("b", "female");
    b.opponent_counts = { c: 1, d: 1 };
    const c = makePlayer("c", "male");
    c.opponent_counts = { a: 2, b: 1 };
    const d = makePlayer("d", "male");
    d.opponent_counts = { a: 1, b: 1 };
    const match = { id: "m1", sequence: 2, team_a: ["a", "b"], team_b: ["c", "d"] };

    const reversed = reverseMatchHistory(match, [a, b, c, d], []);
    const byId = Object.fromEntries(reversed.map((p) => [p.id, p]));
    expect(byId.a.opponent_counts).toEqual({ c: 1 }); // c:2->1 stays, d:1->0 dropped
    expect(byId.b.opponent_counts).toEqual({}); // both were at 1, both dropped
  });

  test("recomputes last_played_sequence as the highest sequence among the player's other non-cancelled matches", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "male"), makePlayer("d", "male")];
    players.forEach((p) => { p.last_played_sequence = 5; });
    const earlierMatch = { id: "m3", sequence: 3, status: "completed", team_a: ["a", "c"], team_b: ["b", "d"] };
    const cancelledMatch = { id: "m5", sequence: 5, status: "scheduled", team_a: ["a", "b"], team_b: ["c", "d"] };
    const allMatches = [earlierMatch, cancelledMatch];

    const reversed = reverseMatchHistory(cancelledMatch, players, allMatches);
    const byId = Object.fromEntries(reversed.map((p) => [p.id, p]));
    expect(byId.a.last_played_sequence).toBe(3); // played sequence 3 too, so falls back to that
    expect(byId.b.last_played_sequence).toBe(3);
  });

  test("last_played_sequence becomes null when the reversed match was the player's only one", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "male"), makePlayer("d", "male")];
    players.forEach((p) => { p.last_played_sequence = 1; });
    const match = { id: "m1", sequence: 1, team_a: ["a", "b"], team_b: ["c", "d"] };

    const reversed = reverseMatchHistory(match, players, [match]);
    reversed.forEach((p) => expect(p.last_played_sequence).toBeNull());
  });

  test("ignores other cancelled matches when recomputing last_played_sequence", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "male"), makePlayer("d", "male")];
    const otherCancelled = { id: "m1", sequence: 1, status: "cancelled", team_a: ["a", "c"], team_b: ["b", "d"] };
    const match = { id: "m2", sequence: 2, team_a: ["a", "b"], team_b: ["c", "d"] };

    const reversed = reverseMatchHistory(match, players, [otherCancelled, match]);
    reversed.forEach((p) => expect(p.last_played_sequence).toBeNull());
  });
});
