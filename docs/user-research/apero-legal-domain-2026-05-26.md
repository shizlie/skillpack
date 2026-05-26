# Real-World AI Skill Usage Patterns — Vietnamese Legal Domain Contributor

**Contribution to**: [github.com/shizlie/skillpack](https://github.com/shizlie/skillpack)
**Contributor**: Vietnamese venture studio COO, legal-services domain (50-person Apero group, anonymized)
**Methodology**: Self-introspection across 4 Claude sessions via reusable prompt
**Date**: 2026-05-26
**License**: Apache License 2.0 (per `CONTRIBUTING.md` of skillpack repo) — submitted intentionally under Apache-2.0

---

## TL;DR

- **51 As-Is user stories** collected across 4 Claude Code sessions (5–30 messages each, spanning 6 days)
- **15 aggregated patterns** with cross-validation (high-confidence patterns appear in ≥2 streams)
- **Real legal domain context** — matches Skillpack's `laws-consultant` demo vertical
- **Multi-context AI usage**: architecture design, audit, training material authoring, defense prep, personal life ops (medical/legal/trip planning), 3rd-party AI coordination
- **Evidence-based**: every story cites tools used, artifacts produced, conversation pattern

---

## 1. Why this contribution matters for Skillpack

Skillpack ships **AI skills as MCPB bundles** with lease-based licensing — and the v1 demo vertical is `laws-consultant`. This contribution is from a **real legal-domain user** running:
- An internal legal services platform serving 5 venture business units
- A legal workflow web system for 5-person legal team
- A multi-month LLM Wiki project for legal curriculum (50 pages over 6 months)
- Personal use in legal/medical/admin life ops

This user is exactly the persona Skillpack's `laws-consultant` would target — but the user has not yet adopted Skillpack. The 15 patterns below describe **what AI skill features this user already relies on** across 4 different Claude environments.

---

## 2. Methodology

### Self-introspection prompt

A reusable prompt (~600 words) was designed to ask each Claude session to introspect its own conversation history and emit user stories in a strict template:
- Connextra As-Is format ("I am currently ..." present tense — NOT "I want")
- Behavioral evidence with specific moment citation (date / file / topic)
- Artifacts produced (concrete paths)
- Conversation pattern observed
- Token/effort estimate + tools used

The 9 explicit constraints filtered out To-Be suggestions, judgement words, generic statements, and fabrication.

### Sessions covered

| # | Stream | Topic | Duration | Messages | Stories |
|---|---|---|---|---|---|
| 1 | Multi-personal | Health/medical + remote work + legal docs + vision + Hermes + exam prep + trip planning + git repo | 6 days (May 21–26) | ~120+ | 15 |
| 2 | COO-Knowledge clarify + skillpack audit v1 | Quick scope check + initial skillpack As-Is | 1 hour | 7 | 10 |
| 3 | UAT bug fixes + skillpack audit v2 + Hermes verify | Production deploy 3 bugs + 3rd-party AI verification + skillpack audit | 4 hours | ~30 | 12 |
| 4 | PO Onboarding Kit build | Module 5 (Discovery) + Module 6 (Metric/OKR) batch generation + Skillpack contribution prep | 2 hours | ~30 | 14 |

**Total**: 51 raw stories → 15 aggregated patterns after dedupe.

---

## 3. The 15 Patterns

Patterns are ranked by **cross-stream frequency** (high-confidence = appears in 2+ streams).

### Pattern A — Multi-audience document generation (4 streams ✓✓✓✓)

**The behavior**: User asks AI to produce the same content in 3 versions for 3 different audiences.

**Examples**:
- 5 medical PDF results → (1) self-analysis with warnings (2) HTML report for personal physician (3) PDF for 70-year-old mother in plain language
- Legal training material → (1) `.md` for NotebookLM ingestion (2) styled HTML for executive reading (3) lecture-style for team training
- Trip planning → 1 self-contained PDF with weather data, budget breakdown, cultural rituals, 4 prayers

**Why it matters for Skillpack**: A `laws-consultant` skill should be able to render the same legal advice in (a) full legalese for the lawyer (b) plain language for the client (c) checklist for paralegal action.

---

### Pattern B — Real-time CLI debugging companion (2 streams ✓✓)

**The behavior**: User pastes terminal stderr verbatim to AI; AI diagnoses root cause and emits next command.

**Examples**:
- macOS install loop: `zsh: command not found: tmux` (PATH missing) → `sudo: a terminal is required` (cask install fail) → `ln: /usr/local/bin/code: No such file or directory` (Apple Silicon path issue) → `fatal: could not read Password... Device not configured` (no TTY for git push)
- PDF page extraction iteration: 3 cycles to fix heuristic ("LEARNING OUTCOMES" false positive due to page-header repetition; PDF text artifact `D i\ns correct` newline injection between letters)

**Why it matters**: An AI skill for engineers/devs/sysadmins must handle the **paste-output-loop** as a first-class interaction mode, not just Q&A.

---

### Pattern C — Source verification + fabrication catch (3 streams ✓✓✓)

**The behavior**: User domain-expert reviews AI output, catches fabricated citations, demands primary-source verification.

**Examples**:
- Legal document with 6 legal citations: user catches 2 fabrications (wrong article reference, wrong inheritance clause application) → AI must fetch primary source (`thuvienphapluat.vn`) and re-generate
- Training PDF assessment: AI assesses 2 PDFs out of 3, concludes "missing ERD coverage" → user provides 3rd PDF → AI must publicly admit 3 wrong assessments and correct
- 3rd-party AI hallucination catch: external bot reports "45 SR team total" → AI curls API directly, finds actual = 228, builds comparison table proving 3rd-party hallucinated

**Why it matters**: For `laws-consultant` skill specifically, **fabricated legal citations are a deal-breaker**. The skill must (a) cite primary source URL by default (b) fetch verbatim when challenged (c) explicitly acknowledge when uncertain — not paraphrase confidently.

---

### Pattern D — Multimodal ingestion (PDF + PNG + audio) (3 streams ✓✓✓)

**The behavior**: User provides paths to non-text files; AI uses appropriate tools to extract structured content.

**Examples**:
- 5 medical PDFs (lab results, ultrasounds) → AI reads multimodal, extracts numeric values, flags abnormalities
- 4 UI bug screenshots (PNG) → AI reads visually + filename, consolidates into 3 user stories
- 2 audio files (.m4a, 59min + 23min, Vietnamese) → AI installs whisper-cpp, downloads 1.5GB model, transcribes, synthesizes vision document
- 588-page PDF (CFA ESG textbook) → AI extracts question sections and answer sections into 2 separate PDFs

**Why it matters**: A vertical AI skill cannot assume text-only input. It must compose pypdf, whisper, OCR, computer vision into pipelines on-demand.

---

### Pattern E — Persistent rule via memory system (3 streams ✓✓✓)

**The behavior**: User states a rule once ("when X then Y"); AI writes to memory file; rule fires correctly in subsequent actions across the same/future sessions.

**Examples**:
- "When `/ship`, also run `/context-save`" → memory saved → rule fires correctly 2 times in same session
- "Always verify weekday before recommending schedule" — written after AI mistakenly assumed Sunday when actually Monday
- "Health gating rules: if BP ≥145/95 then urgent, skip study" — embedded automatically in every scheduling artifact thereafter

**Why it matters**: The memory subsystem in Skillpack should distinguish:
- **Static knowledge** (vertical wiki content — handled by `wiki-mcp`)
- **Behavioral rules** (user-specific instructions that should fire across sessions)
- **Cross-context state** (multi-session continuity — user identity, ongoing projects)

The user expects rules to fire **without being reminded**, including across sessions. This is the "L1-L7 maturity" model: skill must progress from store-only to store-and-apply.

---

### Pattern F — External AI agent coordination (multi-agent stack) (2 streams ✓✓)

**The behavior**: User runs multiple AI agents (Claude + 3rd-party bot on Telegram VPS) and uses one as router/coordinator/verifier for the other.

**Examples**:
- User asks Claude to design Telegram bot capability tests (T-CAP-1 to T-CAP-5), then a single ~700-word paste-prompt to bootstrap the bot — avoiding self-hosting
- Telegram bot reports analytical output → user pastes report to Claude → Claude curls API, catches hallucination
- Bot memory full (2200 char SQLite limit) → user forwards memory state → Claude computes compaction math, emits paste-ready prompt to coordinate offload to VPS file

**Why it matters**: Real-world AI adoption is **multi-agent by default**. Skillpack should consider:
- Inter-skill protocol (how does `laws-consultant` skill talk to `bookkeeping` skill?)
- Trust boundaries (which agent is source of truth for which data domain?)
- Cross-agent memory handoff (paste-ready prompt as universal interop)

---

### Pattern G — Pivot from complex to simple per user pushback (3 streams ✓✓✓)

**The behavior**: AI initially over-engineers solution (6-file CLI install, multi-block bash, sophisticated pipeline); user pushes back in 1 sentence; AI must rebuild simpler.

**Examples**:
- Hermes setup: AI proposes 6-file CLI install (SOUL.md, gateway setup, launchd) → user: "Việc setup có vẻ phức tạp nhỉ. Có cách nào thay thế không?" → AI pivots to 1 paste-prompt approach
- Daily journal sync: AI proposes manual copy/paste → user: "Nhưng anh chat trên điện thoại mà" → AI pivots to git push from bot
- Module gen: AI proposes 200-line files → user implicitly approves shorter → AI tightens

**Why it matters**: Skills should default to **minimum viable interaction**. A "complexity budget" should be explicit — user pays in setup time; skill should ask "is this worth N minutes?" before committing.

---

### Pattern H — Standing authorization + trust-verify (1 stream ✓ but high signal)

**The behavior**: User grants standing permission for high-velocity actions (prod deploy, file modification, network calls) via memory rules; AI executes without re-confirming each time; user verifies by sampling output, not by reviewing each step.

**Examples**:
- Production deploy of FE+BE bundle: 2 deploys in single session with zero "should I deploy?" confirmation prompts — AI proceeded based on standing authorization in memory
- Multi-file batch generation: 13 Write calls without intermediate confirmation
- 1-character user approval ("B") triggers full investigate → fix → deploy → smoke test → commit cycle

**Why it matters**: A licensed AI skill needs a **trust-tier model**:
- Tier 0: read-only, no permission needed
- Tier 1: write to local sandbox, one-time confirm
- Tier 2: write to user workspace, memory-based standing permission
- Tier 3: write to production / external systems, requires per-action OR durable opt-in

---

### Pattern I — Output template + constraint enforcement (2 streams ✓✓)

**The behavior**: User specifies output structure with explicit constraints (counts, format, forbidden words); AI produces deliverable in 1 shot, no revision cycle needed.

**Examples**:
- "15-25 statements, 5 fixed groups, Vietnamese plain language, no judgement words, cite source per claim, no preamble" → AI emits 19 statements in exactly 5 groups with citations
- "Each module file structure: frontmatter YAML → content → 'Liên hệ Voi anh Tuấn' section → self-test → Sources" → 12 files match template

**Why it matters**: Skills with **deterministic output schemas** are more valuable than free-form skills. Skillpack might define a "skill manifest" that includes expected output schema.

---

### Pattern J — Bilingual VN + EN + cultural addressing (1 stream ✓ but cross-cutting)

**The behavior**: Vietnamese user mixes Vietnamese conversational with English technical terms; uses Vietnamese workplace hierarchy ("anh"/"em") consistently across sessions.

**Examples**:
- "Vendor CLI hiện build trên Bun + TypeScript" — Vietnamese verb + English tech terms not translated
- "anh-em" pair persists through 30+ messages, even when prompt body is technical English
- Technical terms (MCPB, lease-based, Ed25519, Cloudflare Workers) explicitly told NOT to translate

**Why it matters**: For Southeast Asia market specifically:
- Vertical legal/finance skills must not over-translate (loss of precision)
- Cultural register matters (Vietnamese senior addressing peer ≠ neutral English)
- Skill personalities should be configurable per locale, not assumed Western

---

### Pattern K — Sensitive data boundary management (2 streams ✓✓)

**The behavior**: User keeps PII (medical, legal, family) in same workspace as professional code but explicitly fences it; AI helps audit and maintain the boundary.

**Examples**:
- Medical PDFs → AI adds folder name (both Unicode and ASCII variants) to `.gitignore`, moves files, creates README index, verifies with `git check-ignore`
- Multi-account git: AI flags "personal data → personal GitHub account, not work account" before any commit; refuses to handle PAT secret (no TTY) and hands off cleanly

**Why it matters**: `laws-consultant` skill will handle **highly sensitive data** (client info, contracts, family law). The skill must:
- Detect PII patterns and flag them
- Refuse to embed secrets in skill state
- Distinguish personal vs work identity at git/cloud boundary
- Provide audit log of what was processed

---

### Pattern L — Scope check + defer with calendar anchor (2 streams ✓✓)

**The behavior**: User asks 1-line clarifying question to scope-check, then explicitly defers work with calendar anchor (date, exam, etc.) — not vague "later".

**Examples**:
- "Cái nội dung này chỉ là wiki về sách Corporate Governance thôi em nhỉ?" → AI explains → "OK vậy để sau đi" (deferred, not cancelled)
- "Pre-exam HLU deadline 2026-05-29, parking Stream C until after"

**Why it matters**: User research often confuses "deferred" with "rejected". Skillpack analytics should track defer-resume cycles, not just adoption funnels.

---

### Pattern M — Multi-step plan + progress tracking (2 streams ✓✓)

**The behavior**: When work exceeds 3 steps, user expects AI to proactively use a TODO system to surface progress in real-time.

**Examples**:
- 5-step plan: CLAUDE.md update → fetch 6 sources → Module 5 build → Module 6 build → HTML overview — tracked in TodoWrite, updated 5+ times
- Full deploy cycle: investigate → fix → build → deploy → smoke test → commit → push — todos visible throughout

**Why it matters**: Skills should ship with a **progress contract**: declare the steps before executing, mark completion in real-time, show what's pending.

---

### Pattern N — Health-domain self-care embedding (1 stream ✓ but cross-cutting)

**The behavior**: User with chronic health condition expects AI to embed health-gating rules in every scheduling/planning artifact without being asked.

**Examples**:
- Trip plan PDF has dedicated "Health Safety" section with 5 rules + 4-ping BP monitoring schedule
- Crisis-mode exam plan has trigger: "Any day BP ≥145/95 → skip study, health > grade"
- Daily journal template has BP log as first line of morning/evening template

**Why it matters**: Verticals like `laws-consultant` will increasingly serve **vulnerable users**. Skills should support **gating rules** as a first-class concept — not just content delivery, but conditional logic on user state.

---

### Pattern O — Reusable prompt artifact + self-meta-execution (1 stream ✓)

**The behavior**: User asks AI to produce a reusable prompt that can be pasted into N other AI sessions to crowdsource the same task; then asks the AI to run the prompt against its own session as baseline.

**Examples**:
- This very contribution: user requested a prompt that asks Claude sessions to introspect; the meta-execution against the prompt-authoring session became Stream 4
- Iterative prompt refinement: 3 versions overwriting same file as user corrected interpretation

**Why it matters**: Skillpack should consider **prompt as first-class artifact**:
- Versionable
- Sharable across sessions
- Reusable as testing harness (self-meta-execution = automated regression)
- Distributable as part of a skill bundle

---

## 4. Cross-cutting insights for Skillpack product team

### Insight 1 — Velocity over process

User explicitly prioritizes **AI compression ratio** (90 min vs. 1 sprint) over traditional process gates (PR review, staging environment, multi-stakeholder approval). This implies:
- Licensed skills should optimize for **time-to-value** in user testing
- Permission model must avoid "ask for confirmation N times" anti-pattern
- The compression ratio table (human team vs. AI-assisted) is a real artifact in this user's CLAUDE.md, used for build-vs-skip decisions

### Insight 2 — Trust-but-verify is the operating mode

User does not blindly accept AI output. Across all 4 streams:
- Legal citations are verified against primary source
- Hermes bot output is verified against API ground truth
- Multi-layer verification (DB → API → bundle string → DOM) for production fixes
- Self-correction is explicitly acknowledged ("Em xin lỗi đánh giá thiếu...")

Implication: Skills must support **evidence chains** — every claim cites a fetchable source, every action emits an audit trail.

### Insight 3 — Multi-agent is reality

User runs Claude + 3rd-party Telegram bot + manual review concurrently. Coordination is **paste-based** (no formal protocol) and the user is the integrator. Skillpack should consider:
- Inter-skill messaging protocol
- Standard interop format for paste-ready prompts
- Skill registry that lists other compatible skills

### Insight 4 — Vietnamese SE Asia market has specific needs

- Bilingual output (Vietnamese natural + English tech terms)
- Cultural register (workplace hierarchy)
- Sensitive to over-translation (precision loss)
- Reliance on Vietnamese primary sources (`thuvienphapluat.vn` for legal citations)

Implication: Skillpack's `laws-consultant` demo should ship with **Vietnamese legal source verifier** as a first-class capability, not as an afterthought.

### Insight 5 — Standing permission with sampling-based verification

User does not gate AI actions before execution; instead **samples output for correctness afterward**. This is a fundamentally different model from "approve each tool call". Skills must:
- Default to least-privilege but support durable opt-in
- Emit verifiable artifacts (logs, diffs, snapshots) for post-hoc review
- Support rollback as first-class operation

### Insight 6 — Knowledge artifact is the unit of value, not chat

User produces **files** (12 markdown + 1 HTML in 1 turn; 6 medical reports; 1 legal document set), not chat conversations. The chat is **scaffolding** to produce the artifact. Skills should:
- Optimize for artifact production, not conversation depth
- Make artifact paths first-class output
- Support versioning of artifacts across iterations

### Insight 7 — Memory is policy, not just storage

The 3-fold use of memory (rules, project state, user identity) requires:
- Static `wiki-mcp` (knowledge) ≠ user behavioral rules ≠ session state
- Rules must fire automatically without prompting
- Cross-session continuity must preserve **what user told AI to remember**, not just last conversation

---

## 5. Tool usage frequency (across 51 stories)

| Tool/Skill | Stories using it | Notes |
|---|---|---|
| Write | 30+ | Primary output mechanism — files, not chat |
| Bash | 25+ | Heavy CLI integration (git, brew, sshpass, ffmpeg, pandoc, Chrome) |
| Read (text + multimodal) | 20+ | PDF, PNG, audio paths — multimodal critical |
| Edit | 15+ | Iterative refinement of existing files |
| ctx_execute (Python/JS) | 10+ | API fetches, pypdf, web scrape, math computation |
| ctx_fetch_and_index | 6 | Web canonical sources for citation |
| TodoWrite | 5+ | Multi-step progress tracking |
| Agent (subagent) | 4+ | Parallel research |
| Skill (gstack /investigate /context-save) | 5+ | Skill invocation pattern |
| Playwright MCP | 1 | Browser smoke test |
| WebFetch (via ToolSearch) | 3+ | URL content retrieval |
| Memory file system | Cross-cutting | Persistent rules, project state, references |

**Observation**: The user expects **deep tool composition** — pypdf + whisper + pandoc + ffmpeg + Chrome headless + sshpass + Playwright in a single workflow. Skills must support deep pipelines, not just single-tool calls.

---

## 6. Skillpack-specific observations from this user

Based on the 26 As-Is statements in Stream 3 + observations from Streams 2 & 4 about the skillpack repo itself, this contributor noted:

- **Docs drift in repo**: Some indicators in README don't match repo state (commits count, package locations) — flagged 4 cross-validation items
- **Demo vertical (`laws-consultant`)** aligns directly with this user's existing legal services platform
- **Self-hosted license server option** (Docker + SQLite) is **critical** for this user's air-gapped/compliance-sensitive workloads
- **`wiki-mcp` exposing vertical wiki via MCP tools** matches the user's existing 6-month LLM Wiki pattern (50 pages of Vietnamese legal curriculum)

The user explicitly avoided gap analysis in this contribution — that work is planned as a separate phase if Skillpack accepts this contribution and invites further engagement.

---

## 7. License & sharing

This contribution is submitted intentionally under **Apache License, Version 2.0** per the skillpack `CONTRIBUTING.md`. Contributor has the right to contribute this material (self-authored user research). Attribution: "Vietnamese venture studio COO contributor, 2026-05-26".

The original raw streams (4 markdown files, ~2500 lines total) are available on request for verification. Personal identifiers and proprietary entity codes have been anonymized at "Level B" (medium) per the contributor's privacy policy.

---

## 8. Appendix — How to use this contribution

For Skillpack maintainers:
1. **Pattern map**: Use the 15 patterns to validate or extend Skillpack's product roadmap
2. **Tool composition**: The tool usage frequency table reveals what a real user expects skill bundles to support
3. **Verticals beyond demo**: This user runs adjacent verticals (legal workflow, finance, training) that could inform multi-vertical packaging
4. **SE Asia market signal**: Bilingual, cultural register, source verification needs

For follow-up:
- Original prompt available on request — can be re-run against other users' Claude sessions for comparable data
- Aggregate methodology open for replication

---

**Contact**: Open an issue on the contributor's behalf or reply to the originating GitHub issue. The contributor will respond via the same channel.

---

*Generated 2026-05-26 from 4 Claude Code sessions spanning May 21–26, 2026.*
