If **AI-awareness is a first-class requirement**, my pick today would be **Electron**, even though I’d normally be tempted by Tauri for a greenfield desktop app.

The reason is not Electron’s UI toolkit. It’s that Electron gives you a **consistent Chromium runtime**, which means your app naturally has a DOM, accessibility tree, stable element hierarchy, focus state, bounding boxes, ARIA roles, and Chrome DevTools Protocol. Electron exposes CDP directly through `webContents.debugger`, and Chromium’s Accessibility domain can expose a persistent accessibility tree with stable `AXNodeId`s. That is remarkably close to the observation layer an agent needs. ([Electron][1])

### The important part: don't make the agent "look at the screen"

I would architect the desktop app so the AI almost never needs screenshots.

A screenshot should be the **fallback representation**. Your primary representation should be something like:

```ts
type UIElement = {
  id: string;              // stable app-defined ID
  role: "button" | "input" | "list" | "document" | "canvas" | ...;
  label?: string;
  value?: unknown;
  state?: Record<string, unknown>;
  bounds?: { x: number; y: number; width: number; height: number };

  actions: UIAction[];
  children?: UIElement[];
};
```

The renderer might produce:

```text
Workspace
├── Sidebar
│   ├── Project "Acme"
│   └── Search field
├── Document "Proposal"
│   ├── Heading "Q3 Strategy"
│   ├── Paragraph ...
│   └── Chart "Revenue by quarter"
└── Agent panel
```

And an element could advertise:

```json
{
  "id": "document:proposal",
  "role": "document",
  "label": "Proposal",
  "actions": [
    "focus",
    "summarize",
    "rename",
    "export",
    "close"
  ]
}
```

Now your agent doesn't have to reason:

> "There appears to be a rectangle around x=437, y=182; maybe that's the rename button."

It reasons:

```text
rename(document:proposal, "2027 Proposal")
```

That's a dramatically more scalable architecture.

### I would split the application into these layers

* **Application state** — the authoritative domain model. Projects, documents, tabs, selections, etc. Never derive this from pixels.
* **Semantic UI graph** — what the human can currently perceive/interact with: element IDs, roles, labels, relationships, selection, focus, visibility and bounds.
* **Action graph** — typed things an agent is allowed to do: `openDocument`, `setFilter`, `renameItem`, `clickElement`, `insertText`, etc.
* **Agent runtime** — planner/model/tool loop. It consumes state + semantics and requests actions, but doesn't own your UI.
* **Policy/capability layer** — permissions, confirmation requirements, destructive operations, filesystem/network boundaries.
* **Platform adapters** — macOS Accessibility, Windows UI Automation, screenshots, clipboard, keyboard, filesystem, global shortcuts, etc.

That last layer becomes important if the agent needs to interact with applications **outside your own app**. Windows UI Automation explicitly provides programmatic access to desktop UI elements and permits clients to manipulate them; macOS exposes equivalent control through `AXUIElement`. ([Microsoft Learn][2])

So I'd have something like:

```text
                  ┌─────────────────────┐
                  │     LLM / Agent     │
                  └─────────┬───────────┘
                            │
                 plan / observe / act
                            │
                  ┌─────────▼───────────┐
                  │    Agent Runtime    │
                  └──────┬───────┬─────┘
                         │       │
             ┌───────────▼─┐   ┌─▼──────────────┐
             │ Semantic UI │   │ Action Registry │
             │    Graph    │   │ + Capabilities │
             └──────┬──────┘   └──────┬─────────┘
                    │                 │
         ┌──────────▼─────────────────▼──────────┐
         │             Application Core          │
         │       state / commands / events       │
         └──────────┬─────────────────┬──────────┘
                    │                 │
           ┌────────▼──────┐   ┌──────▼────────┐
           │ Electron UI   │   │ Native Bridge │
           │ DOM / AX tree │   │ AX / UIA / OS │
           └───────────────┘   └───────────────┘
```

The **Application Core** is the thing I would invest in heavily. React/Electron/Tauri should ultimately be replaceable.

---

## Why Electron over Tauri for this specific use case

For a conventional desktop app, Tauri is extremely attractive. Tauri 2 has a strong capabilities model for restricting what each window/webview can access, uses Rust for the core, and avoids bundling Chromium. ([Tauri][3])

But that last advantage becomes a slight disadvantage for your particular idea.

Tauri currently uses **WebView2 on Windows, WKWebView on macOS, and WebKitGTK on Linux**. ([Tauri][4])

So:

```text
Electron
    your app
       ↓
    Chromium
       ↓
    DOM / CDP / Accessibility
       ↓
    same model everywhere
```

versus roughly:

```text
Tauri
          your app
             ↓
    ┌────────┼────────┐
    ↓        ↓        ↓
 WebView2  WKWebView WebKitGTK
 Windows    macOS     Linux
```

That's not inherently bad, but **I infer that it gives you more platform-specific edge cases in low-level UI inspection and instrumentation** because you're depending on three different browser engines/interfaces rather than one. Tauri deliberately abstracts those OS-provided webviews through WRY. ([Tauri][5])

Electron gives you a very useful escape hatch:

```ts
win.webContents.debugger.attach();
await win.webContents.debugger.sendCommand(
  "Accessibility.getFullAXTree"
);
```

Now the agent can literally ask Chromium:

> "What is currently interactable in this window?"

That's an unusually strong primitive for an AI-native desktop shell. Electron exposes the Chrome debugging protocol, while Chromium provides dedicated accessibility-tree APIs. ([Electron][1])

---

## What about Flutter?

Flutter is more interesting here than it first appears. Flutter maintains an explicit **Semantics tree**, and its platform layer turns that into the platform-native accessibility representation. Standard widgets generate that accessibility tree automatically. ([Flutter API][6])

So Flutter isn't a bad AI foundation at all.

The downside for your case is ecosystem/tooling. Flutter is fundamentally doing its own rendering and then projecting semantic information outward; browser-based stacks give you the DOM/ARIA/CDP ecosystem essentially for free. Flutter itself documents the Semantics tree as the semantic analogue required alongside its rendered UI. ([Flutter Documentation][7])

I'd rank them roughly:

```text
AI-native cross-platform desktop

Electron       ★★★★★   best observability + automation
Tauri          ★★★★☆   best lean architecture/security
Flutter        ★★★☆☆   excellent UI, usable semantic model
Native         ★★★★★   ultimate control, high engineering cost
```

If performance/memory eventually makes Electron painful, you could move the shell to Tauri without replacing your semantic/action architecture.

---

## The trick I think will save you a rewrite

Don't equate:

```text
UI component == agent tool
```

Instead use:

```text
Application command == agent tool
UI component        == human affordance for application command
```

For example, suppose you've got:

```ts
renameDocument(documentId, newName)
```

The UI's context menu invokes that command.

The keyboard shortcut invokes that command.

The command palette invokes that command.

And the agent invokes **the exact same command**.

```text
Human:
right click → Rename → type → Enter
                    │
                    ▼
              renameDocument()

Agent:
rename_document(...)
                    │
                    ▼
              renameDocument()
```

This means agents interact with **intent**, rather than pretending to be a mouse.

Only expose generic:

```ts
click(x, y)
type(text)
pressKey(key)
```

when you're controlling something you *don't* own.

That distinction is enormous.

---

## MCP fits nicely, but one layer higher

I'd also make your action/resource system **MCP-compatible**, but I wouldn't build the internal architecture around MCP.

The current MCP specification has explicit concepts for **Tools**, which let models perform operations, and **Resources**, which expose contextual data. The July 28, 2026 spec also moved the protocol core to a stateless model, which makes it more attractive as an interoperability boundary. ([Model Context Protocol][8])

So your architecture could expose:

```text
Internal API

resources
  app://workspace
  app://selection
  app://screen
  app://documents/123

commands
  document.rename
  document.delete
  workspace.search
  panel.open
  selection.set
```

and then adapt it externally:

```text
Internal commands
       │
       ├── UI
       ├── keyboard shortcuts
       ├── command palette
       ├── internal agent
       └── MCP server
```

That's a very future-proof boundary.

---

# What I'd build in your position

**Electron + TypeScript + whatever web UI framework you like**, but with Electron itself kept thin.

I'd structure the repo approximately:

```text
/apps
  /desktop-electron

/packages
  /core
      domain state
      commands
      events

  /ui
      React/Svelte/etc.

  /semantics
      semantic tree
      element registry
      focus
      selection
      bounds
      actions

  /agent
      context builder
      planner
      action executor
      approvals

  /capabilities
      filesystem
      network
      shell
      destructive actions

  /platform
      macos/
      windows/
      linux/

  /mcp
      expose resources
      expose tools
```

And I'd make **every meaningful UI component register semantic information**:

```tsx
<AgentElement
  id={`file:${file.id}`}
  role="file"
  label={file.name}
  value={{ path: file.path }}
  actions={[
    "open",
    "rename",
    "duplicate",
    "delete"
  ]}
>
  <FileRow file={file} />
</AgentElement>
```

That gives you three representations simultaneously:

```text
pixels       → human perception
DOM / AX     → accessibility + generic automation
AgentElement → application-level intelligence
```

That third one is what I think most desktop software is currently missing.

### And I'd make one principle non-negotiable

**The agent should know more about your UI than a screenshot does.**

When your application displays:

```text
$4,721,900
```

vision sees `"4,721,900"`.

The semantic layer should see:

```json
{
  "id": "metric:revenue",
  "role": "metric",
  "label": "2026 Revenue",
  "display": "$4.72M",
  "value": 4721900,
  "currency": "USD",
  "period": "FY2026",
  "source": "forecast"
}
```

That's where an AI-native desktop stops being "an app with a chatbot" and starts becoming a fundamentally different kind of software.

**So I wouldn't throw away what you're building from scratch.** I would check whether your current CodeSwim architecture has these three concepts cleanly separated: **state, semantics, and actions**. If those are currently entangled with individual React/UI components, *that's* the part I would refactor before the application gets large—not necessarily the desktop framework itself.

[1]: https://electronjs.org/docs/latest/api/debugger?utm_source=chatgpt.com "Class: Debugger"
[2]: https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32?utm_source=chatgpt.com "UI Automation - Win32 apps"
[3]: https://v2.tauri.app/security/capabilities/?utm_source=chatgpt.com "Capabilities"
[4]: https://v2.tauri.app/concept/process-model/?utm_source=chatgpt.com "Process Model"
[5]: https://v2.tauri.app/concept/architecture/?utm_source=chatgpt.com "Tauri Architecture"
[6]: https://api.flutter.dev/flutter/semantics/?utm_source=chatgpt.com "semantics library - Dart API"
[7]: https://docs.flutter.dev/resources/architectural-overview?utm_source=chatgpt.com "Flutter architectural overview"
[8]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools?utm_source=chatgpt.com "Tools"


Claudes perspective:

Mostly good, with one significant internal contradiction at the center of it.

**The Electron recommendation doesn't follow from the rest of the argument.** The piece spends most of its length arguing that the agent should operate on intent (`renameDocument(id, name)`), not on pixels or DOM nodes — and then picks the framework based on the quality of its pixel/DOM introspection. `Accessibility.getFullAXTree` and CDP are tools for automating apps you *don't own*. In your own app you never need to ask Chromium what's interactable, because you're the one who put it there. You'd expose a typed IPC endpoint that returns your own semantic graph, and it'd be better than anything CDP gives you.

The three-webview-engines concern is real, but it bites on CSS quirks and web API support, not on "can my app describe itself." WKWebView and WebView2 both have a DOM, ARIA roles, focus, and bounding boxes. Pick Electron or Tauri on the ordinary grounds — bundle size, native module needs, whether your team writes Rust, code signing and update infrastructure. The essay actually concedes this at the end ("you could move the shell to Tauri without replacing your semantic/action architecture"), which is the tell that the framework choice was never load-bearing.

**The command-layer insight is the real content and it's correct.** "Application command == agent tool, UI component == human affordance for that command" is the right architecture, and it's been the right architecture since long before agents — it's what gives you undo/redo, a command palette, keyboard shortcuts, scripting, and testability. Agents are just the newest consumer of a bus you should have built anyway. That's the part worth acting on this week.

**I'd push back hard on the parallel `<AgentElement>` tree, though.** A hand-registered semantic mirror alongside the DOM is a maintenance liability: nothing enforces coverage, no compiler catches drift, and it goes stale precisely in the corners nobody exercises. Your own example makes the case against it — `{value: 4721900, currency: "USD", period: "FY2026", source: "forecast"}` is *domain state*. It lives in your model. Wrapping it in a UI component and re-declaring it there puts the data in the hardest possible place to query and creates two sources of truth for one number. The agent should read the forecast from the store, not from a div.

The narrow thing a UI-shaped representation actually buys you is deixis and co-piloting — "what's this chart showing," "summarize what I'm looking at," "click the thing in the corner." That needs a small *what's visible / what's selected / what's focused* context object, not a full mirror of the view hierarchy. Scope it to that and derive it from ARIA plus a few data attributes rather than a second component tree.

**What's missing is the part that will actually hurt.** The layer diagram doesn't engage with: transactionality and rollback when the agent does six things and the fifth was wrong; approval UX granularity (per-command approval is unusable, per-session is unsafe); what happens when the agent and the human edit concurrently; how you test a nondeterministic app; and tool surface explosion — 200 registered commands is a bad tool list, so you need curation or search over commands, which the "internal commands → MCP server" arrow quietly glosses. Notably, the command bus helps with most of these, which is another reason it's the thing to invest in.

Two smaller notes: rating "Native" five stars in a cross-platform comparison is incoherent, since native means building two or three apps. And the MCP claim checks out — the 2026-07-28 spec did move the core to a stateless model, so the "MCP as external boundary, not internal architecture" advice is both current and right.

Net: keep the command bus, defer the framework decision, and treat the semantic layer as a scoped screen-context feature rather than a second UI tree.

Sources: [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [Key Changes — MCP](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [MCP 2026-07-28 spec: stateless core, coming to Claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
