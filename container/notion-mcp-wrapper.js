#!/usr/bin/env node
'use strict';
/**
 * Notion MCP stdio wrapper for containers.
 * Bridges Claude Agent SDK's stdio ↔ host notion-mcp-proxy (HTTP/SSE).
 * The host proxy runs @notionhq/notion-mcp-server with the real Notion token.
 * This wrapper never sees the actual Notion API token.
 *
 * Required env vars:
 *   NOTION_MCP_URL   - Base URL of the host notion-mcp-proxy
 *   NOTION_MCP_TOKEN - Proxy authentication token
 *   GROUP_FOLDER     - Container's group folder name
 */

const { createInterface } = require('readline');

const { NOTION_MCP_URL, NOTION_MCP_TOKEN, GROUP_FOLDER } = process.env;

if (!NOTION_MCP_URL || !NOTION_MCP_TOKEN || !GROUP_FOLDER) {
  process.stderr.write('notion-mcp-wrapper: missing required env vars\n');
  process.exit(1);
}

const sseUrl = `${NOTION_MCP_URL}/notion/mcp/sse`;
const messageUrl = `${NOTION_MCP_URL}/notion/mcp/message`;

// Forward stdin lines → POST /notion/mcp/message
// Token and groupFolder are passed as headers to avoid query string exposure.
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  fetch(messageUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Token': NOTION_MCP_TOKEN,
      'X-Group-Folder': GROUP_FOLDER,
    },
    body: line,
  }).catch((err) => {
    process.stderr.write(`notion-mcp-wrapper: send error: ${err}\n`);
  });
});

// Connect to SSE → forward to stdout
// Token and groupFolder are passed in the POST body to avoid query string exposure.
async function streamSse() {
  const res = await fetch(sseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupFolder: GROUP_FOLDER, proxyToken: NOTION_MCP_TOKEN }),
  });
  if (!res.ok) {
    process.stderr.write(
      `notion-mcp-wrapper: SSE connect failed: ${res.status}\n`,
    );
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        process.stdout.write(line.slice(6) + '\n');
      }
    }
  }
}

streamSse().catch((err) => {
  process.stderr.write(`notion-mcp-wrapper: SSE error: ${err}\n`);
  process.exit(1);
});
