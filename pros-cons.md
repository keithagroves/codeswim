# Direction: general-purpose IDE vs workflow tool

Two ways codeswim could go. They differ in what the mermaid diagram *is*.

## A — General: diagram-first IDE

What it is: a navigator + agent for any codebase that adopts the
overview/architecture/flows/decisions structure. Diagrams are an index of
the code; the agent enforces "edit diagrams before code." The diagrams
describe the system but the code is what runs.

**Pros**
- Largest possible TAM — any project benefits from better navigation and from drift-free architecture docs.
- Mostly built. Navigator, agent harness, plugin, gate, examples all exist.
- The MDD discipline is genuinely useful even without our app — coverage CLI is portable.
- No new conceptual model for users to learn; just markdown + mermaid.
- The agent integration is differentiated from Cursor/Copilot/Claude Code by being diagrams-first.

**Cons**
- Vague pitch. "A better IDE" competes with VS Code, JetBrains, Cursor — all backed by 9-figure budgets.
- Asks devs to write diagrams up-front, which most don't. Without diagrams the product has no value, so we're upstream of where buyers want to be.
- The win is hard to demo in 60 seconds. "Watch how the diagram updates with the code" lands flat unless the audience already values architecture docs.
- The diagram is a *description* of the system, not the system itself. Drift is always possible; we're fighting entropy.
- Hard to monetize without becoming a generic editor (commodity) or a heavyweight enterprise tool (slow sale).

## B — Workflow tool

What it is: codeswim becomes a place to build, navigate, and run *workflows*.
Each mermaid node maps to a runnable unit (function call, shell command,
HTTP request, etc.). The diagram **is** the program. The agent's job
narrows from "edit any code" to "wire up the nodes you sketched."

**Pros**
- Crisp pitch: "Sketch the flow, run it. The agent fills in the boxes." Demo-able in 30 seconds.
- The diagrams stop being a nice-to-have description and start being load-bearing — users who don't want to draw won't use it, but users who do will get *more* than navigation.
- Distinct competitive lane: Zapier-style automation but mermaid-native, code-first, and AI-fluent. Targets a different user than n8n (devs, not ops).
- The MDD loop becomes natural and tight — there's no separate "architecture diagram" to maintain; the workflow IS the spec.
- Both example projects we just built (`feedback-form`, `nudge`) already *are* workflows. We've been incidentally building workflow examples.
- Clearer monetization: agentic workflow runner = paid product. Generic IDE = open-source.
- Smaller scope means we ship faster and iterate harder on the actual hot path.

**Cons**
- Smaller TAM. Lots of devs have codebases; not all of them think "workflow" is the right frame.
- Crowded category. Zapier, n8n, Temporal, Airflow, GitHub Actions, Inngest. We'd need a clear reason to exist among them.
- We have to build a runtime, not just a navigator — execution engine, secret management, retries, observability. Real engineering work.
- Mermaid wasn't designed as an execution language. We'd extend it (or layer metadata on top), risking re-deriving BPMN's complexity over time.
- We give up the "navigate any codebase" use case. The work we've put into FileTree, breadcrumbs, code views becomes secondary.
- Risk of the agent becoming the product, not the workflow tool — if "describe a workflow in chat, get one" is the magic, the diagram interface is decoration.

## Hybrid possibility

Stay general (A), but ship workflow-execution as a feature: any mermaid
flow with `click ... call navigate("./runners/...")` can be executed top
to bottom. Same UI, two markets.

**Pros**: covers both use cases; defers the bet.
**Cons**: hybrids often satisfy neither audience. Demo gets muddled. Engineering effort doubles.

## Key questions before deciding

1. **Who is the user?** A staff engineer wanting better architecture docs is option A. A solo dev or small team automating their own work is option B. They are different people.
2. **What's the elevator pitch?** If you can't say it in one sentence and have someone go "oh, I want that," the direction isn't sharp enough yet. B has a sharper sentence.
3. **What's the dogfood?** What problem does *Keith* have today that codeswim solves? If the answer is "automating my own stuff," that's a vote for B.
4. **Mermaid: tool or substrate?** In A, mermaid is a documentation tool we happen to make navigable. In B, mermaid is an execution substrate. The bet on Mermaid the project (its parser, its extensibility) is much bigger in B.
5. **Where does the agent earn its keep?** The agent's value is much clearer in B ("turn this sketch into wired code") than in A ("force you to update docs alongside code, which you should be doing anyway").

## Recommendation

If forced to pick: **B, workflow tool**. The pitch is sharper, the
dogfood is clearer, the agent's role is more compelling, and the
mermaid-as-substrate bet has more upside than mermaid-as-documentation.
The cost is giving up the broad-codebase navigator that's already mostly
built — but most of that infrastructure (renderer, breadcrumbs, harness
plugin, coverage tool) carries over to B basically unchanged.

The honest test: pick three workflows you'd want today (cron-replacement,
deploy script, scrape-and-notify) and try to build them in 30 minutes
each with the current codeswim. If that exercise feels generative,
commit to B. If it feels forced, A is the better fit.
