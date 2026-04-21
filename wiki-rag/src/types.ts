export type DocRow = {
  docId: string;
  path: string;
  title: string | null;
  mtimeMs: number;
  contentHash: string;
};

export type ChunkRow = {
  chunkId: string;
  docId: string;
  headingPath: string | null;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
};
