# second-opinion

[English](./README.md) | **한국어**

Claude Code 안에서 **다른 벤더의 AI**(Codex/GPT, Antigravity/Gemini)를 일상어로 부려 쓰는
어댑터 스킬 — 점검·리뷰·의견부터 작업 오프로드, 이미지 생성까지.

> "이 설계 코덱스로 점검받고 싶어" / "안티그래비티한테 물어봐" / "교차 검증해줘"
> "코덱스한테 로고 시안 이미지 만들어달라고 해줘" / "클로드 사용량 아끼게 이 번역은 제미나이로"
> — 이렇게 말하면 발동한다. 슬래시 커맨드를 외울 필요가 없다.

쓰임 세 축: ① **의견** — 공유 맹점을 뚫는 교차 리뷰 (대표 용도이자 이름의 유래)
② **용량** — 원할 때 작업을 벤더 quota로 오프로드 (언제 돌릴지는 항상 사용자가 결정)
③ **능력** — 벤더 고유 기능. 이미지 생성은 양 벤더 실측 검증됨

## 왜

같은 벤더의 렌즈를 아무리 늘려도 그 벤더가 공유하는 맹점은 뚫리지 않는다.
Claude가 만든 것을 Claude가 검토하면 결함을 과소보고한다 — 벤더를 바꾸는 것이
렌즈를 늘리는 것과는 다른 축의 검증이다. 이 스킬은 그 축을 대화 한 줄로 연다.

실측 사례(이 스킬의 모태가 된 다중 라운드 리뷰 방법론 프로젝트): Claude 5렌즈가
전원 놓친 결함을 외부 벤더 리뷰가 적발했고, Gemini breadth 리뷰는 2라운드 연속으로
실질 P0급 결함(allowlist 우회, 슬롯 오염 래치 등)을 잡았다.

## 무엇을 주나

- **자연어 트리거** — "코덱스로 점검", "제미나이로 봐줘", "다른 AI 시각으로", "second opinion"
- **벤더 자동 제안** — 지정 안 하면 작업 성격으로 고른다: 코드 리뷰·기술 감사 → Codex /
  빠른 다각 점검·문서 검토·볼륨 호출 → Gemini / 중요 판단 → 둘 다 병렬 후 대조
- **실측 기반 gotcha 내장** — 아래 함정들을 스킬이 알아서 피한다

| 함정 (전부 실측) | 스킬의 처리 |
|---|---|
| `agy -p "<텍스트>"`는 stdin을 안 닫으면 **무한 hang** + argv라 **30,000자 한계** | brief를 stdin으로 전달(`-p - < brief.txt`) — hang 없음, 105KB 실측 통과 |
| `--model`에 slug/ID를 주면 **silent-ignore → 계정 기본값(저급 모델)으로 조용히 강등** (exit 0이라 탐지 불가) | 디스플레이 라벨(`"Gemini 3.1 Pro (High)"`)만 사용 |
| Windows에서 codex sandbox의 **파일 읽기 불능** | "파일 읽어봐" 대신 내용을 brief에 발췌 동봉 |
| 이미지 생성: agy는 **지정 저장 위치를 무시**(자기 scratch 폴더에 저장), codex는 **쓰기 샌드박스 필요** + Windows 복사 실패 가능 | 벤더별 실제 산출물 위치를 알고, 파일 존재를 직접 확인 후 원한 위치로 옮김 — 벤더의 "저장했다"를 성공으로 안 침 |
| "이상 없음"은 약한 신호(특히 Gemini의 false-negative 편향) | "문제를 못 찾음 ≠ 문제 없음" 명시 전달 |

## 요구사항

- **Claude Code** (스킬 실행 호스트)
- **Codex CLI** — `npm install -g @openai/codex` 후 `codex login` (ChatGPT 계정 또는 API 키)
- **Antigravity CLI (`agy`)** — Windows PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`
  (macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash` /
  Windows CMD: `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd`) 후 Google 계정 로그인.
  **v1.0.15 이상 필수** — 그 이전 버전은 Windows 비-TTY에서 출력이 조용히 유실된다(수정된 버그)
- 둘 중 하나만 있어도 그 벤더는 동작한다

## 설치

### A. 플러그인으로 (권장)

```
/plugin marketplace add stepbyjason-lab/second-opinion
/plugin install second-opinion@second-opinion
```

### B. CLI (헤드리스/스크립트)

```bash
claude -p "/plugin marketplace add stepbyjason-lab/second-opinion"
claude plugin install second-opinion@second-opinion
```

`claude plugin install`은 `--help`에 안 나오지만 동작한다(Windows Claude Code,
2026-07 실측). 대화형 `/plugin` 다이얼로그를 못 여는 환경에서 유용.

### C. 수동 복사

```bash
git clone https://github.com/stepbyjason-lab/second-opinion
cp -r second-opinion/plugins/second-opinion/skills/second-opinion ~/.claude/skills/
```

## 사용 예

설치 후 아무 세션에서:

```
이 인증 로직, 코덱스로 한번 점검받고 싶어
```
```
방금 쓴 기획서 제미나이한테 검토시켜줘 — 논리 구멍 위주로
```
```
이 아키텍처 결정, 중요한 거니까 코덱스랑 안티그래비티 둘 다 의견 들어보고 대조해줘
```

## 데이터 경계 (중요)

**brief에 담은 내용은 통째로 외부 벤더(OpenAI/Google)에 전송된다.**
스킬은 시크릿·자격증명·원시 repo 덤프를 brief에 넣지 않도록 지시받지만,
최종 책임은 사용자에게 있다. 민감한 코드베이스에서는 발췌 범위를 직접 확인하라.

## 정직한 한계

- 벤더 CLI의 **로컬 인증 상태**를 그대로 쓴다 — 로그인이 만료되면 호출이 실패하고, 스킬은 그 사실을 그대로 보고한다(성공 위장 없음). 벤더를 **지명**했다면 설치/로그인 안내 후 재시도를 제안한다 — 조용히 다른 리뷰어로 대체하지 않는다(대체는 동의 시에만)
- 사용량은 각 벤더 구독의 quota를 소모한다
- 세션 이관·백그라운드 잡 관리 같은 무거운 기능은 없다 — 그건 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)(공식, Apache-2.0)를 병행 설치하면 된다. 이 스킬과 배타적이지 않다
- Windows(Git Bash)에서 실측 검증됐다(이미지 생성 포함). macOS/Linux는 동일 명령 구조지만 이 저장소 시점엔 미실측이다

## 라이선스

[MIT](./LICENSE)
