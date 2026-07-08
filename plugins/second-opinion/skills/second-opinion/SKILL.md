---
name: second-opinion
description: >
  외부 AI(Codex/GPT, Antigravity/Gemini)를 일상어로 부려 쓰는 어댑터 — 점검·리뷰·의견,
  작업 오프로드, 이미지 생성 같은 벤더 능력까지. 트리거 — "코덱스로 점검받고 싶어",
  "코덱스한테 물어봐/시켜줘", "이거 코덱스 의견 들어봐", "안티그래비티로 봐줘",
  "제미나이한테 검토시켜/만들어달라고 해줘", "다른 AI 시각으로 봐줘", "교차 검증해줘",
  "이건 외부 AI로 처리해줘", "클로드 사용량 아끼게 외부로 돌려줘", "second opinion",
  "ask codex", "ask gemini/antigravity", "have codex make it". 코드 리뷰·설계 점검·
  아이디어 검증·글 검토·번역·생성 과업 등 용도 불문. 대상 벤더를 안 정했으면 성격에 맞게
  제안한다.
---

# second-opinion — 외부 AI 어댑터

Claude Code 안에서 **다른 벤더의 AI**를 일상어로 부려 쓴다. Codex Desktop 등
비-Claude 호스트에서도 동작한다 — 호스트별 상세·정확한 호출법은 아래 fast-path의
벤더별 어댑터 참고를 볼 것. 쓰임은 세 축:

1. **의견** — 산출물을 다른 벤더의 눈으로 점검. 같은 벤더의 렌즈를 늘리는 것과 벤더를
   바꾸는 것은 다른 축이다 — 공유 맹점은 후자만 뚫는다.
2. **용량** — 사용자가 원할 때 작업을 외부 벤더 quota로 오프로드. **언제 돌릴지는
   사용자/호출자가 정한다** — 이 스킬은 채널만 제공하고 스스로 라우팅 정책을 갖지 않는다.
3. **능력** — 벤더 고유 기능 사용. 현재 실측 검증: 이미지 생성 (아래 "파일 산출물 과업").

## 벤더 선택 (사용자가 지정 안 했을 때의 기본)

| 상황 | 벤더 | 이유 |
|---|---|---|
| 코드 리뷰·기술 설계 점검·"놓친 것 찾기" | **Codex** (GPT) | 종합 감사에 강함, 신뢰 높음 |
| 빠른 다각 점검·문서 검토·아이디어 브레인스토밍·볼륨 호출 | **Antigravity** (Gemini 3.1 Pro High) | 저비용·병렬 가능 |
| 최대 신뢰가 필요한 판단 | 둘 다 병렬 → 결과 대조 | 교차 확인 |
| 이미지 생성 (사용자가 요청한 경우) | 둘 다 가능 (실측 2026-07-03) | 아래 "파일 산출물 과업" — 채널별 조건 상이 |

## 공통: brief 파일 먼저

프롬프트+대상 콘텐츠를 **임시 brief 파일**로 만든다(스크래치패드 디렉토리).
- 시크릿·자격증명·원시 repo 덤프 금지 — 필요한 부분만 발췌해 큐레이션 (내용이 통째로 외부 벤더에 전송된다)
- 오프로드·생성 과업은 리뷰 발췌가 아니라 **작업 내용 전체**가 외부로 나간다 — 데이터
  경계 확인이 그만큼 더 중요하다
- 지시는 명확히: 역할 1줄 + **과업에 맞는 출력 형식** 지정이 품질을 좌우.
  의견·리뷰 과업이면 "findings를 번호 목록으로, 심각도 태그, 없으면 'NO FINDINGS'" —
  번역·작성·생성 같은 오프로드 과업이면 리뷰 형식을 강제하지 말고 원하는 산출물 형식을
  그대로 지정한다

## 호출 fast-path (실측 검증된 채널 — 2026-07-03, Codex Desktop 실측 추가 2026-07-08)

### Codex

```bash
cd <작업 repo 또는 임시 dir>
timeout 280 codex exec - < brief.txt > out.txt 2>err.txt
```

```powershell
Get-Content brief.txt | codex exec - > out.txt 2> err.txt
```

- 프롬프트는 stdin(`exec -`) — argv에 콘텐츠 넣지 말 것.
- Windows codex sandbox는 파일읽기 불능(CryptUnprotectData 오류) — "이 파일 읽어봐"는 안 되고, 내용을 brief에 발췌 동봉해야 한다.
- git repo가 아닌 cwd면 `codex exec --skip-git-repo-check -`.
→ 호출 전 필수: `references/adapter-codex.md` 를 반드시 읽을 것 (Windows 호스트 주의·이미지 생성·복구·기타 함정)

### Antigravity (agy)

```bash
AGY=$(command -v agy || echo "$LOCALAPPDATA/agy/bin/agy.exe")   # 신규 설치 세션은 PATH 미반영일 수 있음
timeout 280 "$AGY" --model "Gemini 3.1 Pro (High)" -p - < brief.txt > out.txt 2>err.txt
```

```powershell
$agy = if (Get-Command agy -ErrorAction SilentlyContinue) { "agy" } else { "$env:LOCALAPPDATA\agy\bin\agy.exe" }
Get-Content brief.txt | & $agy --model "Gemini 3.1 Pro (High)" -p - > out.txt 2> err.txt
```

- brief는 stdin으로(`-p -` + 파일 리다이렉트) 넣는다. `-p`만 쓰고 `-`를 빠뜨리면 help 출력으로 떨어진다.
- `--model`은 디스플레이 라벨 그대로(`"Gemini 3.1 Pro (High)"`). slug/ID 형식은 exit 0인 채 silent-ignore → 계정 기본값으로 조용히 강등될 수 있으니 정확한 라벨은 `agy models`로 확인해서 그대로 복사할 것.
→ 호출 전 필수: `references/adapter-antigravity.md` 를 반드시 읽을 것 (Windows 호스트 주의·모델 라벨·이미지 생성·복구·기타 함정)

### Claude 역방향 채널

**host guard (MUST NOT 위반)** — 이 채널은 **호출하는 쪽이 Claude가 아닐 때만**
쓴다(Codex 등). **Claude Code host에서는 역방향 채널 변형을 절대 쓰지 않는다** — 의견
렌즈로 쓰면 동일 벤더 자기검증이 되어 교차 검증 목적 자체가 무너진다.

코어에는 Claude 역방향 실행 커맨드를 두지 않는다. 실행 커맨드·비용·도구경계·Windows
함정은 전부 `references/adapter-claude.md`에 있다.
→ 호출 전 필수: `references/adapter-claude.md` 를 반드시 읽을 것 (host guard·비용·도구경계·Windows 함정)

## 오래 걸리는 호출 (60초+ 예상: 큰 brief, 병렬 다건)

Bash `run_in_background`로 띄우고 완료 알림 후 결과 수합. 사용자를 기다리게 하지 않는다.

## 파일 산출물 과업 — 공통 규칙만 (실측 2026-07-03 — 벤더 행동은 바뀔 수 있으니 이상하면 재실측)

텍스트가 아니라 **파일**을 만들어야 하는 과업. 채널별 호출 조건과 산출물 위치는 각 어댑터를 따른다.

- **성공 판정은 벤더의 주장이 아니라 파일 존재로** — 실제 아티팩트 위치를 직접 확인하고,
  사용자에게 검증된 실경로(또는 복사해 둔 최종 경로)를 보고한다
- 산출물을 사용자가 원한 위치까지 옮기는 것이 어댑터의 일 — "벤더 폴더에 있어요"로 끝내지 않는다
- Codex 이미지 생성 레시피는 `references/adapter-codex.md`를, Antigravity 이미지 생성 레시피는 `references/adapter-antigravity.md`를 호출 전 읽을 것.

## 벤더 불능 시 — 원칙만

사용자가 벤더를 **지명**했다면("코덱스로 점검해줘") 그 벤더 자체가 요구사항이다.
지명한 순간 그 벤더의 계정을 쓰고 있다는 뜻이므로, **복구를 강하게 안내하고 재시도를
기본 흐름으로 삼는다.** 조용히 다른 리뷰어로 대체하지 않는다.

1. **실패를 정확히 보고** — 미설치인지 / 인증 만료인지 / 에러 원문 핵심 한 줄
2. 복구 커맨드는 지명 벤더의 어댑터를 따른다: Codex는 `references/adapter-codex.md`, Antigravity는 `references/adapter-antigravity.md`.
3. **"로그인 끝나면 말해줘 — 바로 재시도할게"** 로 마무리. 여기서 턴을 끝내는 것이
   정답이다(사용자 손이 필요한 단계).
4. **대체 리뷰는 사용자가 동의할 때만** — 다른 벤더 제안은 가능하나, Claude 자체
   리뷰로의 대체는 교차 검증 목적 자체가 무너진다는 점을 반드시 밝히고 제안한다.

벤더를 지명하지 않은 요청("다른 AI 시각으로")이라면 가용한 벤더로 라우팅하면 된다.

## 결과 전달 원칙

1. **벤더 출력은 "그 벤더의 견해"로 전달** — 진실로 relay하지 않는다. 중요한 지적은 가능하면 직접 재확인(파일 대조·간단 실행) 후 "확인됨/미확인" 라벨을 붙인다.
2. 원문 왜곡 금지 — 핵심 findings는 요약하되 severity와 근거를 보존한다.
3. "이상 없음"은 약한 신호다(특히 Gemini는 false-negative 편향) — "문제를 못 찾았다"이지 "문제가 없다"가 아님을 한 줄로 명시한다.
4. 실패(timeout·auth·빈 응답)는 그대로 보고 — 성공한 척 금지.

## 사용량 (선택)

호출 전후 quota가 궁금하면: `codexbar-cli usage -p codex --json` (Antigravity는 IDE 실행 중일 때만 계측 가능). 대량 호출 전 참고용.
