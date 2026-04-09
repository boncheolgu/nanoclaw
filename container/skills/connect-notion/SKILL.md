---
name: connect-notion
description: Connect your Notion workspace. Triggers on "connect notion", "노션 연결", "노션 연동", "notion 연결", "notion 연동".
---

# Connect Notion

This skill connects the user's Notion workspace so the agent can read and write Notion pages and databases.

## Flow

### Step 1: Check status

Use the `notion_status` tool to check if already connected. If connected, tell the user and stop.

### Step 2: Ask for token

Send to user:

> Notion을 연결합니다. API 토큰이 필요해요.
>
> 1. https://www.notion.so/profile/integrations 접속
> 2. **새 API 통합 만들기** (또는 기존 통합 선택)
> 3. **Internal Integration Token** 복사 (ntn_ 으로 시작)
> 4. 여기에 붙여넣어 주세요

Wait for the user to paste the token.

### Step 3: Connect

Use the `notion_connect` tool with the token the user provided.

### Step 4: Confirm

If successful:

> Notion이 연결되었습니다! 다음 메시지부터 사용할 수 있습니다.
>
> 사용 예시:
> - "노션에서 회의록 찾아줘"
> - "노션 페이지 만들어줘"
> - "노션 데이터베이스 조회해줘"

### Disconnect

If the user wants to disconnect, use the `notion_disconnect` tool.

> Notion 연동이 해제되었습니다. 다음 메시지부터 Notion 도구가 비활성화됩니다.
