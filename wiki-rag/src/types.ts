export type DocRow = {
  doc_id: string;
  path: string;
  title: string | null;
  mtime_ms: number;
  content_hash: string;
};

export type ChunkRow = {
  chunk_id: string;
  doc_id: string;
  heading_path: string | null;
  ordinal: number;
  text: string;
  start_offset: number;
  end_offset: number;
};
