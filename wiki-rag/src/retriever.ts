export type RetrievalMode = "lexical" | "hybrid" | "graph";

export type Ranked = {
  id: string;
  rank: number;
};

export type Scored = {
  id: string;
  score: number;
};

export type DoctorReport = {
  mode: RetrievalMode;
  lexical: "ready";
  vector: "ready" | "disabled";
  graph: "ready" | "disabled";
  fallback: string | null;
};

type BuildRetrievalModeOpts = {
  vectorEnabled: boolean;
  graphEnabled: boolean;
};

const RRF_K = 60;

export function buildRetrievalMode(opts: BuildRetrievalModeOpts): RetrievalMode {
  if (!opts.vectorEnabled) return "lexical";
  if (opts.graphEnabled) return "graph";
  return "hybrid";
}

export function doctorRetrieval(opts: BuildRetrievalModeOpts): DoctorReport {
  const mode = buildRetrievalMode(opts);
  const graphReady = opts.vectorEnabled && opts.graphEnabled;

  return {
    mode,
    lexical: "ready",
    vector: opts.vectorEnabled ? "ready" : "disabled",
    graph: graphReady ? "ready" : "disabled",
    fallback: opts.vectorEnabled ? null : "vector disabled; using lexical mode",
  };
}

export function combineScores(lexical: Ranked[], semantic: Ranked[], graph: Ranked[]): Scored[] {
  const scores = new Map<string, number>();

  const add = (rows: Ranked[], weight: number) => {
    for (const row of rows) {
      const contribution = weight / (RRF_K + row.rank);
      scores.set(row.id, (scores.get(row.id) ?? 0) + contribution);
    }
  };

  add(lexical, 0.5);
  add(semantic, 0.4);
  add(graph, 0.1);

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}
