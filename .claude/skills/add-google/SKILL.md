---
name: add-google
description: Add Google Workspace (Gmail + Calendar + Drive) integration using Google Workspace CLI (gws). Admin sets up OAuth app once, each user connects their own Google account in chat. Triggers on "add google", "google workspace", "gmail calendar 연동".
---

# Add Google Workspace Integration

Uses Google's official Workspace CLI (`gws`) as MCP server. Admin creates one GCP OAuth app. Each user connects their own Google account — just click a link and log in.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'gws.*mcp' container/agent-runner/src/index.ts && echo "FOUND" || echo "NOT_FOUND"
```

If `FOUND`, skip to Phase 3.

## Phase 2: Apply Code Changes

### 2.1: Install gws in container

Edit `container/Dockerfile` — add `@googleworkspace/cli` to the global npm install line:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli
```

### 2.2: Wire into agent-runner

Edit `container/agent-runner/src/index.ts`:

1. Check for per-group Google credentials:
```typescript
const gwsCredentialsPath = '/workspace/group/.gws-credentials.json';
const hasGoogleCredentials = fs.existsSync(gwsCredentialsPath);
```

2. Add to `allowedTools`:
```typescript
...(hasGoogleCredentials ? ['mcp__google__*'] : []),
```

3. Add to `mcpServers`:
```typescript
...(hasGoogleCredentials ? {
  google: {
    command: 'gws',
    args: ['mcp', '-s', 'gmail,calendar,drive'],
    env: {
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: gwsCredentialsPath,
    },
  },
} : {}),
```

### 2.3: Create OAuth callback server

Create `src/google-oauth.ts` — temporary HTTP server on the host that:
1. Generates OAuth URL and sends to user
2. Receives Google callback with authorization code
3. Exchanges code for tokens
4. Saves credentials in gws format (`{client_id, client_secret, refresh_token, type: "authorized_user"}`)

### 2.4: Add IPC integration

- Add `start_google_oauth` case to `src/ipc.ts`
- Add `start_google_oauth` MCP tool to `container/agent-runner/src/ipc-mcp-stdio.ts`

### 2.5: Create container skill

Create `container/skills/connect-google/SKILL.md` — in-chat skill that:
1. Calls `start_google_oauth` MCP tool
2. Host sends login URL to user, handles callback automatically
3. User just clicks and logs in — no copy-pasting needed

### 2.6: Copy agent-runner to existing groups

```bash
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/index.ts container/agent-runner/src/ipc-mcp-stdio.ts "$dir/"
done
```

### 2.7: Validate and rebuild

```bash
npm run build
./container/build.sh
```

## Phase 3: Setup (Admin — 1회)

### Create GCP OAuth App

> 1. https://console.cloud.google.com 접속
> 2. 프로젝트 생성 또는 선택
> 3. **API 및 서비스 > 라이브러리**:
>    - "Gmail API" 검색 → **사용 설정**
>    - "Google Calendar API" 검색 → **사용 설정**
>    - "Google Drive API" 검색 → **사용 설정**
> 4. **API 및 서비스 > OAuth 동의 화면**:
>    - User Type: **외부** (External) 선택
>    - 앱 이름, 이메일 입력
>    - 범위 추가: `gmail.modify`, `calendar`, `drive`
>    - 테스트 사용자 추가 (사용할 Google 계정들)
> 5. **API 및 서비스 > 사용자 인증 정보**:
>    - **+ 사용자 인증 정보 만들기 > OAuth 클라이언트 ID**
>    - 애플리케이션 유형: **웹 애플리케이션**
>    - 이름: "NanoClaw"
>    - **승인된 리디렉션 URI 추가**: `http://localhost:3002/callback`
>    - (원격 서버인 경우: `http://YOUR_HOST:3002/callback`)
> 6. **Client ID**와 **Client Secret** 복사

### Configure .env

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Optional:
```bash
GOOGLE_OAUTH_PORT=3002       # Default: 3002
GOOGLE_OAUTH_HOST=localhost   # Default: localhost (change for remote servers)
```

### Rebuild and restart

```bash
npm run build
./container/build.sh
pm2 restart nanoclaw
```

## Phase 4: User Flow

각 사용자가 DM에서:

> "구글 연결해줘"

→ 에이전트가 `/connect-google` 스킬 실행 → Google 로그인 링크 자동 전송 → 사용자가 클릭해서 로그인 → 자동 완료

## Troubleshooting

### "이 앱은 확인되지 않았습니다" 경고

GCP 앱이 프로덕션 인증을 받지 않았기 때문. 테스트 사용자로 등록된 계정만 사용 가능. **고급 → 안전하지 않음으로 이동** 클릭.

### redirect_uri_mismatch 에러

GCP Console에서 승인된 리디렉션 URI에 `http://localhost:3002/callback`이 등록되어 있는지 확인. `.env`의 `GOOGLE_OAUTH_PORT`와 일치해야 함.

### Google MCP 도구 안 보임

1. `/workspace/group/.gws-credentials.json` 파일 존재 확인
2. 컨테이너 리빌드: `./container/build.sh`
3. `pm2 restart nanoclaw`

## Removal

1. `src/google-oauth.ts` 삭제
2. `src/ipc.ts`에서 `start_google_oauth` 케이스 제거
3. `container/agent-runner/src/index.ts`에서 google MCP 관련 코드 제거
4. `container/agent-runner/src/ipc-mcp-stdio.ts`에서 `start_google_oauth` 도구 제거
5. `container/skills/connect-google/` 삭제
6. `container/Dockerfile`에서 `@googleworkspace/cli` 제거
7. `.env`에서 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 제거
8. `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
9. `npm run build && ./container/build.sh && pm2 restart nanoclaw`
