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

**버전 0.9.5** — 소비자 호환 기준. 능력: 의견·오프로드·이미지 생성·멀티모달 입력·실행 영수증·기계적 라우팅(디스패처). (정본 버전은 `plugin.json`.)

이 스킬은 **아무것도 차단하지 않는다** — 중개(relay)만 한다. 디스패처는 커맨드 정합성을 위한 도구일 뿐이다. "Claude가 디스패처를 반드시 거치게" 강제하는 것은 **부르는 쪽(caller)의 책임**이다 → [references/enforcement.md](references/enforcement.md).

## 설치 경로 확인

- 호스트가 제공한 available-skills 카탈로그의 root alias와 상대 경로를 **그대로 결합한 경로**가 정본이다. marketplace/plugin 이름이 캐시 경로에서 반복되어도 정상 구조일 수 있으므로, 경로를 추측해 한 단계를 제거하거나 버전 경로를 재구성하지 않는다.
- 카탈로그 경로는 먼저 `Test-Path -LiteralPath`·`Get-Item -LiteralPath` 또는 직접 읽기로 확인한다. Windows PowerShell 5.1에서는 `rg --files ... | rg '...$'`가 CRLF 때문에 빈 결과를 낼 수 있으므로 부재 판정에 쓰지 않는다. 탐색이 필요하면 `rg --files <root> -g 'SKILL.md' -g 'dispatch.mjs'`처럼 한 프로세스에서 glob을 적용하거나 `Select-String`을 사용한다.
- 정본 경로의 직접 확인이 실패했을 때만 스킬을 읽을 수 없다고 보고한다. 검색 결과가 비었다는 이유만으로 설치 누락이나 카탈로그 오류라고 단정하지 않는다.

Claude Code 안에서 **다른 벤더의 AI**를 일상어로 부려 쓴다. Codex Desktop 등
비-Claude 호스트에서도 동작한다 — 호스트별 상세·정확한 호출법은 아래 fast-path의
벤더별 어댑터 참고를 볼 것. 쓰임은 세 축:

1. **의견** — 산출물을 다른 벤더의 눈으로 점검. 같은 벤더의 렌즈를 늘리는 것과 벤더를
   바꾸는 것은 다른 축이다 — 공유 맹점은 후자만 뚫는다.
2. **용량** — 사용자가 원할 때 작업을 외부 벤더 quota로 오프로드. **언제 돌릴지는
   사용자/호출자가 정한다** — 이 스킬은 채널만 제공하고 스스로 라우팅 정책을 갖지 않는다.
3. **능력** — 벤더 고유 기능 사용. 현재 실측 검증: 이미지 생성 · 이미지/영상 분석 입력 ·
   대용량 파일 입력(실측 2026-07-11).

## 실행 모드 — 호출자가 명시할 때만

dispatcher는 실행 목적을 추측하지 않는다. `--mode`를 생략하면 기존 `default` 호출이며,
plan/review 권한을 자동 적용하지 않는다.

| 호출 | 의미 | provider translation |
|---|---|---|
| mode 생략 | 기존 범용 호출 | AGY·Codex는 기존 argv 불변; Claude는 모든 기본 도구 + 비대화형 실행 |
| `--mode plan` | 같은 실제 project cwd를 전체 탐색하는 읽기 전용 계획 | AGY native plan; Claude는 plan identity를 유지한 closed `Read,Glob,Grep`; Codex는 지원하지 않아 호출 전 실패 |
| `--mode review` | 같은 실제 project cwd를 전체 탐색하는 읽기 전용 리뷰 | AGY native plan; Claude는 review identity를 유지한 closed `Read,Glob,Grep`; Codex native `exec review` |

- 이번 mode는 text operation 전용이다.
- **읽기 전용은 명시적 plan/review뿐이다.** mode 생략은 좁은 호출이 아니라 범용
  full-access 호출이며, 권한을 좁히려면 mode를 명시해야 한다.
- sandbox·worktree·snapshot·packet·분리 cwd를 만들지 않는다. 권한은 mode별 flag 조합으로만
  결정되고, 어느 mode든 caller가 준 실제 cwd에서 실행된다.
- Madi 같은 caller가 review panel을 소집할 때만 `--mode review`를 붙인다.
- reviewer는 파일 수정·stage·commit·설치·공개를 하지 않는다.
- receipt의 `requestedMode`·`effectiveMode`·`inputProfile`로 요청 mode와 provider translation을 확인한다.
- 지원하지 않는 조합은 default로 조용히 폴백하지 않는다.
- 명시적 plan/review가 0바이트를 반환하면 provider exit 0이어도 dispatcher exit 4다.

## 벤더 선택 (사용자가 지정 안 했을 때의 기본)

| 상황 | 벤더 | 이유 |
|---|---|---|
| 코드 리뷰·기술 설계 점검·"놓친 것 찾기" | **Codex** (GPT) | 종합 감사에 강함, 신뢰 높음 |
| 빠른 다각 점검·문서 검토·아이디어 브레인스토밍·볼륨 호출 | **Antigravity** (Gemini 3.1 Pro High) | 저비용·병렬 가능 |
| 최대 신뢰가 필요한 판단 | 둘 다 병렬 → 결과 대조 | 교차 확인 |
| 이미지 생성 (사용자가 요청한 경우) | 둘 다 가능 (실측 2026-07-03) | 아래 "파일 산출물 과업" — 채널별 조건 상이 |

## 공통: brief 파일 먼저

프롬프트+대상 콘텐츠를 **임시 brief 파일**로 만든다(스크래치패드 디렉토리).
- 시크릿·자격증명·원시 repo 덤프 금지 — 필요한 부분만 발췌해 큐레이션 (내용이 통째로 외부 벤더에 전송된다). **전송 전 확인·마스킹**: brief 지시부에 API키·토큰·비밀번호·`.env`·자격증명이 실수로 섞이지 않았는지 보고, 있으면 마스킹하거나 뺀다 — 「결과 전달 원칙」 #5(stderr 출력 redact)와 **대칭**으로 입력(brief)도 지킨다. 단 검토·번역·오프로드 **대상 내용에 원래 들어 있는** 예제·더미·모의 자격증명은 그 과업의 정당한 내용이라 건드리지 않는다(마스킹은 지시부에 실수로 섞인 실제 시크릿에 한정 — 스캐너가 아니라 조립 시 지키는 규율).
- 오프로드·생성 과업은 리뷰 발췌가 아니라 **작업 내용 전체**가 외부로 나간다 — 데이터
  경계 확인이 그만큼 더 중요하다
- 지시는 순서 있게 — 아래 5필드를 이 순서대로 서술한다(양식·템플릿이 아니라 서술 지침):
  1. **역할/Objective** (1줄) — 무엇을 시키는지 한 문장.
  2. **대상 내용** — 리뷰·처리할 내용(inline 허용; 대용량은 아래 "대용량은 파일로"). 생성·from-scratch 과업(이미지 생성 등)은 처리할 대상이 없으니 이 필드를 생략한다.
  3. **Constraints** — 제약·범위.
  4. **Output Format** — 과업유형별로 유연하게: 의견·리뷰면 "findings를 번호 목록으로, 심각도 태그, 없으면 'NO FINDINGS'"; 번역·작성·생성 같은 오프로드면 리뷰 형식을 강제하지 말고 원하는 산출물 형식을 그대로 지정한다.
  5. **Do NOT** (맨 끝) — 금지·피할 것.
  - 왜 이 순서: 제약을 앞, 금지를 끝에 두면 lost-in-the-middle(긴 컨텍스트에서 중간 지시가 씹히는 것)을 피한다.

### 대용량은 파일로 (조립 내용이 크면)

- **대상이 이미 파일이면 → 경로를 넘긴다**(inline 복사 금지). codex는 로컬 파일을 직접 읽고, agy는 `--add-dir`로 디렉토리를 허용한 뒤 경로를 읽는다.
- `--mode plan|review`는 예외적으로 실제 project cwd 전체를 읽는 명시적 호출이다. 이때
  대상 파일을 inline packet으로 축소하거나 별도 snapshot으로 분리하지 않는다.
- **조립할 내용이 ≥8,000자면 → 임시 파일에 쓰고 경로를 넘긴다.**
  - 왜 8,000자: 신뢰 채널 argv가 최악 호스트에서도 버티는 선이다. stdin은 정규 경로가 아니라(미문서화 #525/#542, 재파손 가능) 언제든 argv로 물러설 수 있어야 하는데, argv 한계가 호스트별로 직접 실행이면 ~32,767자·cmd.exe 경유면 ~8,191자로 갈린다 → 세 호스트를 다 커버하려면 최악값 8,000 기준. 초과분은 stdin·argv 어느 쪽도 안 쓰는 파일읽기로 보내 stdin 상태와 무관하게 만든다.
  - agy로 넘길 땐 스필 파일을 그 `--add-dir` 대상 디렉토리 안에 둔다(밖이면 못 읽는다).
  - Windows 경로는 슬래시(`/`)로 쓰거나 이스케이프에 주의한다(`\u`·`\t` 등으로 오해석될 수 있다).
  - 스필 파일은 안전한 임시 디렉토리(OS temp/스크래치)에 만들고 호출 후 정리한다 — 시크릿이 실릴 수 있으니 레포 tracked·월드읽기 위치에 두지 않는다.
  - 데이터 경계는 그대로다: 파일이든 인라인이든 "시크릿 금지·필요한 부분만 큐레이션"이 적용된다(파일로 넘기는 건 전달 방식일 뿐 "다 퍼줘라"가 아니다).

## 호출 fast-path (실측 검증된 채널 — 2026-07-03, Codex Desktop 실측 추가 2026-07-08)

모델을 지정하고 벤더를 모르면 `--vendor`를 생략할 수 있다. 디스패처가 Codex
`models_cache.json`, `agy models`, Claude initialize control metadata를 대조해 자동
라우팅한다. 모델 메타데이터만 `~/.second-opinion/model-catalog-v1.json`에 24시간
캐시하므로 fresh hit에서는 공급자 프로세스를 실행하지 않는다. 이미 로컬 파일인 Codex
카탈로그는 현재 `CODEX_HOME`에서 매번 다시 읽어 다른 환경의 cache가 섞이지 않게 한다.
fresh cache에서 모델을 못 찾으면 한 번 즉시 갱신하고, 갱신 실패 시 last-known-good를
사용하되 degraded cache는 5분 뒤 다시 확인한다. 정상 데이터가
없는 공급자가 있거나 0개/동순위 복수 후보면 실행 전에 fail-closed한다. `--vendor`를
명시하면 카탈로그를 읽지 않고 항상 그 값이 우선한다.

대소문자와 공백·점·하이픈은 같은 이름으로 본다. 정확한 카탈로그 항목이 family/version
추론보다 우선한다. 따라서 `opus`는 Claude 최신 alias, `opus 4.8`은 Claude Code,
`opus 4.6`·`sonnet 4.6`은 정확한 항목을 가진 AGY로 간다. Claude Code의 4.6을 원하면
`--vendor`를 생략하고 `Claude Code opus 4.6`이라고 쓰거나, `--vendor claude`와 정규
모델 ID를 함께 명시한다. `terra`·`gpt 5.5`·
`5.6 sol`은 Codex 정규 slug로 바뀐다. `opus terra`처럼 모델 둘을 한 값에 쓰면 추측하지
않고 unknown으로 거부한다.

### Codex

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor codex --operation text --brief brief.txt --cwd <작업 repo 또는 임시 dir> --out out.txt --err err.txt
```

읽기 전용 코드 리뷰는 같은 repo cwd에서 `--mode review`를 추가한다. `--mode plan`은
승인된 non-sandbox native mapping이 없어 호출 전에 실패한다.

이미지 과업은 `--operation image-analyze`(입력 `--input <파일>`)·`--operation image-generate` — 상세는 `references/adapter-codex.md`.

정본은 `scripts/vendor-policy.mjs`다. 아래 raw 벤더 커맨드 언급은 비정본인 내부 동작 설명·수동 디버깅용이다.
timeout은 직접 자식에 `child.kill()`만 수행하므로 벤더가 만든 자손 프로세스가 남을 수 있다.

- brief 내용은 stdin으로 전달된다(디스패처가 처리) — argv에 콘텐츠를 넣지 않는다.
- `--model 5.6 sol@ultra`처럼 model과 effort를 함께 쓰면 dispatcher가 마지막 `@` 뒤의
  승인된 effort를 분리한다. `light`→`low`, `very-high`→`xhigh`, `maximum`→`max`도
  정규화하며 Codex는 선택 모델이 광고한 `low, medium, high, xhigh, max, ultra` 중
  지원값만 허용한다. Codex 모델은
  `CODEX_HOME/models_cache.json`(기본 `~/.codex/models_cache.json`)의 slug·display name·
  논리 별칭과 대조한다. receipt의 `modelRequested`는 입력 원문, `model`은 실행에 전달한
  정규화 결과다.
- codex는 로컬 파일을 읽는다(전 sandbox 모드 실측). 큰 내용은 파일로 두고 경로를 지시할 수 있다.
  과거 CryptUnprotectData 오류는 elevated sandbox 계정의 DPAPI stale 버그로 상위 수정됐다 —
  재발 시 `references/adapter-codex.md`의 우회를 따르고, 내용 발췌 동봉은 안전 폴백으로 쓴다.
- 비-git cwd는 디스패처가 `--skip-git-repo-check`를 자동 판정·삽입한다.
→ 호출 전 필수: `references/adapter-codex.md` 를 반드시 읽을 것 (Windows 호스트 주의·이미지 생성·복구·기타 함정)

### Antigravity (agy)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor agy --operation text --brief brief.txt --model "Gemini 3.5 Flash (High)" --out out.txt --err err.txt
```

읽기 전용 plan/review는 같은 repo cwd에서 각각 `--mode plan|review`를 추가한다.
둘 다 AGY native `--mode plan`으로 번역되며 default 호출에만 쓰는
`--dangerously-skip-permissions`는 붙지 않는다.
AGY headless는 command permission을 물을 수 없으므로 dispatcher가 explicit mode 입력에
`agy-native-readonly/v1` control envelope를 자동 결합한다. 이 profile은 native
읽기·목록·검색 도구만 사용하고 terminal·command·shell·`git diff`를 실행하지 않게 한다.
원 brief는 손실 없이 보존되고, 적용 사실은 receipt의 `inputProfile`에 기록된다.
그래도 command auto-denial 뒤 출력이 비면 dispatcher가 exit 4로 실패시킨다.

이미지 분석은 `--operation image-analyze`(입력 `--input <파일>`) — 상세는 `references/adapter-antigravity.md`.

정본은 `scripts/vendor-policy.mjs`다. 아래 raw 벤더 커맨드 언급은 비정본인 내부 동작 설명·수동 디버깅용이다.

- brief는 무-플래그 stdin으로 넣는다. `-p -`는 agy 1.1.1에서 `-`가 리터럴 프롬프트로
  바뀌어 깨졌다. stdin은 미문서화(#525/#542)라 자동업데이트로 다시 깨질 수 있으므로,
  대형 입력이나 재파손 시 `--add-dir`로 디렉토리를 허용하고 파일 경로를 읽게 하는 폴백을 쓴다.
- 디스패처는 요청 `--cwd`를 AGY의 `--add-dir`로 항상 결속한다. process cwd와 영수증 cwd만
  맞고 AGY가 이전 host workspace를 읽던 0.8.3 결함을 막는다.
- 파일 읽기 성공을 hidden token으로 확인해야 하는 호출은 `--out <path>`와
  `--expect-output <ASCII-token>`을 함께 쓴다. token은 brief나 vendor argv로 보내지 않고
  stdout에서만 검사한다. child exit 0이어도 없으면 dispatcher/receipt exit 4다.
- `--model`은 디스플레이 라벨(`"Gemini 3.1 Pro (High)"`)이나 `agy models`가 출력하는 정규 slug(`gemini-3.1-pro-high`) 둘 다 유효(agy 1.1.5 실측). `agy models`는 이제 slug를, 모델 피커 화면은 라벨을 보여주니 어느 쪽이든 그대로 복사해 쓰면 된다. 형식이 깨졌거나 모르는 이름은 exit 1로 거부되니(구버전의 silent-downgrade 아님) 호출 후 exit code를 확인할 것.
- **agy 영수증 한계**: 영수증의 `model`·`invoked`는 agy에도 기록되지만(요청 모델·실행 여부), 실측 토큰(`vendorUsage`)과 실제 응답 backend 확인은 **Codex 전용**이다. agy는 응답에 모델·session id를 안 실어(헤더 없음) 요청과 실제 실행 모델을 묶을 앵커가 없다. 대신 unknown 모델을 loud reject하므로 강등 위험은 낮다.
→ 호출 전 필수: `references/adapter-antigravity.md` 를 반드시 읽을 것 (Windows 호스트 주의·모델 라벨·이미지 생성·복구·기타 함정)

### Claude 채널

**중립 broker 실행** — 디스패처는 중립 broker로서 실행 규율(safe-mode, timeout, raw output, 모델 결속, 영수증)을 보장한다. 동일 호스트/벤더 호출도 실행하며, 리뷰 독립성 인정 여부는 호출자 방법론(Madi 등)이 영수증을 대조해 판정한다.

raw `claude -p`를 직접 실행하지 않고 같은 디스패처를 쓴다. Claude default 채널은
**full-access**다 — 모든 기본 도구와 비대화형 실행을 갖고 caller가 준 실제 cwd에서 돈다.
model·effort·out·err는 모두 명시해야 한다. `--mode plan|review`를
명시하면 requested/effective identity를 plan 또는 review로 보존하고, native plan workflow를 켜지 않은 채 `Read,Glob,Grep`만으로 같은 project cwd를 읽는다. 즉 읽기 전용은 명시적 mode에서만 생긴다.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor claude --operation text \
  --brief brief.txt --cwd <작업 repo 또는 임시 dir> --model opus --effort high \
  --out claude-result.json --err claude-stderr.txt
```

- 짧은 raw timeout은 없다. 공통 2700초 값은 정상 작업 한계가 아니라 runaway backstop이다.
- child는 `--safe-mode`로 실행해 대상 프로젝트의 CLAUDE.md·hook·plugin·MCP가
  review brief를 바꾸지 못하게 한다. OAuth와 명시한 model·effort는 유지된다.
  `--safe-mode`는 **구성 격리이지 filesystem sandbox가 아니며** default의 full-access와
  공존한다. 세 mode 모두에 그대로 남는다.
- Claude Code 부모의 session marker인 `CLAUDECODE`는 child에 전달하지 않는다. 이는
  same-host 실행을 가능하게 하는 프로세스 격리이며 리뷰 독립성 판정이나 우회가 아니다.
- exit 0이어도 result JSON이 비었거나 실제 모델명이 요청 별칭/정식명과 다르면 exit 4다.
- default 호출은 파일 경로와 전체 repository 조사·수정 지시를 그대로 줄 수 있다. 실측:
  임시 디렉터리에서 default 호출 한 번으로 파일 생성·수정·명령 실행이 모두 성공했다
  (영수증 `default/default`·`invoked=true`·`exit=0`). 결과를 출력 텍스트로 실어 나를 필요가
  없다. `--mode plan|review`도 실제 project cwd를 탐색하지만 읽기만 가능하다.
→ 호출 전 필수: `references/adapter-claude.md` 를 반드시 읽을 것 (리뷰 독립성·비용·도구경계·Windows 함정)

## 오래 걸리는 호출 (60초+ 예상: 큰 brief, 병렬 다건)

Bash `run_in_background`로 띄우고 완료 알림 후 결과 수합. 사용자를 기다리게 하지 않는다.

## 파일 입력 과업 — 대용량·멀티모달 (실측 2026-07-11)

대용량 텍스트는 파일로 두고 읽을 경로를 지시한다. codex는 로컬 파일을 직접 읽고, agy는
`--add-dir`로 디렉토리를 허용해 경로를 참조하거나 무-플래그 stdin으로 받는다. 이미지·영상
분석은 agy에 `--add-dir`와 파일 경로를, codex에 `-i <파일>`을 준다. codex 영상 입력은
ffmpeg로 프레임을 추출한 뒤 그 프레임들을 `-i`로 전달한다(상세 커맨드는 각 어댑터 참고).

- 기존 공통 데이터 경계를 그대로 적용한다 — 외부 벤더에 보낼 필요가 있는 파일만 허용한다
- **입력 과업의 성공 판정은 회신이 실제 파일 내용을 반영하는지로** 한다. 파일명만 읊거나
  "파일을 볼 수 없다"고 답한 것은 실패이며, 산출 과업의 파일 존재 판정과 구분한다

## 파일 산출물 과업 — 공통 규칙만 (실측 2026-07-03 — 벤더 행동은 바뀔 수 있으니 이상하면 재실측)

텍스트가 아니라 **파일**을 만들어야 하는 과업. 채널별 호출 조건과 산출물 위치는 각 어댑터를 따른다.

- **성공 판정은 벤더의 주장이 아니라 파일 존재로** — 실제 아티팩트 위치를 직접 확인하고,
  사용자에게 검증된 실경로(또는 복사해 둔 최종 경로)를 보고한다
- 산출물을 사용자가 원한 위치까지 옮기는 것이 어댑터의 일 — "벤더 폴더에 있어요"로 끝내지 않는다
- 검증은 **실제 사용 방식 그대로** 한다 — 편한 대체 환경은 거짓 통과를 낸다(예: http 서버에서 통과해도 `file://` 더블클릭에서는 실패할 수 있다).
- 이미지 등 시각 산출물은 최종 경로 확인 후 **Read 도구로 사용자에게 표시**한다.
- Codex 이미지 생성 레시피는 `references/adapter-codex.md`를, Antigravity 이미지 생성 레시피는 `references/adapter-antigravity.md`를 호출 전 읽을 것.
- **이미지 생성 전 프롬프트는 `references/image-craft.md`(벤더무관 크래프트)로 채운다** — codex든 agy든 조명·카메라·스타일·구도를 구체화해 품질을 올린다. 단 **네거티브 프롬프트는 벤더별 지원이 달라**(gpt-image-2 미지원) 일괄 권장하지 않는다 — image-craft.md §6·§12와 어댑터별 주의를 따를 것.

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
5. 벤더 stderr/에러를 사용자에게 relay할 때만 32자 이상 연속 토큰을 `[REDACTED]`로 마스킹한다 — 정상 산출물·벤더 입력·로컬 파일 접근에는 적용하지 않는다(해시·ID 오탐 주의).
6. **실행 영수증** — 벤더를 부른 뒤 한 줄로 관측을 남긴다: **요청 벤더·모델 → (알면) 실제 응답 backend → exit/timeout 상태 → 폴백·강등이 있었으면 그 사실**. "요청 = 실행"을 가정하지 말고 실제 벌어진 것을 적는다 — 라벨 오형식 silent-ignore(모델이 조용히 계정 기본값으로 강등)를 이 영수증이 드러낸다. 순서는 위대로 고정하되 사람이 읽는 한 줄이면 된다(엄격 `Key: Value` 스키마는 불필요). 부르는 쪽(madi 등)이 지정 모델이 실제로 불렸는지 확인할 유일한 신뢰 근거다. 파일 영수증은 opt-in이며 `SECOND_OPINION_RECEIPT`에 JSONL 경로를 설정한다. Codex 호출은 `vendorUsage`과 `vendorUsageStatus`에 rollout 실측을 남기며, `null`은 호출하지 않았다는 뜻이 아니라 수집 불가일 수도 있다. **동시 dispatch 호출마다 서로 다른 `--err` 경로를 사용한다** — 경로를 재사용하면 뒤 호출의 truncate와 앞 호출의 append가 `session id:`를 섞어 사용량을 잘못 귀속시킬 수 있다.
   Claude 호출은 result JSON의 실제 model·token usage·cost를 `vendorUsage`에 남기며
   요청 model과 실제 family가 다르면 exit 4다. 선택적 `--expect-output` 호출은 영수증의 `outputCheckStatus`에 `matched`·`missing`·
   `not-requested`·`not-evaluated` 중 하나를 남긴다. challenge token 자체는 남기지 않는다.

## 사용량 (선택)

호출 전후 quota가 궁금하면: `codexbar-cli usage -p codex --json` (Antigravity는 IDE 실행 중일 때만 계측 가능). 대량 호출 전 참고용. `totalTokens`에는 캐시 입력이 포함되고 캐시분은 할인되므로 모델 비용을 직접 비교하지 않는다:

```
비교 기준 = (inputTokens - cachedInputTokens) + outputTokens
```

`reasoningOutputTokens`는 `outputTokens`의 내역이므로 따로 더하지 않는다.
