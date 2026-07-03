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
            detail: 'Run in a terminal — registers the server for this project',
            text: `claude mcp add --transport http local-logs ${endpoint} --header "Authorization: ${authHeader}"`
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
