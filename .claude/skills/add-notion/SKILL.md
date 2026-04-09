---
name: add-notion
description: Add Notion integration to NanoClaw. Each group connects their own Notion workspace via chat. Credentials stay on the host — containers never see the real token. Triggers on "add notion", "notion 연동", "노션 연결", "notion integration".
---

# Add Notion Integration

컨테이너는 직접 Notion API를 호출하지 않는다. 호스트의 `notion-mcp-proxy`를 통해 모든 Notion 요청을 실행하므로, Notion API 토큰이 컨테이너에 노출되지 않는다.

각 그룹이 채팅에서 `/connect-notion`으로 자신의 Notion 워크스페이스를 연결한다.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'NOTION_MCP_URL' container/agent-runner/src/index.ts && echo "FOUND" || echo "NOT_FOUND"
```

If `FOUND`, skip to Phase 3.

## Phase 2: Apply Code Changes

이미 적용되어 있음. 코드 변경 불필요.

- `src/notion-mcp-proxy.ts` — 호스트 proxy 서버 (Notion MCP 서버 관리, credential 저장)
- `container/notion-mcp-wrapper.js` — 컨테이너 내 stdio ↔ HTTP/SSE 브릿지
- `src/container-runner.ts` — `NOTION_MCP_URL`, `NOTION_MCP_TOKEN` 컨테이너에 주입
- `container/agent-runner/src/ipc-mcp-stdio.ts` — `notion_connect`, `notion_status`, `notion_disconnect` MCP 도구
- `container/agent-runner/src/index.ts` — proxy 통신으로 Notion 연결 상태 확인
- `container/skills/connect-notion/SKILL.md` — 사용자 연결 플로우

## Phase 3: Setup

별도 관리자 설정 불필요. NanoClaw가 실행 중이면 Notion proxy가 자동으로 시작된다.

### Restart

```bash
pm2 restart nanoclaw
```

## Phase 4: User Flow

각 사용자가 채팅에서:

> "노션 연결해줘"

→ 에이전트가 `/connect-notion` 스킬 실행 → Notion Integration Token 입력 안내 → 사용자가 토큰 붙여넣기 → 호스트 proxy가 검증 후 저장 → 연결 완료

## Troubleshooting

### Notion 도구 안 보임

1. `pm2 restart nanoclaw`
2. 해당 그룹에서 `/connect-notion`으로 연결했는지 확인
3. `data/notion-credentials/{group}.json` 파일 존재 확인

### Unauthorized 에러

1. 토큰이 `ntn_` 또는 `secret_`로 시작하는지 확인
2. https://www.notion.so/profile/integrations 에서 통합 활성 상태 확인
3. 페이지에 통합이 연결되어 있는지 확인

### 특정 페이지 접근 불가

페이지에서 "..." → "Connections" → 통합 선택 → "Connect". 하위 페이지는 상속되지만 형제 페이지는 별도 연결 필요.

## Removal

1. `.env`에서 Notion 관련 설정 제거 (있는 경우)
2. `pm2 restart nanoclaw`
