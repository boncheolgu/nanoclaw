/**
 * Notion tool handlers for the MCP server.
 * Extracted as standalone functions so they can be unit-tested independently.
 * All operations go through the host-side notion-mcp-proxy — containers never
 * see the actual Notion API token.
 */

export interface NotionEnv {
  notionMcpUrl: string;
  notionMcpToken: string;
  groupFolder: string;
}

type McpResult = { content: { type: 'text'; text: string }[]; isError?: true };

export async function handleNotionConnect(
  token: string,
  env: NotionEnv,
): Promise<McpResult> {
  try {
    const res = await fetch(`${env.notionMcpUrl}/notion/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        groupFolder: env.groupFolder,
        proxyToken: env.notionMcpToken,
      }),
    });
    const data = (await res.json()) as {
      success?: boolean;
      name?: string;
      type?: string;
      error?: string;
    };
    if (!res.ok) {
      return {
        content: [{ type: 'text', text: `Failed to connect: ${data.error}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `Notion connected as ${data.name || 'unknown'} (${data.type || 'bot'}). Notion tools will be available on next message.`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err}` }],
      isError: true,
    };
  }
}

export async function handleNotionStatus(env: NotionEnv): Promise<McpResult> {
  try {
    const res = await fetch(`${env.notionMcpUrl}/notion/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: env.groupFolder,
        proxyToken: env.notionMcpToken,
      }),
    });
    const data = (await res.json()) as { connected: boolean };
    return {
      content: [
        {
          type: 'text',
          text: data.connected
            ? 'Connected.'
            : 'Not connected. Use /connect-notion to set up.',
        },
      ],
    };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error checking status: ${err}` }] };
  }
}

export async function handleNotionDisconnect(
  env: NotionEnv,
): Promise<McpResult> {
  try {
    await fetch(`${env.notionMcpUrl}/notion/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: env.groupFolder,
        proxyToken: env.notionMcpToken,
      }),
    });
    return { content: [{ type: 'text', text: 'Notion disconnected.' }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err}` }],
      isError: true,
    };
  }
}
