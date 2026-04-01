---
name: add-notion
description: Add Notion integration to NanoClaw. Set one API token in .env and all agents get Notion tools (search, read, create, update pages/databases). Triggers on "add notion", "notion 연동", "노션 연결", "notion integration".
---

# Add Notion Integration

This skill adds Notion as an MCP tool for all NanoClaw agents. One API token in `.env`, shared across all containers.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'NOTION_API_TOKEN' container/agent-runner/src/index.ts && echo "FOUND" || echo "NOT_FOUND"
```

If `FOUND`, skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### 2.1: Add Notion MCP server to agent-runner

Edit `container/agent-runner/src/index.ts`:

1. In `mcpServers`, add `notion` conditionally:

```typescript
...(process.env.NOTION_API_TOKEN ? {
  notion: {
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: {
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`,
        'Notion-Version': '2022-06-28',
      }),
    },
  },
} : {}),
```

2. In `allowedTools`, add:

```typescript
...(process.env.NOTION_API_TOKEN ? ['mcp__notion__*'] : []),
```

### 2.2: Pass token to containers

Edit `src/container-runner.ts` — in `buildContainerArgs()`, add after the OAuth/API key block:

```typescript
const notionToken = process.env.NOTION_API_TOKEN;
if (notionToken) {
  args.push('-e', `NOTION_API_TOKEN=${notionToken}`);
}
```

### 2.3: Update .env.example

Add `NOTION_API_TOKEN=` to `.env.example`.

### 2.4: Copy updated agent-runner to existing groups

```bash
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/index.ts "$dir/"
done
```

### 2.5: Validate

```bash
npm run build
./container/build.sh
```

## Phase 3: Setup

### Get Notion API Token

AskUserQuestion: Do you have a Notion API token?

**If no**, guide them:

> 1. https://www.notion.so/profile/integrations 접속
> 2. **"New integration"** 클릭, 이름 입력 (예: "NanoClaw"), 워크스페이스 선택
> 3. Capabilities: **Read content**, **Update content**, **Insert content** 활성화
> 4. **Submit** 후 토큰 복사 (`ntn_` 또는 `secret_`로 시작)
>
> **중요**: 접근할 페이지/데이터베이스에서 "..." → "Connections" → 통합 연결 필요

### Configure

`.env`에 추가:

```bash
NOTION_API_TOKEN=ntn_your-token-here
```

### Build and restart

```bash
npm run build
pm2 restart nanoclaw
```

## Phase 4: Verify

> 아무 채팅에서 이렇게 보내보세요:
> - "노션에서 회의록 검색해줘"
> - "노션 데이터베이스 목록 보여줘"

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -iE "(notion|mcp)"
```

## Troubleshooting

### Agent에 Notion 도구가 안 보임

1. `.env`에 `NOTION_API_TOKEN` 설정 확인
2. `container/agent-runner/src/index.ts`에 notion MCP 설정 확인
3. 기존 그룹 agent-runner 복사: `for dir in data/sessions/*/agent-runner-src; do cp container/agent-runner/src/index.ts "$dir/"; done`
4. `pm2 restart nanoclaw`

### Unauthorized 에러

1. 토큰이 `ntn_` 또는 `secret_`로 시작하는지 확인
2. https://www.notion.so/profile/integrations 에서 통합 활성 상태 확인
3. 페이지에 통합이 연결되어 있는지 확인

### 특정 페이지 접근 불가

페이지에서 "..." → "Connections" → 통합 선택 → "Connect". 하위 페이지는 상속되지만 형제 페이지는 별도 연결 필요.

## Removal

1. `container/agent-runner/src/index.ts`에서 notion MCP 서버와 `mcp__notion__*` 제거
2. `src/container-runner.ts`에서 `NOTION_API_TOKEN` 전달 제거
3. `.env`에서 `NOTION_API_TOKEN` 제거
4. `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
5. `npm run build && pm2 restart nanoclaw`
