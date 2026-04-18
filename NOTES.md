# Vertical AI — Research Notes

Date: 2026-04-18

## Core Thesis

Generic models (Claude 4.7+) are capable foundations but risky for verticals requiring:

1. Deep domain understanding
2. Deep knowledge
3. Correct skills + accountability

Pattern: **Generic model = foundation agent (manager). Vertical agent = specialist who owns the risk.**

---

## The Skill Problem

Current state: skills are markdown files (.md)

- Readable, copyable, zero IP protection
- Prompts only — no logic, no state, no execution
- Anyone can fork, steal, redistribute

Skills as markdown = blog posts. Not real competency.

---

## The Compiled Skill Thesis

**Skills should be compiled binaries, not markdown.**

Architecture shift:

```
Skill.md   → text instructions, readable, no IP protection
Skill.mcpb → compiled binary, tools + logic + state + shell
```

What compiled skills can do that markdown can't:

- Conditional logic, loops — real execution, not just prompts
- Persistent state via SQLite (bun:sqlite built-in)
- Cross-platform shell execution (Bun Shell)
- Protected IP — user installs, cannot read source
- Auto-update mechanism
- Distributable as single binary

---

## Why Anthropic Acquired Bun (Dec 2025)

Not just DX. Strategic reasons:

1. **`bun compile`** — ship Claude Code as standalone binary, no Node.js required on user machine
2. **Bun Shell (`$`)** — cross-platform shell abstraction for agentic tool running commands on Mac/Windows/Linux
3. **Runtime-level sandboxing** — own the runtime = build permission controls + resource limits at the execution layer (critical for AI agents running arbitrary code)
4. **`bun:sqlite` built-in** — local state, memory, context with zero dependencies
5. **Jarred Sumner inside Anthropic** — build runtime features specifically for agentic workloads

Real play: AI agents need a runtime built FOR agentic workloads. Bun can be shaped for it. Node can't.

---

## .mcpb Format (MCP Bundle)

Already exists. Already being used.

- ZIP archive + manifest (like Chrome extensions / VS Code .vsix)
- Ships compiled Bun binary inside
- No Node/Python required on user machine
- Source code unreadable to end user
- Includes: OS keychain for secrets, auto-update, curated directory support

Key projects:

- [MCP Blog — adopting .mcpb](https://blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb/)
- [K-Dense-AI scientific-agent-skills — .mcpb proposal](https://github.com/K-Dense-AI/scientific-agent-skills/issues/13)
- [mpak — MCP skills registry](https://mpak.dev/)

---

## Open Questions

- Can a compiled .mcpb skill embed its own system prompt + refuse to expose it?
- What's the monetization model? Per-install? Subscription via binary license check?
- Who builds the vertical skill marketplace if Anthropic's plugin system stays markdown?
- Can Bun binary do attestation / tamper detection?

---

## Direction

Build vertical agent architecture where:

- Generic Claude = orchestrator
- Compiled .mcpb skills = domain specialists with protected IP
- Skills are software products, not prompt templates

---

## From "Vertical AI Agents Could Be 10X Bigger Than SaaS" (Y Combinator Podcast https://www.youtube.com/watch?v=ASABxNenD_U)

### Core Characteristics

- Domain Expertise: Unlike broad models, vertical AI is built to understand the deep nuances, regulations, and terminology of a specific sector (9:24-9:55).
- Action-Oriented (Agency): They don't just provide information; they perform workflows. They are designed to automate tasks that previously required a human to operate software (16:55-17:00, 20:32-21:14).
- End-to-End Integration: They often replace entire functions or teams rather than just acting as a productivity tool for an existing employee (0:05-0:09, 24:06-24:12).
- Tailored Evaluation: They rely on highly specific eval sets (testing data) unique to the company or use case they serve, ensuring accuracy for that specific environment (28:16-28:22).

### What They Do

- Replace Labor-Intensive Admin Work: They target "boring, repetitive" administrative tasks—often referred to as "butter-passing" jobs—that are high-churn and inefficient for humans to perform manually (35:52-36:14, 40:16-40:26).
- Automate Specific Functions:
    - Customer Support: Handling complex tickets with specific knowledge rather than simple, zero-shot prompting (27:14-27:21).
    - QA Testing: Replacing the need for dedicated QA teams by performing tests directly within the engineering workflow (23:02-24:12).
    - Recruiting: Managing end-to-end screening processes for candidates (24:32-25:39).
    - Voice Interactions: Automating professional phone calls, such as debt collection in the banking sector (35:32-36:23).
    - Specialized Bidding/Billing: Agents built to bid on government contracts or manage medical billing for specific clinics (40:49-41:34).

In essence, the goal of these agents is to combine the software and the human operations role into a single, automated product, which the hosts argue could make them significantly larger and more valuable than traditional SaaS companies (16:25-17:00).
