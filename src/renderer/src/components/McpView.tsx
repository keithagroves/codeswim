// Placeholder surface for the MCP tab of the Tools section. MCP server
// configuration isn't wired yet; this explains what the tab will hold so the
// tab itself isn't a dead end.
export function McpView(): React.JSX.Element {
  return (
    <div className="skills-empty-state">
      <h2>MCP servers</h2>
      <p>
        Model Context Protocol servers extend the agent with extra tools and data sources — file
        systems, issue trackers, databases, and more.
      </p>
      <p>
        Configuration from inside codeswim is coming soon. For now, set up MCP servers in your
        opencode config and they’ll be available to the agent.
      </p>
    </div>
  )
}
