---
name: add-google
description: Add Google Workspace (Gmail + Calendar + Drive) integration using Google Workspace CLI (gws). Admin sets up OAuth app once, each user connects their own Google account in chat. Triggers on "add google", "google workspace", "gmail calendar 연동".
---

# Add Google Workspace Integration

컨테이너는 직접 Google API를 호출하지 않는다. 호스트의 `google-proxy`를 통해 모든 gws 명령을 실행하므로, `client_secret`과 `refresh_token`이 컨테이너에 노출되지 않는다.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'GOOGLE_CLIENT_ID' .env && echo "FOUND" || echo "NOT_FOUND"
```

If `FOUND`, skip to Phase 3 to verify setup.

## Phase 2: Apply Code Changes

이미 적용되어 있음. 코드 변경 불필요.

- `src/google-proxy.ts` — 호스트 proxy 서버 (gws 실행, OAuth exchange, credential 저장)
- `src/container-runner.ts` — `GOOGLE_CLIENT_ID`, `GOOGLE_PROXY_URL`, `GOOGLE_PROXY_TOKEN` 컨테이너에 주입
- `container/agent-runner/src/ipc-mcp-stdio.ts` — `google_auth_url`, `google_auth_exchange`, `google_auth_status`, `google_disconnect`, `google_run` MCP 도구
- `container/skills/connect-google/SKILL.md` — 사용자 연결 플로우
- `package.json` — `@googleworkspace/cli` 설치 (호스트 proxy가 사용, 컨테이너 아님)

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
>    - **승인된 리디렉션 URI 추가**: `http://localhost:1`
> 6. **Client ID**와 **Client Secret** 복사

### Configure .env

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### Restart

```bash
pm2 restart nanoclaw
```

## Phase 4: User Flow

각 사용자가 DM에서:

> "구글 연결해줘"

→ 에이전트가 `/connect-google` 스킬 실행 → Google 로그인 링크 전송 → 사용자가 클릭 → 브라우저가 에러 페이지로 이동 (정상) → **주소창 URL 전체를 복사해서 채팅에 붙여넣기** → 연결 완료

## Troubleshooting

### "이 앱은 확인되지 않았습니다" 경고

GCP 앱이 프로덕션 인증을 받지 않았기 때문. 테스트 사용자로 등록된 계정만 사용 가능. **고급 → 안전하지 않음으로 이동** 클릭.

### redirect_uri_mismatch 에러

GCP Console에서 승인된 리디렉션 URI에 `http://localhost:1`이 등록되어 있는지 확인.

### Google 도구 안 보임

1. `.env`에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 설정 확인
2. `pm2 restart nanoclaw`
3. `data/gws-credentials/{group}.json` 파일 존재 확인 (연결 완료 시 생성됨)

### Google 명령 실패

```bash
tail -f logs/nanoclaw.log | grep -i google
```

## Removal

1. `.env`에서 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 제거
2. `pm2 restart nanoclaw`
