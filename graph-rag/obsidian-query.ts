import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import path from "path";

/**
 * Lightweight Obsidian Graph Query Engine
 * Uses SQLite to track [[WikiLink]] relationships.
 */
export class ObsidianGraph {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.setup();
  }

  private setup() {
    this.db.run(`CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, content TEXT, tags TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS edges (source TEXT, target TEXT, PRIMARY KEY(source, target))`);
  }

  /**
   * Scans a directory for markdown files and extracts links
   */
  async ingest(dirPath: string) {
    const files = readdirSync(dirPath).filter(f => f.endsWith('.md'));
    const linkRegex = /\[\[(.*?)\]\]/g;

    for (const file of files) {
      const content = readFileSync(path.join(dirPath, file), 'utf8');
      const nodeId = file.replace('.md', '');
      
      this.db.run("INSERT OR REPLACE INTO nodes (id, content) VALUES (?, ?)", [nodeId, content]);

      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        const target = match[1].split('|')[0].trim(); // Handle [[Link|Alias]]
        this.db.run("INSERT OR IGNORE INTO edges (source, target) VALUES (?, ?)", [nodeId, target]);
      }
    }
  }

  /**
   * Retrieves a note and its immediate neighbors to build a rich context
   */
  getContext(noteId: string): string {
    const note = this.db.query("SELECT content FROM nodes WHERE id = ?").get(noteId) as { content: string };
    if (!note) return "";

    // Find outgoing and incoming links (the "Neighborhood")
    const neighbors = this.db.query(`
      SELECT id, content FROM nodes 
      WHERE id IN (SELECT target FROM edges WHERE source = ?)
      OR id IN (SELECT source FROM edges WHERE target = ?)
    `).all(noteId, noteId) as { id: string, content: string }[];

    let context = `PRIMARY NOTE: ${noteId}\n${note.content}\n\n`;
    context += `RELATED CONTEXT FROM LINKS:\n`;
    
    for (const neighbor of neighbors) {
      // Summarize neighbors briefly to save tokens
      context += `--- Related: ${neighbor.id} ---\n${neighbor.content.substring(0, 500)}...\n`;
    }

    return context;
  }

  /**
   * Simple keyword search that returns a graph-expanded context
   */
  query(keyword: string): string {
    const match = this.db.query("SELECT id FROM nodes WHERE content LIKE ? LIMIT 1")
      .get(`%${keyword}%`) as { id: string };
    
    if (!match) return "No matches found.";
    return this.getContext(match.id);
  }
}

// Example Usage:
// const graph = new ObsidianGraph();
// await graph.ingest("./verticals/laws-consultant/wiki");
// const promptContext = graph.query("Cybersecurity");
// console.log(promptContext);
