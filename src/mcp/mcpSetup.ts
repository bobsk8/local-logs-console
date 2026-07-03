// Pure builders for the "Copy MCP Setup" command — unit-testable.

export interface McpSetupSnippet {
    label: string;
    detail: string;
    text: string;
}

export function buildMcpSetupSnippets(endpoint: string, token: string): McpSetupSnippet[] {
    const authHeader = `Bearer ${token}`;
    const mcpJson = {
        mcpServers: {
            'local-logs': {
                type: 'http',
                url: endpoint,
                headers: { Authorization: authHeader }
            }
        }
    };
    const cursorJson = {
        mcpServers: {
            'local-logs': {
                url: endpoint,
                headers: { Authorization: authHeader }
            }
        }
    };

    return [
        {
            label: 'Claude Code (CLI command)',
            detail: 'Run in a terminal — safe to re-run; the leading remove clears any stale registration',
            // The `remove` first makes this idempotent: `claude mcp add` fails if
            // an entry named "local-logs" already exists, so re-running a bare add
            // after a port/token change would error. `;` (not `&&`) keeps going even
            // when nothing was registered yet, and works in bash, zsh and PowerShell.
            text: `claude mcp remove local-logs; claude mcp add --transport http local-logs ${endpoint} --header "Authorization: ${authHeader}"`
        },
        {
            label: 'Claude Code / generic (.mcp.json)',
            detail: 'Paste into .mcp.json at the project root',
            text: JSON.stringify(mcpJson, null, 2)
        },
        {
            label: 'Cursor (.cursor/mcp.json)',
            detail: 'Paste into .cursor/mcp.json',
            text: JSON.stringify(cursorJson, null, 2)
        },
        {
            label: 'Endpoint + token (plain)',
            detail: 'For any other MCP client',
            text: `URL: ${endpoint}\nHeader: Authorization: ${authHeader}`
        }
    ];
}
