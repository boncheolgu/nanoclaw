---
name: connect-google
description: Connect your Google account for Gmail, Calendar, and Drive access. Triggers on "connect google", "구글 연결", "구글 연동", "google 연결", "gmail 연결", "캘린더 연결".
---

# Connect Google Account

This skill connects the user's personal Google account so the agent can access their Gmail, Calendar, and Drive.

## Flow

### Step 1: Check status

Use the `google_auth_status` tool to check if already connected. If connected, tell the user and stop.

### Step 2: Generate auth URL

Use the `google_auth_url` tool to get the authorization URL.

Send to user:

> Google 계정을 연결합니다. 아래 링크를 클릭해서 로그인해주세요:
>
> [auth URL here]
>
> 로그인 후 "이 앱은 확인되지 않았습니다" 경고가 나올 수 있습니다.
> **고급** → **안전하지 않음으로 이동** 을 클릭하세요.
>
> 권한 승인 후 브라우저가 빈 페이지나 에러 페이지로 이동합니다. 이건 정상입니다!
> **브라우저 주소창의 전체 URL을 복사해서 여기에 붙여넣어 주세요.**
>
> URL 예시: `http://localhost:1?code=4/0AXX...&scope=...`

Wait for the user to paste the redirect URL.

### Step 3: Extract code and exchange

From the URL the user pastes, extract the `code` parameter:
- Parse the URL and get the `code` query parameter
- URL decode it if needed

Use the `google_auth_exchange` tool with the extracted code.

### Step 4: Confirm

If successful:

> Google 계정이 연결되었습니다! 다음 메시지부터 사용할 수 있습니다.
>
> 사용 예시:
> - "오늘 이메일 확인해줘"
> - "이번 주 일정 보여줘"
> - "내일 오후 2시에 미팅 잡아줘"
> - "김철수에게 메일 보내줘"
> - "구글 드라이브에서 파일 찾아줘"

### Disconnect

If the user wants to disconnect, use the `google_disconnect` tool.

> Google 연동이 해제되었습니다. 다음 메시지부터 Gmail/Calendar/Drive 도구가 비활성화됩니다.
