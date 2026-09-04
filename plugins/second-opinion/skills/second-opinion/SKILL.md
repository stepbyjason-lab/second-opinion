---
name: second-opinion
description: >
  외부 AI(Codex/GPT, Antigravity/Gemini, Grok)를 일상어로 부려 쓰는 어댑터 — 점검·리뷰·의견,
  작업 오프로드, 이미지 생성 같은 벤더 능력까지. 트리거 — "코덱스로 점검받고 싶어",
  "코덱스한테 물어봐/시켜줘", "이거 코덱스 의견 들어봐", "안티그래비티로 봐줘",
  "제미나이한테 검토시켜/만들어달라고 해줘", "그록으로 봐줘", "그록한테 시켜줘",
  "다른 AI 시각으로 봐줘", "교차 검증해줘",
  "이건 외부 AI로 처리해줘", "클로드 사용량 아끼게 외부로 돌려줘", "second opinion",
  "ask codex", "ask gemini/antigravity", "ask grok", "have codex make it". 코드 리뷰·설계 점검·
  아이디어 검증·글 검토·번역·생성 과업 등 용도 불문. 대상 벤더를 안 정했으면 성격에 맞게
  제안한다.
---

# second-opinion — 외부 AI 어댑터

**버전 0.9.12** — 소비자 호환 기준. 능력: 의견·오프로드·이미지 생성·멀티모달 입력·실행 영수증·기계적 라우팅(디스패처). SuperGrok 구독 CLI vendor `grok`. (정본 버전은 `plugin.json`.)

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
| `--mode review` | 같은 실제 project cwd를 전체 탐색하는 리뷰 | AGY native plan; Claude는 review identity를 유지한 closed `Read,Glob,Grep`; Codex native `exec review` — **권한 제한 없음(아래 주의)** |

- 이번 mode는 text operation 전용이다.
- ⚠ **읽기 전용 모드에는 shell이 없다 — 리뷰어는 테스트도 `git diff`도 못 돌린다.**
  Claude·AGY의 plan/review는 도구가 `Read,Glob,Grep`뿐이라 **무엇이 바뀌었는지 스스로 알아낼 수단이 없다.**
  그러니 호출자가 진다 — **변경 파일 목록과 unified diff 전문, 인용할 정본 전문을 brief 본문에 인라인**하고,
  **스위트 결과는 호출자가 직접 재서 값으로 준다.** 경로만 주면 리뷰어는 그 자리를 안 읽고,
  그 실패는 산출물에 드러나지 않는다 — 「안 봤다」가 아니라 「지적할 것이 없다」로 돌아온다.
- **읽기 전용은 명시적 plan/review뿐이다.** mode 생략은 좁은 호출이 아니라 범용
  full-access 호출이며, 권한을 좁히려면 mode를 명시해야 한다.
- ⚠ **`--mode review`의 강도는 벤더마다 다르다 — Codex에서는 권한을 제한하지 않는다.**
  Claude는 `--tools` allowlist로, AGY는 native plan + 입력 프로필로 **쓰기 도구 자체를
  없앤다**. 반면 **Codex CLI에는 그런 층이 없다** — 권한을 좁히는 수단이 샌드박스
  (`-s read-only`)뿐이고, 이 프로젝트는 샌드박스를 쓰지 않는다(맥락 전달이 어렵고 결과
  품질이 떨어진다). 그래서 Codex의 `exec review`는 **"무엇을 볼지"를 정하는 워크플로**이지
  권한 축소가 아니다(`codex exec review --help`의 옵션도 `--uncommitted`·`--base`처럼
  대상 지정뿐이다). 실측: `--mode review`로 부른 Codex 호출의 영수증에 `sandbox:
  danger-full-access`가 그대로 찍혔다 — 그 값은 mode가 아니라 `~/.codex/config.toml`의
  `sandbox_mode`에서 온다. **Codex 리뷰에서 파일을 지키는 것은 brief의 금지 지시뿐이니,
  `--mode review`를 안전장치로 계산하지 말 것.**
- sandbox·worktree·snapshot·packet·분리 cwd를 만들지 않는다. 권한은 mode별 flag 조합으로만
  결정되고, 어느 mode든 caller가 준 실제 cwd에서 실행된다.
- Madi 같은 caller가 review panel을 소집할 때만 `--mode review`를 붙인다.
- reviewer는 파일 수정·stage·commit·설치·공개를 하지 않는다.
- receipt의 `requestedMode`·`effectiveMode`·`inputProfile`로 요청 mode와 provider translation을 확인한다.
- 지원하지 않는 조합은 default로 조용히 폴백하지 않는다.
- 명시적 plan/review가 0바이트를 반환하면 provider exit 0이어도 dispatcher exit 4다.

## Madi 리뷰 바로 보내기

Madi 패널에서 가장 흔한 코드 리뷰는 먼저 아래 한 건을 보낸다. `review-brief.txt`에는 위의
5필드(역할/대상/제약/출력 형식/Do NOT)를 넣고, 특히 **번호 목록·P0~P3 심각도·파일/줄 근거·파일
수정 금지**를 명시한다.

```bash
node <dispatch> --vendor codex --operation text --mode review --brief review-brief.txt \
  --cwd <review-target> --out review.out --err review.err
```

독립 2차 패스는 같은 brief·`--cwd`·`--mode review`를 보존하고 `--vendor`, 해당 벤더가 요구하는
`--model`, `--out`/`--err`만 바꿔 보낸다. Grok 2차 패스의 **표준 effort는 가성비 기준
`medium`**이다(`--model grok-4.6 --effort medium`). 결과의 영수증에서 실제 `vendor`·`model`·
`requestedMode`/`effectiveMode`를 확인한 뒤에만 Madi 패널 증거로 사용한다. Codex의 review는
워크플로 선택일 뿐 권한 격리가 아니므로, 이 명령만으로 쓰기가 막힌다고 간주하지 않는다.

**Linked Git worktree에서 현재 diff를 리뷰할 때:** Grok·AGY의 명시적 plan/review에는 terminal이나
`git diff`가 없다. worktree 루트의 `.git`은 디렉터리가 아니라 부모 저장소를 가리키는 파일일 수
있으므로, vendor에게 `.git`·부모 Git 관리 경로를 찾아 현재 diff를 재구성하라고 시키지 않는다.
`대상 내용`에 **변경 파일 목록과 exact unified diff를 전문으로** 넣고, 그 파일·diff만 근거로
검토하라고 명시한다. 실제 `--cwd`는 그대로 유지한다. diff는 cwd를 대체하는 snapshot이 아니라
리뷰 대상을 확정하는 증거다. 이 packet이 없으면 linked-worktree Grok/AGY 결과는 유효한 current-diff
리뷰 증거로 쓰지 말고, 호출 전에 brief를 다시 조립한다.

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

소비 애플리케이션의 텍스트 생성은 `dispatch.mjs --request-json <파일>
--response-json <파일>` 통합 경로를 쓸 수 있다. request schema v1은 `operation=generate`,
요청 provider/model, 분리된 `system`/`user`, stream, env-file 포인터,
`max_retries`(기본 5, 0~16), `lens_id`(최대 64자)를 받는다. `budget`은 거부한다.
한 요청은 지정 provider 하나만 접촉하며 같은 provider의 일시 실패만 2초·2배·최대 60초로
재시도하고 full jitter를 적용한다. `Retry-After`가 없으면 `[0, 계획 백오프]`, 있으면
스케줄링 값을 최대 3600초로 제한한 뒤 `[Retry-After, max(계획 백오프, Retry-After)]`에서
대기를 정한다. 수신한 헤더 원문은 제한하지 않고 그대로 기록한다.
`silence_timeout_seconds`는 payload 침묵 임계이며 기본 600초·허용 1~3600초다. transport
heartbeat·SSE 주석·빈 `data:`·공백 payload는 재장전하지 않는다. 기존
`connect_timeout_seconds`·`read_timeout_seconds`도 같은 침묵 임계로 흡수하고 둘 다 오면 큰
값을 쓴다. 새 필드가 있으면 그 값이 우선한다. `timeout_seconds`는 호출자가 보낼 때만 총 경과
마감이며 생략하면 호출자 총 경과 상한이 없다. 공통 3600초 비용 상한은 재시도 sleep을 세지 않는다.
JSON/SSE 파싱에 성공하고 텍스트가 문자열로 존재하지만 공백뿐인 응답만
`vendor-error`/`vendor` 일시 실패로 재시도한다. 텍스트 필드 부재·비문자열(`content: null`
포함)과 malformed JSON/SSE는 영구 `invalid-response`로 둔다.
벤더 간 라우팅과 예산은 호출자 소유다. 모든 API 시도는 요청의 `max_completion_tokens`를
그대로 받고 CLI는 적용 불가 사실을 영수증에 남긴다. response schema v1은 요청한
provider/model과 `model_reported`, `requested_*`, 표준 `usage`, `attempts`를 반환하며
`fallback_chain`은 없다. HTTP는 응답 model이 귀속을 증명하면 `usage: null`이어도 성공할 수
있고 영수증에 `not-reported`로 남긴다. usage가 유일한 귀속 채널인 subscription adapter는
usage가 없으면 fail-closed다. HTTP 응답 model이 요청 model과 다르면 fail-closed다. stream은 채택된 시도의 chunk만 공개하며
채택 전 16 MiB·미완성 frame 8 MiB·전체 64 MiB 상한을 적용한다. provider base override는
신뢰된 provider HTTPS origin만 허용하고 redirect는 거부한다.
response target은 request·env file·raw/portable receipt와 겹칠 수 없고 원자적으로 교체된다.
구독 생성은 내부 usage receipt를 caller sink와 분리하고 기존 raw/closed-portable writer로 caller
sink를 기록한다. HTTP 생성도 같은 raw/closed-portable sink를 기록한다. 영수증은
`transport=cli|api`로 가르고 CLI의 `vendor`와 API의 `provider`는 배타적이다. 실패는 core adapter
어휘에 `oversized-response`·`invalid-response`·`attribution-unavailable`·
`model-unavailable`·`payload-incompatible`을 더한
`failureClass`·`failureActor`·`remedy` 셋으로 반환한다.
HTTP 실패 response와 raw 영수증은 `retryAfter: { observed, value }`를 함께 반환한다.
`observed: true, value: null`은 `Retry-After` 헤더 부재, `observed: false`는 응답 헤더
미관측이며, 문자열 값은 수신 원문 그대로다.

**이관 공시:** 0.9.8 실패 어휘를 상수로 고정한 소비자는 갱신이 필요하다.
`no-output-timeout` class는 늘지 않았지만 payload 침묵 초과 actor는 `vendor`, 호출자가 명시한
전체 마감은 `caller`, 3600초 비용 상한은 `dispatcher`다. full jitter 때문에 재시도 대기도
호출마다 달라진다.

작은 `max_completion_tokens`는 빈 텍스트와 재시도 소진을 부를 수 있다(Zhipu 16 token 실측).
`gemini-2.5-flash`에서는 thinking 토큰이 16-token completion 예산을 먼저 잠식해 보이는
텍스트가 남지 않았다. subscription의 빈 출력 재시도는 실제 CLI를
다시 띄워 최대 `1 + max_retries`회(기본값이면 6회) spawn하므로, 반복 실행 비용이 진단 가치보다
크면 CLI transport의 `max_retries`를 낮춘다.

영수증은 요청과 실행을 나란히 비교할 수 있도록 `modelReported`·`effortRequested`·
`truncatedSuspected`·원본 stop 신호·`promptSource`·실측 `promptBytes`를 기록한다. raw CLI의
`argv`·`executable`은 실측 후 자격증명을 가리고, 프로세스가 없는 API 행은 `null`이다.

provider 생사·응답 진단은 다음처럼 명시적으로 한 번만 실행한다.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/provider-probe.mjs" --targets-json providers.json
```

`providers.json`은 `schema_version: 1`, `providers: [{ provider, model }]`, 선택적 `env_file`을
갖는다. 각 항목에 64-token·재시도 0회 요청을 기존 `--request-json` 경로로 보내고 status·
소요시간·`failureClass` 표를 출력한다. 프로브 결과는 저장·캐시하지 않고 대체 모델을 선택하지
않는다. 일반 raw/portable 영수증이 유일한 영구 증거다.

모델을 지정하고 벤더를 모르면 `--vendor`를 생략할 수 있다. 디스패처가 Codex
`models_cache.json`, `agy models`, Claude initialize control metadata, `grok models`를 대조해 자동
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

코드 리뷰는 같은 repo cwd에서 `--mode review`를 추가한다 — native `exec review`로 번역된다.
`--mode plan`은 승인된 non-sandbox native mapping이 없어 호출 전에 실패한다.

⚠ **Codex의 `--mode review`는 권한을 제한하지 않는다** — 리뷰 워크플로를 고를 뿐이다.
Codex CLI가 제공하는 권한 축소 수단은 샌드박스(`-s read-only`)뿐인데 이 프로젝트는 그걸
쓰지 않으므로, Codex 리뷰는 실제로는 `~/.codex/config.toml`의 `sandbox_mode` 그대로
돈다(실측: 영수증에 `danger-full-access`). 쓰기를 막는 것은 brief의 금지 지시뿐이다.
Claude·AGY의 review와 강도가 다르니 같은 안전장치로 취급하지 말 것.

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
  `--expect-output <ASCII-token, 최대 1024자>`을 함께 쓴다. 이 flag는 최대 12회 반복할 수 있으며 명령줄
  순서대로 모든 token을 stdout에서 literal 검사한다. token은 brief나 vendor argv로 보내지 않고,
  하나라도 없으면 dispatcher/receipt exit 4이며 stderr가 빠진 token 이름 전부를 낸다. token 원문은
  영수증에 남으므로 두 영수증 sink를 벤더가 읽을 수 있는 `--cwd` 아래나 다음 호출 입력으로 두지 않는다.
- 구획이 여럿인 호출은 `--expect-total <n>`으로 **전체 구획 수를 신고**한다(1~1000, `--expect-output`을 최소
  하나 요구). 판정에 쓰지 않고 영수증 `expectedTotal`에만 남으며 exit code를 바꾸지 않는다. **읽는 법은 셋이다** —
  `expectedTotal`이 `null`이면 **미신고**라 부분 등록 여부를 알 수 없고, `outputChecks.length`와 **같으면 전건 등록**,
  **크면 부분 등록**이다. 신고가 없으면 `outputCheckStatus: matched`만으로는 전 구획이 돌았는지 알 수 없다.
- `--model`은 디스플레이 라벨(`"Gemini 3.1 Pro (High)"`)이나 `agy models`가 출력하는 정규 slug(`gemini-3.1-pro-high`) 둘 다 유효하다. `agy models`는 slug를, 모델 피커 화면은 라벨을 보여준다. 형식이 깨졌거나 모르는 이름은 exit 1로 거부되니(구버전의 silent-downgrade 아님) 호출 후 exit code를 확인할 것.
- ⚠ **agy 1.1.26부터 reasoning effort가 별도 축이다**(실측 2026-08-31). `--model gemini-3.8-flash --effort low|medium|high`가 정식형이고, dispatcher가 `--effort`를 그대로 전달한다. 옛 접미사(`gemini-3.8-flash-low`)는 **단독으로는 아직 통한다.** 다만 **둘을 섞으면 exit 1**이고(`--model gemini-3.8-flash-low conflicts with --effort=high`), **접미사 없는 이름을 effort 없이 주면 그것도 exit 1**이다(`requires --effort`). 어느 쪽도 조용히 한쪽을 고르지 않는다 — 이긴 값을 추측하지 말고 exit code를 읽어라.
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

- 짧은 raw timeout은 없다. 공통 3600초 비용 상한에 닿으면 작업을 더 작은 요청으로 쪼갠다.
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

### Grok (SuperGrok 구독)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor grok --operation text \
  --brief brief.txt --cwd <작업 repo> --model grok-4.6 --effort medium \
  --out grok-result.json --err grok-stderr.txt
```

읽기 전용 plan/review는 `--mode plan|review`를 붙인다. 이미지 과업은 거부한다.

- brief는 `--prompt-file`로만 전달된다. stdin에는 넣지 않는다. `-p "프롬프트"` argv는 쓰지 않는다.
- Grok CLI의 `--effort`는 선택값이지만, **리뷰 표준 예시는 가성비 기준 `--effort medium`**을
  명시한다. dispatcher는 이 값을 Grok CLI의 `--effort`로 그대로 전달하며 영수증의
  `effortRequested`에서 요청값을 확인한다. 더 깊은 검토가 필요할 때만 caller가 명시적으로 올린다.
- `--request-json` 구독 생성은 stdout JSON의 `text` 필드를 응답 본문과 stream chunk로 쓴다. 전체 JSON을 본문이나 chunk로 쓰지 않는다.
- Windows에서 PATH에 `grok`가 없으면 `%USERPROFILE%\.grok\bin\grok.exe` fallback.
- 인증은 `grok login` (OAuth). API key 경로는 이 vendor 범위 밖이다.
- JSON `usage` 토큰이 없으면 subscription fail-closed. 전역 규율을 풀지 않는다.
- plan/review는 `--permission-mode plan` + `--tools read_file,grep,list_dir`. `--tools` 이름이 전부 틀리면 grok은 에러 없이 도구를 연다(실측). native `plan`이 그 바닥이다.
- **Linked Git worktree의 exact-diff 리뷰:** 이 mode에는 terminal·`git diff`가 없다. worktree의
  `.git`이 파일이면 `list_dir .git`은 실패하고 Grok이 부모 Git 관리 경로로 샐 수 있다. caller는
  brief의 `대상 내용`에 변경 파일 목록과 **exact unified diff 전문**을 넣고, `.git`·부모 repo·
  임의 `.scratch` 탐색 금지를 적는다. 이 증거가 없으면 호출하지 말고 brief를 다시 조립한다.
- plan/review spawn은 하네스 호환 env 13개를 `false`로 강제한다: `GROK_CLAUDE_*` 6, `GROK_CURSOR_*` 6, `GROK_CODEX_SESSIONS_ENABLED` 1. Codex의 나머지 칸은 grok에서 inert. 프로젝트 루트 `CLAUDE.md`는 그래도 남을 수 있다 — 상세는 adapter-grok.md. 호환을 켜서 검증하지 않는다. 검증은 꺼진 상태(`grok inspect` off, spawn env false)만.
→ 호출 전 필수: `references/adapter-grok.md`

## 오래 걸리는 호출 (60초+ 예상: 큰 brief, 병렬 다건)

Bash `run_in_background`로 띄우고 완료 알림 후 결과 수합. 사용자를 기다리게 하지 않는다.
**리뷰에는 300초 같은 짧은 `--timeout`을 절대 주지 않는다.** 30분을 넘는 리뷰도 있다. 기본
3600초는 완료 목표가 아니라 runaway 비용 백스톱이다. 백그라운드 job의 실행 상태와 `--err` 진행을 관찰하고, 종료 뒤 `--out`·exit·영수증을
대조한다. `exit 124`·빈 출력·영수증 부재는 **리뷰 없음이 아니라 실패**이며 findings나 패널 증거로
바꾸지 않는다.

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
6. **실행 영수증** — 벤더를 부른 뒤 한 줄로 관측을 남긴다: **요청 벤더·모델 → (알면) 실제 응답 backend → exit/timeout 상태 → 모델 대체가 거부됐으면 그 사실**. "요청 = 실행"을 가정하지 말고 실제 벌어진 것을 적는다 — 라벨 오형식 silent-ignore(모델이 조용히 계정 기본값으로 강등)를 이 영수증이 드러낸다. 순서는 위대로 고정하되 사람이 읽는 한 줄이면 된다(엄격 `Key: Value` 스키마는 불필요). 부르는 쪽(madi 등)이 지정 모델이 실제로 불렸는지 확인할 유일한 신뢰 근거다. 파일 영수증은 opt-in이며 `SECOND_OPINION_RECEIPT`에 JSONL 경로를 설정한다. Codex 호출은 `vendorUsage`과 `vendorUsageStatus`에 rollout 실측을 남기며, `null`은 호출하지 않았다는 뜻이 아니라 수집 불가일 수도 있다. **동시 dispatch 호출마다 서로 다른 `--err` 경로를 사용한다** — 경로를 재사용하면 뒤 호출의 truncate와 앞 호출의 append가 `session id:`를 섞어 사용량을 잘못 귀속시킬 수 있다.
   Claude 호출은 result JSON의 실제 model·token usage·cost를 `vendorUsage`에 남기며
   요청 model과 실제 family가 다르면 exit 4다. 선택적 `--expect-output` 호출은 영수증의 `outputCheckStatus`에 `matched`·`missing`·
   `not-requested`·`not-evaluated` 중 하나를 남기고, raw·portable 양쪽의 항상 존재하는
   `outputChecks`에는 명령줄 순서대로 원문 token과 `matched`·`missing` 상태를 남긴다. token을
   요청하지 않으면 `outputChecks`는 빈 배열이 아니라 `null`이다.
7. **portable 영수증** — raw 영수증은 재현용 locator를 보존하므로 저장소 밖에 둔다.
   `SECOND_OPINION_PORTABLE_RECEIPT`는 raw와 독립적으로 opt-in하는 누적 JSONL sink다. 닫힌
   typed emitter가 raw를 필터링하지 않고 조립해 **디스패처가 소유한 locator 필드**를 구조적으로
   배제한다. 자유 형식 vendor 문자열에는 민감한 텍스트가 남을 수 있으므로 공개 공유 전 내용을
   검토해야 한다.
   완료된 dispatch는 설정된 각 sink에 append를 한 번씩 독립 시도한다. portable I/O 실패는
   경로 없는 고정 경고만 남기는 fail-open이며 다른 sink나 dispatch exit를 바꾸지 않는다.
   정규화 후 같은 경로 또는 이미 존재하는 같은 파일은 spawn 전 exit 2지만, 이는 보안 경계가
   아닌 평범한 오설정 방지다. exit 집합은 `0`·`2`·`3`·`4`·`124` 그대로다. `ts`는
   타임스탬프일 뿐 상관 키가 아니다. 원자성·동일 행수·순서·행별 짝짓기와 항상 두 행을 보증하지 않는다.
   sink 해석 순서는 환경변수 > `~/.second-opinion/config.json`의 `receipt`·`portableReceipt` >
   없음이다. config가 없거나 깨졌으면 fail-open으로 무시하고 기본 경로를 만들지 않는다. config의
   정적 포인터와 실제 누적 JSONL 파일은 별개이며, 디스패처는 드라이브나 저장 위치 정책으로 경로를
   거부하지 않는다(기존 입출력 충돌 가드는 적용). `--lens-id`/JSON `lens_id`는 해석 없이 양쪽
   영수증에 기록하고 미지정이면 `null`이다.

## 사용량 (선택)

**이 스킬은 quota를 재지 않는다.** 사용량 계측은 호출자 소관이다 — madi 호출자는 `tools/usage-guard/`를 쓴다:
`node tools/usage-guard/checkpoint.mjs --provider <codex|claude|grok|antigravity>`, 전체는 `snapshot-all.mjs`.
벤더 OAuth source를 그 자리에서 읽는 advisory scheduler이고 gate가 아니라, 조회 실패가 작업을 막지 않는다.

⛔ **캐시된 수치로 잔량을 판단하지 마라.** 스냅샷에 시각이 붙어 있으면 그것부터 읽는다 —
그 시각 뒤에 돈 호출은 반영돼 있지 않다. 낡은 값을 근거로 「여유 있다」고 적으면 그것이 거짓 기록이다.

영수증끼리 사용량을 비교할 때 `totalTokens`를 그대로 쓰지 않는다. 캐시 입력이 포함되고 캐시분은
할인되므로 **캐시 사용량을 보고하는 CLI 영수증에서만** 다음 기준으로 비교한다:

```
비교 기준 = (inputTokens - cachedInputTokens) + outputTokens
```

`reasoningOutputTokens`는 `outputTokens`의 내역이므로 따로 더하지 않는다.
API provider는 캐시 입력을 보고하지 않는다(raw에는 `cachedInputTokens`가 없고 portable에는
`null`). 이 공식을 API에 그대로 옮기면 캐시 입력을 이중차감할 수 있다.
