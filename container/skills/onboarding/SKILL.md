---
name: onboarding
description: First-time user setup. Automatically triggers when user-profile.md doesn't exist. Asks about tone, personality, and work context, then saves to user-profile.md.
---

# User Onboarding

This skill runs automatically on the user's first interaction when `/workspace/group/user-profile.md` does not exist.

## Detection

At the start of EVERY conversation, check:

```bash
test -f /workspace/group/user-profile.md && echo "EXISTS" || echo "NOT_FOUND"
```

If `EXISTS`, read the file and apply the preferences. Do NOT re-run onboarding.

If `NOT_FOUND`, run the onboarding flow below BEFORE answering the user's message.

## Onboarding Flow

Send one message with all questions:

> 처음 만나서 반갑습니다! 대화를 시작하기 전에 몇 가지만 알려주세요.
>
> 1. *말투* — 존댓말 / 반말 / 캐주얼 (기본: 존댓말)
> 2. *성격* — 예: 전문적, 친근, 유머러스, 간결 (기본: 친근하고 간결)
> 3. *주요 업무* — 예: 개발, 마케팅, 영업, 기획, 디자인 등
>
> 간단하게 답해주시면 됩니다! 나중에 언제든 바꿀 수 있어요.
> 바로 대화하고 싶으시면 "스킵"이라고 해주세요.

Wait for the user's response.

## Saving

### If user says "스킵" or "skip"

Create a minimal profile with defaults:

```markdown
# User Profile

- 말투: 존댓말
- 성격: 친근하고 간결
- 업무: 미지정
```

### If user provides answers

Parse their response and create `/workspace/group/user-profile.md`:

```markdown
# User Profile

- 말투: {user's answer}
- 성격: {user's answer}
- 업무: {user's answer}
```

### After saving

Confirm briefly and then answer the user's original message (if any):

> 설정 완료! {말투 스타일}로 대화할게요.

## Applying the Profile

ALWAYS read `/workspace/group/user-profile.md` at the start of each conversation and follow the preferences:

- **말투**: Match the specified tone (존댓말/반말/캐주얼)
- **성격**: Match the personality style
- **업무**: Tailor responses to the user's work context

## Updating

If the user says "말투 바꿔줘", "성격 바꿔줘", "프로필 수정", etc.:

1. Ask what to change
2. Read current `user-profile.md`
3. Update the relevant field
4. Save and confirm
