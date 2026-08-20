# second-opinion

[English](./README.md) | **한국어**

Claude Code 안에서 **다른 벤더의 AI**(Codex/GPT, Antigravity/Gemini, Grok)를 일상어로 부려 쓰는
어댑터 스킬 — 점검·리뷰·의견부터 작업 오프로드, 이미지 생성까지.

**버전 0.9.11**

> "이 설계 코덱스로 점검받고 싶어" / "안티그래비티한테 물어봐" / "그록으로 봐줘" / "교차 검증해줘"
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

### 통합 생성 API

소비 프로젝트는 `dispatch.mjs --request-json <파일> --response-json <파일>`로 호출할 수
있다. 요청은 `system`과 `user`를 별도 JSON 필드로 유지하고 요청 provider/model만
지정한다. 디스패처는 provider를 바꾸지 않고 같은 provider만 제한적으로 재시도한다.
`max_retries` 기본값은 5(허용 0~16), 백오프는 2초에서 2배씩 늘어 60초에서 멈추며
full jitter를 적용한다. `Retry-After`가 없으면 0부터 계획 백오프까지, 있으면 스케줄링 값을
최대 3600초로 제한해 하한으로 쓰고 계획값과 하한 중 큰 값을 상한으로 삼아 대기를 뽑는다.
수신한 헤더 원문은 제한하지 않고 그대로 기록한다.
`silence_timeout_seconds`는 payload 침묵 임계이며 기본값 600초, 허용 범위 1~3600초다.
transport heartbeat·SSE 주석·빈 `data:`·공백 payload는 재장전하지 않고, 그 밖의 비어 있지
않은 payload는 재장전한다. 기존 `connect_timeout_seconds`·`read_timeout_seconds`도 침묵
임계 별칭으로 계속 받으며 둘 다 오면 큰 값을 쓴다. `silence_timeout_seconds`가 있으면 그 값이
우선한다. `timeout_seconds`는 호출자가 보낼 때만 총 경과 마감이고, 없으면 호출자 총 경과
상한도 없다. 디스패처의 60분(3600초) 비용 상한은 유지하며 재시도 sleep은 비용 시계에서 뺀다.
JSON/SSE 파싱에 성공하고 텍스트가 문자열로 존재하지만 공백뿐인
응답만 벤더의 일시 실패로 재시도한다. 텍스트 필드 부재·비문자열(`content: null` 포함)과
malformed JSON/SSE는 영구 `invalid-response`로 둔다. 벤더 간 라우팅과 예산은
호출자 소유라 `budget` 필드는 거부하고,
모든 API 시도에는 같은 `max_completion_tokens`를 보낸다. 응답은 요청한
`provider`/`model`, `model_reported`, 표준화된 `usage`, provider 원본 stop 신호,
`attempts`를 반환하며 `fallback_chain`은 없다. HTTP는 응답 model이 귀속을 증명하면
`usage: null`이어도 성공할 수 있다. usage가 유일한 귀속 채널인 subscription adapter는
usage가 없으면 계속 실패한다. HTTP 응답 model이 요청과 다르면 실패한다.
스트림은 채택된 시도의 chunk만 공개하고 공개 전 채택 버퍼를 16 MiB로 제한한다(기존 미완성
frame 8 MiB·전체 stream 64 MiB 가드도 유지). provider base override는 해당 provider의
신뢰된 HTTPS origin 안에서만 허용하고 redirect는 거부한다. response target은
request·provider env file·두 receipt sink와 겹칠 수 없고 원자적으로 교체된다. HTTP와 구독
생성 모두 설정된 raw·closed-portable 영수증을 기록한다.
HTTP 실패 response와 raw 영수증은 `retryAfter`를 `{ observed, value }`로 기록한다.
`value`는 수신한 `Retry-After` 원문이고, `observed: true`이면서 `value: null`이면 헤더가
없었으며, `observed: false`이면 응답 헤더를 관측하지 못했다는 뜻이다.

0.9.8 실패 어휘를 상수로 고정한 소비자는 연동 코드를 갱신해야 한다.
`no-output-timeout` class는 그대로지만 payload 침묵 초과의 `failureActor`는 `vendor`, 호출자가
명시한 전체 마감 초과는 `caller`, 3600초 비용 상한 도달은 `dispatcher`다. 재시도 대기도
호출마다 달라진다.

`max_completion_tokens`가 너무 작으면 텍스트가 남지 않아 같은 provider 재시도를 소진할 수
있다(Zhipu에서 16 token으로 실측). `gemini-2.5-flash`에서는 thinking 토큰이 16-token
completion 예산을 먼저 잠식해 보이는 텍스트가 남지 않았다. subscription
빈 출력의 재시도는 CLI 프로세스를 다시 띄우므로 최대 `1 + max_retries`회(기본값이면 6회)
spawn한다. 반복 CLI 호출 비용이 진단 가치보다 크면 `max_retries`를 낮춘다.

- **자연어 트리거** — "코덱스로 점검", "제미나이로 봐줘", "다른 AI 시각으로", "second opinion"
- **벤더 자동 제안** — 지정 안 하면 작업 성격으로 고른다: 코드 리뷰·기술 감사 → Codex /
  빠른 다각 점검·문서 검토·볼륨 호출 → Gemini / 중요 판단 → 둘 다 병렬 후 대조
- **실측 기반 gotcha 내장** — 아래 함정들을 스킬이 알아서 피한다

| 함정 (전부 실측) | 스킬의 처리 |
|---|---|
| `agy -p "<텍스트>"`는 stdin을 안 닫으면 **무한 hang** + argv라 **30,000자 한계** | brief를 stdin으로 전달(`-p - < brief.txt`) — hang 없음, 105KB 실측 통과 |
| `--model`은 디스플레이 라벨(`"Gemini 3.1 Pro (High)"`)과 `agy models`의 정규 slug(`gemini-3.1-pro-high`) 둘 다 유효(agy 1.1.5). `agy models`는 slug를, 피커는 라벨을 보여줌. 모르는·깨진 이름은 **exit 1로 loud reject**(구버전은 조용히 강등) | 어느 출처든 그대로 복사하고 exit code 확인 |
| subprocess·영수증 cwd가 temp여도 AGY가 이전 host project를 계속 사용할 수 있음 | 모든 AGY 호출에 요청 workspace를 `--add-dir`로 결속하고, 필요하면 `--expect-output`으로 hidden token 읽기를 검사 |
| `terra`·`gpt 5.5`·`5.6 sol@ultra`처럼 입력했지만 Codex CLI는 현재 정규 slug를 요구 | 대소문자·구분자와 UI effort 명칭을 정규화하고 Codex live cache에서 해석(`terra` → `gpt-5.6-terra`). 선택 모델이 광고한 effort만 허용(`low`부터 `ultra` 중 지원값) |
| `opus`·`opus 4.8`·`fable`처럼 모델명만 알고 벤더는 모름 | cache-first Codex·AGY·Claude 메타데이터를 대조. 공급자가 직접 광고한 `opus`는 최신 별칭으로 유지하고 display에서 유도한 `fable`은 `claude-fable-5`로 전달. 버전명은 고정 family 표가 아니라 현재 메타데이터에서 유도 |
| `opus 4.6`·`sonnet 4.6`이 Claude Code와 AGY 양쪽에 존재 | AGY의 정확한 카탈로그 항목이 Claude의 family/version 추론보다 우선. `--vendor` 생략 시 `Claude Code opus 4.6`, 또는 `--vendor claude --model claude-opus-4-6`으로 Claude 선택 |
| 호출마다 공급자 카탈로그를 조회하면 시작·네트워크 시간이 낭비됨 | 모델 메타데이터만 `~/.second-opinion/model-catalog-v1.json`에 24시간 캐시. fresh cache miss는 1회 갱신하고 실패하면 last-known-good를 쓰되 5분 후 재시도. 이미 로컬인 Codex cache는 현재 `CODEX_HOME`에서 다시 읽음 |
| Windows에서 codex sandbox의 **파일 읽기 불능** | "파일 읽어봐" 대신 내용을 brief에 발췌 동봉 |
| 이미지 생성: agy는 **지정 저장 위치를 무시**(자기 scratch 폴더에 저장), codex는 **쓰기 샌드박스 필요** + Windows 복사 실패 가능 | 벤더별 실제 산출물 위치를 알고, 파일 존재를 직접 확인 후 원한 위치로 옮김 — 벤더의 "저장했다"를 성공으로 안 침 |
| "이상 없음"은 약한 신호(특히 Gemini의 false-negative 편향) | "문제를 못 찾음 ≠ 문제 없음" 명시 전달 |
| Grok `--tools`는 이름이 전부 틀리면 조용히 열린다. Grok은 Claude/Cursor 하네스 설정을 기본으로 읽는다 | plan/review는 `--permission-mode plan`을 바닥으로 쓰고 격리 env 13개 강제(Claude 6 + Cursor 6 + `GROK_CODEX_SESSIONS_ENABLED`). 프로젝트 루트 `CLAUDE.md`는 남을 수 있다 |
| Grok 리뷰 예시가 reasoning effort를 빼면 벤더 기본값으로 조용히 실행됨 | 표준 리뷰 예시는 가성비 기준 `--effort medium`을 명시. dispatch가 그대로 전달하고 영수증의 `effortRequested`에 요청값을 남김 |
| linked Git worktree의 exact current diff를 Grok/AGY에 리뷰시킴 | explicit review에는 git shell이 없고 worktree `.git`은 파일일 수 있음. Git 메타데이터 탐색을 맡기지 말고 변경 파일 목록과 unified diff 전문을 brief에 넣음 |

- **실행 영수증** — 벤더를 부른 뒤 관측한 것을 한 줄로 남긴다: 요청한 벤더·모델,
  알 수 있으면 실제 응답 backend, exit/timeout 상태, 거부된 대체가 있었으면 그 사실.
  **요청과 실행은 다르다** — 모델 라벨이 조용히 무시돼 계정 기본값으로 강등된 경우가
  여기서 드러난다.

  기계로 읽어야 하는 호출자는 `SECOND_OPINION_RECEIPT`에 파일 경로를 주면 된다.
  호출마다 JSON 한 줄이 append된다 — 벤더·작업·입력 `modelRequested`·정규화된
  `model`·effort·exit·소요시간, 그리고
  **프로세스가 실제로 떴는지** 여부. Codex 호출은 Codex 자신의 세션 로그에서 읽은
  실측 토큰(입력·캐시된 입력·출력·추론·총계·컨텍스트창·쿼터 소진율)도 함께 남는다.
  선택적 `--expect-output <ASCII token>` 호출은 token 자체를 기록·전송하지 않고
  `outputCheckStatus`만 남긴다. token이 없으면 raw output을 보존하고 exit 4다.

  raw 영수증은 재현을 위해 `cwd`·`outPath`·`errPath`·`pid`를 그대로 보존하므로 반드시
  저장소 밖에 둔다. `SECOND_OPINION_PORTABLE_RECEIPT`는 raw와 독립적으로 설정하는 누적
  portable JSONL sink다. 닫힌 typed emitter가 raw를 필터링하지 않고 조립하므로
  **디스패처가 소유한 locator 필드**가 구조적으로 배제된다. 다만 자유 형식 vendor 문자열에는
  민감한 텍스트가 남을 수 있으므로 공개 공유 전 내용을 검토해야 한다.

  sink 해석은 환경변수 > `~/.second-opinion/config.json`의 `receipt`·`portableReceipt` >
  없음 순서다. config 부재·파손은 무시하고 기본 경로를 만들지 않으며 드라이브 정책도 강제하지
  않는다. 해석된 경로에는 기존 입출력 충돌 가드가 그대로 적용된다. 모든 행은
  `transport`(`cli`|`api`)를 기록하고 CLI에서만 `vendor`, API에서만 `provider`가 채워진다.
  raw CLI 행은 실측하고 자격증명을 가린 `argv`와 해석된 `executable`을 기록하며, 프로세스가
  없는 API 행은 둘 다 `null`이다. 영수증은 기존 정규화 값 옆에 `modelReported`·
  `effortRequested`·`truncatedSuspected`·provider 원본 stop 신호·`promptSource`·실측
  `promptBytes`를 기록한다. `lensId`는 `--lens-id` 또는 JSON
  `lens_id`를 해석 없이 보존하며 미지정이면 `null`이다. 시도 수·실제 대기·성공 시도·토큰 상한
  적용 여부·실패 class/actor/remedy도 남긴다. 실패 어휘는 `oversized-response`·
  `invalid-response`·`attribution-unavailable`·`model-unavailable`·
  `payload-incompatible`를 구별하며 기존 `usage-unavailable`도 계속 허용한다.

  완료된 dispatch는 설정된 각 sink에 append를 한 번씩 독립 시도한다. portable I/O 실패는
  경로 없는 고정 경고만 남기는 fail-open이며 다른 sink나 dispatch exit를 바꾸지 않는다.
  정규화 후 같은 경로이거나 이미 존재하는 같은 파일이면 spawn 전 exit 2로 거부하지만 이는
  평범한 오설정 방지이지 보안 경계가 아니다. exit 집합은 `0`·`2`·`3`·`4`·`124` 그대로다.
  `ts`는 타임스탬프일 뿐 상관 키가 아니다. 두 파일의 원자성·동일 행수·순서·행별 짝짓기를
  보증하지 않으며 한 dispatch가 항상 두 행을 만든다고 주장하지 않는다.
  `--vendor claude`도 같은 dispatcher를 사용하며, 폐기된 280초
  셸 timeout을 쓰지 않는다. 기본 60분(3600초) 비용 상한은 일반 리뷰 마감이 아니다. 리뷰에
  300초 같은 짧은 `--timeout`을 절대 주지 않는다. 30분을 넘는 리뷰도 있다.
  오래 걸리는 호출은 백그라운드로 두어 job 생사와 `--err` 진행을 관찰한 뒤 완성된 출력과 영수증이
  있을 때만 findings를 채택한다. Claude result JSON의 실제 model·token usage·cost를
  `vendorUsage`에 결속하고 빈/깨진/다른 모델 출력은 exit 4로 거부한다. 디스패처는 중립
  broker로서 동일 벤더 호출을 기계 차단하지 않으며, 리뷰 독립성 인정 여부는 호출자
  방법론(Madi 등)이 영수증을 대조해 판정한다. Claude child는 `--safe-mode`로 실행해
  대상 프로젝트의 CLAUDE.md·훅·플러그인·MCP가 inline review brief를 덮어쓰지 못하게
  하고, 부모 전용 `CLAUDECODE` marker는 child 환경에서 제거해 의도한 nested 호출이
  vendor CLI에서 다시 거부되지 않게 한다. `--safe-mode`는 **구성 격리이지 filesystem
  sandbox가 아니며** full-access와 공존한다 — 모든 mode에서 그대로 켜져 있다.
  기본값은 꺼짐이며, 설정 안 하면 아무것도 쓰지 않는다.

  text 호출에는 caller가 `--mode plan` 또는 `--mode review`를 명시할 수 있다. 두 mode는
  같은 실제 project cwd 전체를 유지한다. Claude는 plan/review identity를 receipt에 각각
  보존하되 native plan workflow 없이 closed `Read,Glob,Grep` allowlist만 사용한다.
  sandbox·worktree·snapshot·축약 packet을 만들지 않는다.

  **mode가 실제로 얼마나 조이는지는 벤더마다 다르고, Codex에서는 아무것도 조이지 않는다.**
  Claude는 `--tools` allowlist로, AGY는 native plan + 읽기 전용 입력 프로필로 쓰기 도구를
  없앤다. 그런데 Codex CLI에는 그 층이 없다 — 권한을 좁히는 수단이 샌드박스
  (`-s read-only`)뿐이고 이 프로젝트는 샌드박스를 쓰지 않는다. Codex의 `exec review`는
  리뷰 워크플로를 고르는 것이지 권한 수준이 아니다(`codex exec review --help`의 옵션도
  `--uncommitted`·`--base` 같은 대상 지정뿐이다). 실측: `--mode review`로 부른 Codex
  호출의 영수증에 `sandbox: danger-full-access`가 그대로 찍혔고, 그 값은 mode가 아니라
  `~/.codex/config.toml`에서 온다. Codex 리뷰에서 파일을 지키는 것은 brief의 금지 지시뿐이니
  `--mode review`를 안전장치로 계산하지 말 것. Grok plan/review는 Codex보다 강하다 —
  `--permission-mode plan`과 닫힌 `--tools` allowlist. 도구 이름이 전부 틀리면
  fail-open이므로 `plan`이 바닥이다. `--mode`를 생략하면 기존 default 호출이며, Claude에서는 이것이 **full-access**
  호출이다 — 모든 기본 도구와 비대화형 실행을 caller가 준 실제 cwd에서 갖는다. 읽기 전용은
  명시적 `--mode plan|review`에서만 생기고, 권한 분리는 오직 flag 조합으로만 이뤄진다.
  receipt에는
  `requestedMode`·`effectiveMode`·`inputProfile`이 기록된다. 명시 mode의 출력이 비면 exit
  4로 실패한다. AGY explicit plan/review는
  `agy-native-readonly/v1` 입력 profile을 자동 적용한다. 따라서 평범한 brief에
  `git diff`가 있어도 headless shell 대신 native 읽기·목록·검색으로 처리한다.

  **CLI 영수증**으로 모델 비용을 비교한다면
  `(inputTokens - cachedInputTokens) + outputTokens`로 계산한다.
  `reasoningOutputTokens`를 따로 더하면 안 된다 — `outputTokens`에 이미 포함돼 있다.
  API provider는 캐시 입력 사용량을 보고하지 않는다(raw usage에는 `cachedInputTokens`가 없고
  portable shape에서는 `null`). 이 공식을 그대로 옮기면 캐시 입력을 이중차감할 수 있다.

## 요구사항

- **Claude Code** (스킬 실행 호스트)
- **Codex CLI** — `npm install -g @openai/codex` 후 `codex login` (ChatGPT 계정 또는 API 키)
- **Antigravity CLI (`agy`)** — Windows PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`
  (macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash` /
  Windows CMD: `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd`) 후 Google 계정 로그인.
  **v1.0.15 이상 필수** — 그 이전 버전은 Windows 비-TTY에서 출력이 조용히 유실된다(수정된 버그)
- **Grok CLI** — Windows PowerShell: `irm https://x.ai/cli/install.ps1 | iex` 후
  `grok login` (SuperGrok OAuth). 텍스트만. 이미지 과업은 거부한다.
- 둘 중 하나만 있어도 그 벤더는 동작한다. Grok도 같은 식으로 선택이다.

### API provider (생성 경로 전용) — 선택

위 CLI 벤더는 각 CLI가 자체 인증을 쓰므로 **키가 필요 없다.** 키는 `--request-json`의
**API transport**에만 쓰인다 — HTTP provider 하나에 직접 붙는 경로다. 6종을 지원한다.

| provider | 키 변수 | 기본 base URL |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| NVIDIA NIM | `NVIDIA_NIM_API_KEY` | `https://integrate.api.nvidia.com/v1` |
| Gemini (AI Studio) | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` |
| Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` |
| GitHub Models | `GITHUB_MODELS_API_KEY` | `https://models.github.ai/inference` |
| Zhipu (Z.ai / GLM) | `ZHIPU_API_KEY` | `https://api.z.ai/api/paas/v4` |

provider마다 `<PROVIDER>_BASE_URL`도 받으며 모델은 항상 요청 JSON에서 온다. base URL
재정의는 **그 provider의 신뢰 HTTPS origin 안에서만** 허용되고, 벗어나면 요청이 나가기 전에
거부된다.

provider를 한 번 진단하려면
`{ "schema_version": 1, "providers": [{ "provider": "...", "model": "..." }], "env_file": "..." }`
JSON을 만들고 `node plugins/second-opinion/scripts/provider-probe.mjs --targets-json <파일>`을
실행한다. 나열한 provider마다 기존 `--request-json` 경로로 64-token·재시도 0회 요청을 한 번
보내고 provider·model·status·소요시간·`failureClass` 표를 출력한다. 결과를 캐시하거나 대체
모델을 고르지 않으며, 설정된 일반 영수증만 영구 증거로 남는다.

```bash
cp .env.local.sample .env.local   # 쓰는 provider만 채운다
```

**디스패처는 `.env.local`을 스스로 읽지 않는다.** 요청 JSON의 `env_file`로 경로를 넘기면
그때 읽는다. 키 **값**은 argv·영수증·로그·에러·문서 어디에도 실리지 않으며, 어댑터는 변수
**이름**만 선언한다. `.env.local`은 함께 배포되는 `.gitignore`가 추적에서 제외하고,
커밋되는 것은 `.sample` 템플릿뿐이다.

필요한 것만 채우면 된다. 키가 없는 provider를 지목하면 `auth-failed`/`user`로 실패하며,
**다른 provider로 넘어가지 않는다** — 설계상 폴백이 없다.

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

Claude 이외의 호스트에서는 그 호스트의 available-skills 카탈로그가 제공한 정확한 스킬
경로를 사용한다. root alias와 상대 경로를 그대로 결합하며, 캐시에서 marketplace/plugin
이름이 반복되는 것은 정상이다. 경로 단계를 합치거나 버전 디렉터리를 재구성하지 않는다.
Windows PowerShell 5.1에서는 `Test-Path -LiteralPath`로 정확한 경로를 확인한다.
`rg --files ... | rg '...$'`의 빈 결과만으로 스킬이 없다고 판정하면 안 된다.

### C. 수동 복사

```bash
git clone https://github.com/stepbyjason-lab/second-opinion
cp -r second-opinion/plugins/second-opinion/skills/second-opinion ~/.claude/skills/
```

## 사용 예

Madi에서 가장 자주 쓰는 리뷰는 대상·근거·수정 금지·영수증을 한 번에 명시하면 된다.

```
현재 변경을 Codex로 Madi 리뷰해줘. 현재 worktree를 점검해 P0~P3 findings를 파일/줄
근거와 번호 목록으로 보고하고, 파일은 수정하지 말고 실행 영수증도 돌려줘.
```

독립 2차 패스는 같은 brief와 대상을 유지한 채 다른 벤더를 지정하고, 두 영수증이 나온 뒤에만
findings를 대조해 달라고 요청한다.

linked Git worktree의 current diff를 Grok이나 Antigravity에 리뷰시킬 때는 brief에 변경 파일 목록과
unified diff 전문을 넣는다. 이 explicit review mode에는 `git diff`가 없으므로 `.git`, 부모 저장소,
임의 scratch 디렉터리를 뒤져 대상을 재구성하라고 시키지 않는다.

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
```
이 부분 그록으로도 봐줘
```

## 데이터 경계 (중요)

**brief에 담은 내용은 통째로 외부 벤더(OpenAI/Google/xAI)에 전송된다.**
스킬은 시크릿·자격증명·원시 repo 덤프를 brief에 넣지 않도록 지시받지만,
최종 책임은 사용자에게 있다. 민감한 코드베이스에서는 발췌 범위를 직접 확인하라.

## 정직한 한계

- 벤더 CLI의 **로컬 인증 상태**를 그대로 쓴다 — 로그인이 만료되면 호출이 실패하고, 스킬은 그 사실을 그대로 보고한다(성공 위장 없음). 벤더를 **지명**했다면 설치/로그인 안내 후 재시도를 제안한다 — 조용히 다른 리뷰어로 대체하지 않는다(대체는 동의 시에만)
- 사용량은 각 벤더 구독의 quota를 소모한다
- 세션 이관·백그라운드 잡 관리 같은 무거운 기능은 없다 — 그건 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)(공식, Apache-2.0)를 병행 설치하면 된다. 이 스킬과 배타적이지 않다
- Windows(Git Bash)에서 실측 검증됐다(이미지 생성 포함). macOS/Linux는 동일 명령 구조지만 이 저장소 시점엔 미실측이다

## 라이선스

[MIT](./LICENSE)
