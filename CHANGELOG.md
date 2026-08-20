# Changelog

## Unreleased

- Documentation: add a Madi-centered review fast path to dispatcher help, the
  skill, and both READMEs. It shows the explicit `--mode review` invocation,
  preserves the no-edit requirement, and explains how to make an independent
  second pass without changing the review target.
- Documentation: make Grok review effort explicit across help and examples.
  The standard Madi review baseline is `--effort medium` for cost/quality
  balance; the dispatcher forwards it unchanged and records the request.
- Documentation: require an exact changed-file list and unified diff in the
  brief for Grok/AGY current-diff reviews of linked Git worktrees. Their explicit
  review modes lack a git shell, so callers must not ask them to discover `.git`
  metadata or reconstruct the diff from scratch directories.

## 0.9.11 — 2026-08-19

- SuperGrok OAuth 구독 CLI vendor `grok`을 dispatcher에 추가했다. 기존
  `codex` / `agy` / `claude` argv·mode 매핑은 그대로다. brief는 `--prompt-file`로만
  넘기고, JSON `usage` 토큰으로 귀속하며, image 과업은 거부한다. Windows는
  `%USERPROFILE%\.grok\bin\grok.exe` fallback을 쓴다.
- Grok 호출은 stdin에 brief를 중복 쓰지 않는다. portable `USAGE_SOURCES`에
  `grok-result-json`을 넣고, `$grok`/`${grok}` 직접 호출도 enforcement가 잡으며,
  구독 generation은 JSON `text`만 응답 본문과 stream chunk로 쓴다.
- Grok `--mode plan|review`는 `--permission-mode plan`을 `--tools`와 함께 건다.
  `--tools` 이름이 전부 틀리면 grok이 도구를 여는 실측(fail-open)에 대한 바닥이다.
- Grok plan/review spawn은 하네스 호환 env 13개를 `false`로 강제한다:
  `GROK_CLAUDE_*` 6, `GROK_CURSOR_*` 6, `GROK_CODEX_SESSIONS_ENABLED` 1.
  Codex의 다른 칸은 grok에서 inert라 sessions만 끈다. `~/.grok/config.toml`은
  쓰지 않는다. 프로젝트 루트 `CLAUDE.md`는 compat를 꺼도 남을 수 있다.
  호환 on으로 덮기를 실측하지 않는다 — on은 세션을 죽인다. 검증은 꺼진 상태만.

## 0.9.10 — 2026-08-17

- Generation requests now use payload silence as the liveness signal through
  `silence_timeout_seconds` (default 600 seconds, range 1–3600). Heartbeats, SSE comments,
  empty data fields, and whitespace do not reset silence. Legacy
  `connect_timeout_seconds`/`read_timeout_seconds` fields remain accepted as aliases and
  use the larger value when both are present. `timeout_seconds` is now an optional caller
  deadline; omitting it removes the caller total-time cap. Silence is attributed to the
  vendor, while the 3600-second cost backstop is attributed to the dispatcher and excludes
  retry sleeps. Work that reaches the cost cap must be split into smaller requests. A
  confirmed success is no longer replaced by a later `env_file` reread failure.
- Same-provider retries now use full jitter while preserving `Retry-After` as a lower
  bound capped at 3600 seconds for scheduling. HTTP failure responses and raw receipts
  still expose the unchanged raw header observation and
  distinguish an absent header from unobserved response headers. Consumers that froze
  the 0.9.8 failure vocabulary as a constant must update their integration; retry waits
  are intentionally no longer a fixed sequence.

## 0.9.9 — 2026-08-16

- Receipts now place requested and executed evidence side by side without changing raw
  schema v1 or portable schema v2: `modelReported`, `effortRequested`, normalized and raw
  stop signals, `promptSource`, measured `promptBytes`, and matching attempt counts. Raw
  CLI rows add measured, credential-redacted `argv` and `executable`; API rows retain
  truthful `null` process fields and portable rows retain no locators.
- Repaired mixed Gemini `parts` extraction and restored empty `parts` to same-provider
  transient retry. Real subprocess timeout 124 and stable receipt-config guards remove
  two silent-success paths. HTTP 404/410 and payload-shape failures now preserve vendor
  versus dispatcher responsibility instead of blaming the caller or retrying unchanged
  payloads.
- HTTP generation may return attributed model output with `usage: null`, recorded as
  `not-reported`; subscription paths still require usage when it is their attribution
  evidence. The subscription failure label is now `attribution-unavailable`.
- Added `provider-probe.mjs`, a one-shot, no-cache/no-substitution diagnostic that sends
  one minimal request per configured provider through `--request-json` and prints status,
  duration, and failure class. Removed the unused `<PROVIDER>_MODEL` sample/documentation;
  request JSON remains the model source. No release or deployment was performed.

## 0.9.8 — 2026-08-15

- Corrected the unified `--request-json/--response-json` generation scope: one request
  now contacts exactly its named provider. Cross-provider order, fallback, attempt
  budgets, and token slicing were removed; bounded same-provider retry remains
  (default 5 retries, 2s exponential backoff capped at 60s, `Retry-After`, separate
  30s connect/120s read limits, and one absolute deadline). Only successfully parsed
  JSON/SSE with a present empty string is retried as a transient vendor failure;
  missing/non-string text (including `content: null`) and malformed JSON/SSE remain
  permanent invalid responses.
- Generation rejects caller `budget`, accepts `max_retries` and opaque `lens_id`, returns
  `attempts` instead of `fallback_chain`, preserves the same completion-token limit on
  every API attempt, and fails closed on incomplete usage or an HTTP model mismatch.
- Accepted streaming content is buffered up to 16 MiB before publication; overflow is
  a permanent `oversized-response`. Failure results and receipts record class, actor,
  remedy, attempts, actual waits, and the successful attempt.
- Provider base overrides are restricted to each provider's trusted HTTPS origin and
  HTTP response bodies are excluded from external errors. Response output is atomic
  and cannot alias the request, env file, or raw/portable receipt sinks.
- HTTP generation receipts now use the same raw and closed-portable sinks. They cover
  both CLI and HTTP transports, separate
  CLI `vendor` from API `provider`, preserve `lensId`, and mark nonexistent HTTP process
  fields as `null`. Sink resolution is env > `~/.second-opinion/config.json` > none;
  missing or malformed config remains fail-open. UTF-8 BOM on provider env files is
  handled by the existing line `trim()`; the redundant explicit BOM replacement was removed.

## 0.9.7 — 2026-08-12

- **독립 portable JSONL sink 추가.** `SECOND_OPINION_PORTABLE_RECEIPT`는 raw와 별개로 opt-in하는
  누적 형제 sink다. 완료된 dispatch는 설정된 각 sink에 append를 한 번씩 독립 시도하며, 한쪽
  I/O 실패는 경로 없는 고정 경고만 남기고 다른 쪽과 dispatch exit를 바꾸지 않는다.
- raw `SECOND_OPINION_RECEIPT`의 v1 키·값·locator·append·fail-open 동작은 설치된 0.9.6과
  동일하다. portable은 raw를 필터링하지 않고 닫힌 typed emitter로 조립해 **디스패처가 소유한
  locator 필드**를 구조적으로 배제한다. 자유 형식 vendor 문자열에는 민감한 텍스트가 남을 수
  있으므로 공개 공유 전 내용 검토가 필요하다.
- raw와 portable이 정규화 후 같은 경로이거나 이미 존재하는 같은 파일이면 spawn 전 exit 2로
  거부한다. 이는 평범한 오설정 방지이며 보안 경계가 아니다. exit 집합은 계속
  `0`·`2`·`3`·`4`·`124`다.
- `ts`는 타임스탬프일 뿐 상관 키가 아니다. 두 파일의 원자성·동일 행수·순서·행별 짝짓기를
  보증하지 않으며, 한 dispatch가 항상 두 행을 만든다고 주장하지 않는다.

## 0.9.6 — 2026-08-11

- **문서: `--mode review`의 강도가 벤더마다 다르다는 사실을 명시**. 표와 산문이
  "읽기 전용 리뷰"를 세 벤더 공통인 것처럼 서술해, 호출자가 Codex 리뷰도 권한이
  제한된다고 오해했다. 실제로는 Claude만 `--tools` allowlist로, AGY만 native plan +
  읽기 전용 입력 프로필로 쓰기 도구를 없앤다.
- **Codex는 권한을 제한하지 않는다 — Codex CLI의 한계다.** 권한을 좁히는 수단이
  샌드박스(`-s read-only`)뿐인데 이 프로젝트는 샌드박스를 쓰지 않는다(맥락 전달이
  어렵고 결과 품질이 떨어진다). `codex exec review --help`의 옵션도 `--uncommitted`·
  `--base`처럼 대상 지정뿐이라, `exec review`는 워크플로 선택이지 권한 수준이 아니다.
- 실측 계기: `--mode review`로 부른 Codex 호출의 영수증에 `sandbox: danger-full-access`가
  그대로 찍혔다. 그 값은 mode가 아니라 `~/.codex/config.toml`의 `sandbox_mode`에서 온다.
  Codex 리뷰에서 파일을 지키는 것은 brief의 금지 지시뿐이다.
- 코드 변경 없음. SKILL.md·adapter-codex.md·README 양본만 수정.

## 0.9.5 — 2026-08-02

- 긴 코드베이스의 고추론 작업이 완료 직전에 잘리지 않도록 공통 기본 timeout을
  1800초에서 2700초(45분)로 늘렸습니다. 명시적 `--timeout` 범위는 기존과 동일하게
  1~3600초이며, AGY의 `--print-timeout`에도 같은 값이 전달됩니다. CLI 도움말, 소스
  주석, SKILL, Claude 어댑터, 양쪽 README와 테스트를 함께 갱신했습니다.

## 0.9.4 — 2026-08-02

- 설치된 Codex/Claude 플러그인 캐시에서도 테스트 모음이 저장소 작업 디렉터리나
  루트 README에 의존하지 않고 실행되도록 경로 확인을 모듈 위치 기준으로 변경했습니다.
  공개 소스 스냅샷에서는 영문·한글 README 쌍을 계속 검증합니다. 런타임 라우팅
  동작, CLI 도움말, 영수증 형식에는 변경이 없습니다.

## 0.9.3 — 2026-08-02

- **Cache-first provider catalogs.** Automatic routing caches model-only metadata
  for 24 hours in `~/.second-opinion/model-catalog-v1.json`. Fresh hits launch no
  provider process; a fresh miss forces one refresh. Failed refreshes retain
  last-known-good data and retry after five minutes, while incomplete first
  discovery still fails closed. The active `CODEX_HOME` cache is re-read locally
  so models do not bleed between Codex environments. Process-backed metadata
  discovery is bounded to 20 seconds and 8 MB per provider.
  Explicit `--vendor` bypasses discovery and cache refresh.
- **Ranked, version-aware routing.** Case and separators are normalized. Exact
  provider entries outrank dynamically inferred Claude family/version names:
  `opus` stays Claude's latest alias, `opus 4.8` becomes `claude-opus-4-8`, and
  display-derived `fable` becomes the advertised canonical `claude-fable-5`;
  the exact AGY entries make bare `opus 4.6` and `sonnet 4.6` route to AGY. `Claude Code opus 4.6`
  or explicit `--vendor claude` selects Claude. `terra`, `gpt 5.5`, and `5.5`
  resolve through the current Codex catalog. No fixed model-family table was added.
- **Current effort names.** Codex recognizes `max` and `ultra` where the selected
  model advertises them; UI labels normalize as `light`→`low`, `very-high`→`xhigh`,
  and `maximum`→`max`.
- Claude catalog discovery now uses the CLI initialize control metadata rather
  than scraping `--help`. Only model fields are retained; account metadata is
  discarded. Receipt schema remains version 1 and no public option was added.

## 0.9.2 — 2026-08-01

- **Default model-to-vendor routing.** When `--vendor` is omitted, `--model` is
  matched against the current Codex cache, `agy models`, and Claude help catalog.
  One matching vendor is selected; zero or multiple vendors, or an unreadable
  catalog, fail closed. An explicit `--vendor` still wins.
- **Future-proof Claude alias binding.** Result validation now uses exact and
  boundary-based alias matching instead of a hardcoded Opus/Sonnet/Haiku list,
  so aliases such as `fable` bind correctly to `claude-fable-5`.
- No new option or receipt schema was added.

## 0.9.1 — 2026-07-31

- **Claude default is full access again.** `--vendor claude` without `--mode` now
  runs with `--dangerously-skip-permissions --tools=default` — every built-in
  tool plus non-interactive execution — instead of the empty `--tools=`
  allowlist. Explicit `--mode plan|review` is unchanged and stays read-only on
  `--tools=Read,Glob,Grep`.
- **Why it was broken.** The empty allowlist was never a general-purpose
  decision. `f6b6953` introduced `--tools=` as a review-only minimal bridge when
  Claude first entered the dispatcher; `60a760f` added explicit plan/review and
  preserved that temporary constraint in the `else` branch, freezing it into the
  general contract; `6a83b66` repaired only the review identity and left the
  tool-less default out of scope. The result was a general call weaker than the
  read-only modes: anything asked to implement had to ship its patch as output
  text. This was a design regression inherited from a review bridge — not a
  missing sandbox and not a missing mode.
- **Measured.** In an isolated temporary directory, one default call created a
  file, modified it, and ran a command, all successfully; the receipt recorded
  `default/default`, `invoked=true`, `exit=0`, `vendorUsageStatus=ok`.
- `--safe-mode` stays on in every mode. It is configuration isolation (the
  target project's CLAUDE.md, hooks, plugins, and MCP servers), not a filesystem
  sandbox, and it coexists with full access. No sandbox, worktree, snapshot, or
  rewritten cwd is used as the permission model — the split is flags alone, and
  every mode runs in the caller's real cwd.
- Regression tests pin the split: default carries no empty `--tools=`, carries
  `--tools=default` and `--dangerously-skip-permissions`, and never inherits
  `--permission-mode` or the `Read,Glob,Grep` allowlist; plan/review keep the
  closed allowlist and never expose `Write`, `Edit`, `Bash`, `PowerShell`, or
  `Agent`; omitting `--mode` still records `default/default` with
  `inputProfile=none`.
- No new mode was added, AGY and Codex argv are unchanged, and the receipt schema
  version remains 1.

## 0.9.0 — 2026-07-29

- **Codex model normalization.** `--model luna@high` now separates a recognized
  final effort token and resolves `luna` to the exact or unique suffix match in
  Codex's local `models_cache.json` (for example `gpt-5.6-luna`). Exact slugs stay
  unchanged; missing, malformed, zero-match, or ambiguous caches preserve the
  original model so Codex can reject it loudly instead of the dispatcher guessing.
- Receipts and dry-runs now distinguish the caller's `modelRequested` from the
  normalized `model` passed to the vendor. The receipt schema version remains 1.
- AGY and Claude argv behavior is unchanged.

## 0.8.10 — 2026-07-29

- **Claude explicit plan/review mode hotfix**. `--mode plan|review` now preserves
  the matching `effectiveMode` in dry-runs and receipts. Both modes retain
  `--safe-mode` and use only `--tools=Read,Glob,Grep`; neither enables
  `--permission-mode plan` or Claude's native plan workflow. The tool-less default
  Claude argv and AGY/Codex mappings are unchanged.

## 0.8.9 — 2026-07-28

- **`--help` 신설**. 인자 없이 실행하거나 첫 인자가 `--help`/`-h`/`help`면 사용법을
  stdout에 출력하고 exit 0. 벤더·오퍼레이션·플래그 목록은 파서가 강제하는 상수에서
  직접 생성해 코드와 어긋날 수 없다.
- **unknown-argument 에러에 사용법 첨부**. 호출자가 플래그를 잘못 주면 그 자리에서
  유효 목록을 받는다. 실측 계기: 비-Claude 호스트의 호출자가 agy native `--add-dir`를
  디스패처에 넘겼다가 `unknown argument`만 받고 `SINGLE_OPTIONS`를 직접 읽어 `--cwd`를
  알아내야 했다.
- **enum 거부 에러가 허용값을 싣는다**. `invalid --effort: turbo (claude accepts low,
  medium, high, xhigh, max)`처럼 벤더별로 다른 집합까지 알려준다. `--operation`·`--mode`
  에러도 손으로 친 문자열 대신 상수에서 생성한다.
- **소스 헤더 주석**에 파일을 찾는 법을 적었다 — 버전 디렉터리를 하드코딩하지 말 것.
  실측: 한 호출자가 0.8.2 경로에 고정된 채 남아, 0.8.3이 고친 agy 5분 내부 타임아웃에
  계속 걸렸다. 호스트마다 자체 플러그인 캐시를 쓰며 매니페스트가 없을 수도 있다
  (Codex는 `installed_plugins.json` 없이 자체 cache 사용 — 실측).
- 사용법은 **조건부 호출 규칙을 재진술하지 않는다**. 어느 벤더/오퍼레이션/모드가
  무엇을 요구하는지는 검증이 강제하고 에러가 정확히 보고한다. 손으로 쓴 산문 사본은
  검증 로직과 조용히 어긋나며, 실제로 리뷰가 두 라운드 연속 부정확을 찾아냈다.

## 0.8.8 — 2026-07-28

- AGY explicit `--mode plan|review` 입력에 `agy-native-readonly/v1` control envelope를
  자동 결합한다. headless plan이 승인할 수 없는 terminal·command·shell·`git diff`
  대신 native read/list/search를 사용하게 해, R033-H4에서 수동 brief 교정으로만
  성공했던 호출 조건을 provider translation의 기본 동작으로 만든다.
- mode 생략과 Claude/Codex 입력은 byte-for-byte 보존한다. dry-run과 JSONL receipt에
  additive `inputProfile`을 기록하며, explicit mode 0바이트 exit 4 안전망은 유지한다.

## 0.8.7 — 2026-07-28

- **Broker Neutrality 복원**. dispatcher의 `CLAUDECODE` 기반 unconditional self-call hard block을 제거한다. dispatcher는 중립 broker로서 실행 규율(safe-mode, timeout, raw output, 모델 결속, 영수증)을 보장하며 동일 호스트/벤더 호출을 차단하지 않는다. 리뷰 독립성 검증 책임은 caller(Madi 등)가 영수증과 리뷰 역할을 대조해 판정하도록 본래 층으로 분리한다.
- Claude Code 부모의 `CLAUDECODE` session marker는 Claude child에 전달하지 않는다.
  broker가 호출을 허용해도 vendor CLI가 nested-session으로 다시 거부하는 우회 실패를 막는다.
- **명시적 실행 mode**. `--mode plan|review`를 text 호출에만 추가한다. AGY/Claude는
  native plan, Codex review는 native `exec review`로 번역하며 Codex plan은 명시 실패한다.
  mode 생략은 기존 default argv다. receipt는 `requestedMode`·`effectiveMode`를 기록한다.
- plan/review는 같은 실제 project cwd 전체를 읽고 쓰기 도구만 제거한다. sandbox,
  worktree, snapshot, packet 분리는 하지 않는다.
- 명시적 plan/review의 0바이트 출력을 exit 4로 fail-closed한다. AGY headless plan에서
  command permission auto-denial이 exit 0·빈 리뷰로 위장되는 실측 결함을 막는다.

## 0.8.6 — 2026-07-28

- **Claude child customization 격리**. reverse channel argv에 `--safe-mode`를 고정해
  대상 프로젝트의 CLAUDE.md·skills·plugins·hooks·MCP·auto-memory가 inline review
  brief를 덮어쓰지 못하게 한다. OAuth·명시 model/effort와 기존 tool-less
  `--tools=` 경계는 유지한다. Madi cwd 실측에서 Dashboard Stop hook가 요청 결과를
  바꾸던 2-turn 오염을 재현했고, safe mode에서는 한 턴에 요청 토큰을 반환했다.
- safe mode가 보조 Haiku classifier를 함께 기록하므로 receipt의 요청 모델 검증은
  최대 output token을 낸 dominant model에 결속한다. 최대값이 다른 model family 사이에서
  동률이면 fail-closed한다.

## 0.8.5 — 2026-07-28

- **Claude reverse channel을 정식 dispatcher에 연결**. 비-Claude host는
  `--vendor claude --operation text`로 model·effort·out·err를 명시하고, raw
  `claude -p`나 280초 셸 timeout을 쓰지 않는다. 공통 1800초 runaway backstop과
  프로세스 트리 회수·stdin·raw output·stderr·JSONL receipt를 그대로 사용한다.
- **Claude 결과·모델 결속을 fail-closed로 검증**. exit 0이어도 빈/깨진 result JSON,
  `is_error`, modelUsage 부재, 요청과 다른 실제 model family는 raw output을 보존한 채
  exit 4다. receipt `vendorUsage`에는 ANSI 표시 아티팩트를 제거한 실제 모델과
  token usage·cost를 기록한다.
- **동일 벤더 자기검증 차단**. `CLAUDECODE`가 활성인 Claude Code host에서는 Claude
  dispatch를 spawn 전에 exit 2로 거부하고 uninvoked receipt를 남긴다. R033-H2는
  tool-less text bridge만 소유하며 read-only/tool-enabled registry는 R034에 남긴다.

## 0.8.4 — 2026-07-27

- **AGY를 요청 workspace에 결속**. 디스패처의 `--cwd`를 모든 AGY operation의
  `--add-dir`로 전달하고 image input directory와 중복 제거한다. host와 temp에 같은
  상대경로·다른 hidden token을 둔 실측에서 target token만 반환했다.
- **선택적 hidden output check**. `--expect-output <ASCII token>`은 `--out`과 함께
  child stdout을 chunk 경계까지 literal 검사한다. child exit 0이어도 token이 없으면
  raw output은 보존하고 dispatcher/receipt exit 4, 있으면 exit 0이다. token 자체는
  vendor argv·brief·receipt에 전달하지 않으며 receipt에는 `outputCheckStatus`만 남긴다.

## 0.8.3 — 2026-07-25

- **agy 내부 타임아웃과 디스패처 타임아웃을 정합**. agy의 print 모드는 자체
  타임아웃(`--print-timeout`, 기본 `5m0s`)을 갖는데 디스패처는 이를 몰랐다.
  디스패처 기본값이 1800초라, 5분 넘는 작업은 디스패처가 손대기 전에 agy가
  스스로 종료했고 **`exit=124`가 아니라 `exit=1`이라 타임아웃으로 보이지도
  않았다**. 실측: 리뷰 렌즈가 4회 연속 304~306초에 exit 1 + 출력 0바이트로
  죽었고(같은 시각 가벼운 슬롯은 111초에 정상 종료), brief를 4.4KB→2.7KB로
  줄여도 동일했다 — brief는 애초에 변수가 아니었다.
  이제 `--timeout` 값을 `--print-timeout <N>s`로 전파한다. 고정 상수가 아니라
  파생값이라 두 상한이 다시 어긋나지 않는다.

## 0.8.2 — 2026-07-22

- **문서: agy 1.1.5 모델 라벨/slug 규칙 정정**. `agy models`가 이제 라벨이 아니라
  slug를 출력하고(모델 피커는 라벨), agy 1.1.5는 정규 slug와 디스플레이 라벨을 둘 다
  받는다(실측). 모르는·깨진 이름은 exit 1로 loud reject — 구버전의 silent-downgrade가
  검증으로 대체됐다. 모델 목록에 Gemini 3.6 Flash 추가. agy 영수증 한계(요청 모델·
  실행 여부까지, 실측 토큰·실제 backend는 Codex 전용)도 명시. 코드 변경 없음.

## 0.8.1 — 2026-07-21

- **테스트 이식성 수정**: `run()`이 상대경로를 절대화해 기록하는지 검증하는 P0 회귀
  테스트가 경로를 문자열로 엄격 비교해, `os.tmpdir()`과 `process.cwd()`의 드라이브
  문자 대소문자가 다른 Windows 머신에서 실패했다. `path.relative(a, b) === ""`(프로덕션
  `samePath()`와 같은 의미, 플랫폼 정확) 비교로 바꿔 같은 파일을 정확히 검증하되
  대소문자 차이는 무시한다. 절대경로 검사(`isAbsolute`)는 그대로 유지. 코드 동작 무변경,
  테스트 파일만 수정.

## 0.8.0 — 2026-07-21

- **P0: 영수증·`--out`/`--err` 경로 충돌 데이터 손실 차단**: 기존 영수증 파일을 벤더 출력이
  truncate하던 0.7.0 설정을 CLI 단계에서 exit 2로 거부한다.
- **Codex 실측 사용량 영수증**: opt-in JSONL 영수증에 `vendorUsage`·`vendorUsageStatus`를
  추가한다. `--err`의 session id와 정확히 하나인 rollout 로그의 마지막 `token_count`에서
  토큰·컨텍스트·quota를 동기식 fail-open으로 읽으며, 다른 벤더·수집 불가에는 `null`과 원인을 남긴다.

## 0.7.0 — 2026-07-20

- **opt-in 디스패치 파일 영수증**: `SECOND_OPINION_RECEIPT`에 경로를 지정하면, 기존 stderr
  한 줄을 유지한 채 호출마다 JSONL 관측 레코드를 append한다. 기록 실패와 출력 경로 충돌은
  fail-open으로 무시하며, `spawn` 이벤트가 실제 발생했는지도 `invoked` 필드로 남긴다.

## 0.6.1 — 2026-07-17

- **디스패처 타임아웃을 "작업 제한"에서 "폭주 백스톱"으로**: 기본 타임아웃을 280초 →
  1800초로 올린다. 짧은 고정 타임아웃이 codex high/xhigh 추론(파일 여러 개 정독)을
  최종 출력 전에 SIGTERM으로 잘라 "exit 124, 출력 비어있음, 추론이 stderr에 갇힘"을
  반복시켰다. 아울러 타임아웃 종료를 **SIGTERM → 유예 → 강제 트리킬(Windows
  `taskkill /T /F`, POSIX SIGKILL) → 유한 대기 후 강제 해소**로 바꿔, 벤더가 종료를
  무시하거나 자손이 stdio를 쥐어도 디스패처가 무한 대기하지 않고 자손도 트리째 정리한다.
- **Antigravity 파일접근 복구**: agy 호출에 `--dangerously-skip-permissions`를 부여한다.
  headless agy는 도구 권한 프롬프트를 못 띄워 자동 거부하므로, 이게 없으면 파일을 읽어야
  하는 브리프가 빈 출력으로 끝난다(`jetski: no output produced`). codex가 config 기본으로
  이미 도는 full-access 자세와 대칭이며, 플래그는 디스패처 내부에서 조립돼 오케스트레이터
  셸 라인에 드러나지 않는다.
- **탐지 참조 구현 하드닝**: caller-강제용 `detectDirectInference`를 exec-only deny-list에서
  **default-deny**로 교체한다(codex bare·review·resume·fork·추론 플래그, agy 비-관리 호출까지
  차단, 패키지 러너·heredoc·커맨드 캐리어 커버). 관리 allowlist는 설치 CLI(codex 0.144.1·
  agy 1.1.3) 실측 기준. `references/enforcement.md`에 한계 공시 추가.
- **Claude 어댑터 벤더 중립화**: "역방향 채널" 표현을 제거하고 codex·antigravity 어댑터와
  같은 중립 명명(`adapter-claude — Claude Code`)으로 통일한다.

## 0.6.0 — 2026-07-13

- **전역 강제 훅 제거 — 중개자 정화**: 0.5.0에서 넣은 PreToolUse 훅은 모든 프로젝트의
  codex/agy 직접호출을 차단해, 중개(relay) 스킬이 남의 벤더 호출까지 막는 스코프 위반이었다.
  훅(`hooks/`)을 제거한다 — second-opinion은 이제 아무것도 차단하지 않는다. 커맨드 정합성은
  디스패처(도구)가 계속 보장한다.
- **강제는 caller 책임으로**: "디스패처를 반드시 거치게" 강제하려는 프로젝트는 자기 스코프에서
  PreToolUse 훅을 건다 — 방법은 `references/enforcement.md`. 탐지 참조 구현 `detectDirectInference`는
  `scripts/vendor-policy.mjs`에 export로 유지(단위테스트 보존).

## 0.5.1 — 2026-07-13

- **정션/심링크 안전 메인모듈 가드**: 디스패처와 PreToolUse 훅을 정션·심링크 경로로
  실행해도 양쪽 경로를 실경로로 정규화해 main 진입을 놓치지 않는다.

## 0.5.0 — 2026-07-12

- **기계적 벤더 라우팅**: 오케스트레이터가 매 호출 커맨드를 다시 조립하며 위험 플래그를
  자의로 붙이던 문제(codex 불필요 -s 반복)를 코드로 닫는다. 이제 Claude는 operation
  (text/image-analyze/image-generate)만 고르고, 실제 argv 조립·실행은 디스패처
  (scripts/dispatch.mjs, 정본 scripts/vendor-policy.mjs)가 맡는다. 가변값은 허용하되
  가변 argv는 불허 — -s는 이미지 생성에서만 자동, 비-git은 --skip-git-repo-check 자동.
- **PreToolUse 훅**: codex exec·agy 직접 추론호출을 command-word 기준으로 탐지해 차단하고
  디스패처 경로를 안내한다(관리 명령·오탐은 통과, 내부 오류는 fail-open).
- **문서 정비**: fast-path를 디스패처 호출로, 이미지 brief 스펙 정본화, 어댑터 3종
  카테고리 골격 통일.

## 0.4.0 — 2026-07-12

- **실행 영수증**: 벤더 호출 후 한 줄로 관측을 보고한다 — 요청 벤더·모델 → 실제 응답 backend →
  exit/timeout → 폴백·강등. "요청=실행"을 가정하지 않아, 모델이 조용히 계정 기본값으로 강등된 것을
  드러낸다. 부르는 쪽(외부 오케스트레이터)이 지정 모델의 실제 실행을 확인할 근거.
- **버전·능력 마커**: SKILL.md 상단에 호환 기준 버전을 표시해, 소비자가 최소 버전 의존을 걸 수 있게 한다.
- **아웃바운드 brief secret redacting**: brief를 벤더에 보내기 전 시크릿(API키·토큰·자격증명)이 실수로
  섞였는지 확인·마스킹한다(출력 stderr redact와 대칭). 검토·번역·오프로드 대상에 원래 포함된 예제·더미
  자격증명은 정당한 내용이라 건드리지 않는다.

## 0.3.0 — 2026-07-11

- **brief 구조화**: 벤더 지시를 순서 있는 5필드(역할/대상/제약/Output Format/Do NOT)로 서술.
  제약을 앞, 금지를 끝에 둬 긴 컨텍스트에서 중간 지시가 씹히는 것(lost-in-the-middle)을 피한다.
- **대용량 파일-스필**: 대상이 이미 파일이면 경로를 넘기고, 조립할 내용이 8,000자 이상이면
  임시 파일에 써서 경로로 전달한다(신뢰 채널 argv의 최악-호스트 안전선). 데이터 경계 규칙은 유지.
- **멀티모달 파일 입력**: 이미지·영상 분석을 양 벤더로 — Codex는 `-i`(영상은 ffmpeg로 프레임 추출),
  Antigravity는 `--add-dir`로 디렉토리 허용 후 경로 참조.
- **이미지 프롬프트 크래프트 레퍼런스**(`references/image-craft.md`) 신규 — 벤더무관 조명·카메라·
  스타일·구도 지침. 네거티브 프롬프트 벤더 차이도 명확화.
- **어댑터 설치·업데이트 안내 정비**: codex는 공식 standalone installer(`install.ps1`), Claude Code와
  Antigravity도 공식 installer로 통일. 채널 혼용 금지·stale PATH·실제 스모크 검증 규율 추가.
- **agy 1.1.1 stdin 파손 수정**: `-p -`가 깨져 무-플래그 stdin으로 전환(미문서화 경로라 `--add-dir` 폴백 병기).
- **결과 전달 하드닝**: 벤더 stderr relay 시 32자 이상 토큰 마스킹, 금지 규칙에 근본원인(버전·버그·환경)
  태그, 검증은 실제 사용 방식 그대로.

## 0.2.1 — 2026-07-04

- Codex 미인식 시 오진단 수정: `codex` 명령이 안 잡힌다고 바로 "미설치"로 단정하지 않는다.
  stale PATH(방금 재설치했는데 세션이 그보다 먼저 떠 있던 경우) 및 winget 설치 특유의
  알려진 별칭 버그([openai/codex#28321](https://github.com/openai/codex/issues/28321) —
  실행파일이 `codex.exe`로 리네임 안 되고 남아있어 winget이 별칭을 만들었다고 거짓 보고)를
  먼저 확인하고, 각각 다른 처방(앱 재시작 / 공식 스크립트 재설치 또는 비파괴적 shim)을
  제시한다. Windows Defender 오탐 이슈([#3207](https://github.com/openai/codex/issues/3207))도
  참고로 남김(별개 이슈, 혼동 방지)

## 0.2.0 — 2026-07-03

- 포지셔닝 확장: 점검·리뷰 전용 어댑터 → **외부 AI 어댑터**. 쓰임 세 축 — ① 의견(교차
  점검, 기존) ② 용량(원할 때 작업을 외부 벤더 quota로 오프로드 — 언제 돌릴지는 항상
  사용자가 결정) ③ 능력(벤더 고유 기능)
- 이미지 생성 지원 문서화 (2026-07-03 실측 기준): Codex는 gpt-image-2로 생성(쓰기 허용
  샌드박스 필요, 산출물은 `~/.codex/generated_images/`), Antigravity는 사진급 생성(지정
  경로를 무시하고 자체 scratch 폴더에 저장). 공통 규칙 — 성공 판정은 벤더의 답변이
  아니라 실제 파일 존재로 하고, 산출물을 사용자가 원한 위치까지 옮겨서 보고
- 트리거 확장: "코덱스한테 시켜줘/만들어달라고 해줘", "외부 AI로 처리해줘", "사용량
  아끼게 외부로 돌려줘" 등 과업 위임 표현 인식

## 0.1.6 — 2026-07-03

- "다벤더 대조" 섹션 제거(0.1.5에서 도입) — 여러 AI의 리뷰 결과를 비교·종합하는 방법은
  어댑터가 아니라 호출하는 쪽 워크플로우의 몫. 스킬은 벤더 호출과 정직한 전달에 집중
- quota 안내 정정 — 모델 전환이 quota를 절약한다고 가정하지 말 것 (실사용 관측: 여러
  모델의 사용량이 같은 비율로 동반 상승, 풀 구조는 미확정). 모델 전환을 quota 절약
  수단으로 안내하던 기존 문구 삭제
- Antigravity 선택 가능 모델 목록(티어 포함) 수록 — `agy models` 실측 기준 (2026-07-03)
- Codex 인증 안내 보강 — 머신마다 각자 로그인해도 충돌하지 않음(실험 확인). auth 파일의
  머신 간 복사만 금지

## 0.1.5 — 2026-07-03

- **다벤더 대조 섹션 신설** — 3벤더 라이브 테스트(Gemini+GPT-OSS+Codex)에서 검증된
  패턴 명문화: ① finding×vendor 매트릭스(수렴=신뢰 신호, 단독 발견=검증 1순위 —
  실측: 단독 P1 4건 전부 실재) ② stale-input 함정(벤더 지적이 최신 코드와 모순되면
  코드를 정본으로 재확인, 오판은 원인과 함께 보고) ③ 보고 형식(수렴/단독/오판 3묶음,
  검증 라벨 4종 정의)

## 0.1.4 — 2026-07-03

- **`agy models`로 라벨 확인 안내** — slug silent-ignore 함정의 근본 해법: 정확한
  디스플레이 라벨을 명령으로 조회해 복사 (머큐리 실측)
- **GPT-OSS 120B 제3 시각 옵션 문서화** — Codex 불능 시 Antigravity의
  `"GPT-OSS 120B (Medium)"`(OpenAI 오픈웨이트)로 GPT 계보 시각 확보 가능.
  지명 벤더 무단 대체 금지 규칙은 유지 (WHITE2 발견 → 머큐리 재현)

## 0.1.3 — 2026-07-03

- **agy stdin 경로가 기본**: `-p - < brief.txt` — argv 30,000자 한계 없음(105KB 실측,
  머큐리 독립 재현) + 파일 리다이렉트가 stdin을 닫아 hang도 원천 해소. argv 경로 함정
  (`</dev/null`·30k)은 argv 사용 시 한정으로 재분류. `-p`만 쓰고 `-` 빠뜨리면 help로
  떨어지는 함정 명시 (WHITE2 발견 → 머큐리 재현)
- **agy 인증 문서화**: Antigravity IDE 로그인 공유 — IDE 로그인 상태면 CLI 별도 로그인
  불필요 (WHITE2 실측)

## 0.1.2 — 2026-07-03

- **복구 안내 자급화**: agy 설치 명령을 SKILL.md에 직접 수록. 이전 버전은 "README의
  설치 스크립트"를 참조했는데 플러그인 배포본에는 README가 없어 안내 불능이었음
  (WHITE2 실전 테스트 #3에서 발견). IDE ≠ headless CLI 오인 주의도 명시

## 0.1.1 — 2026-07-03

- **지명된 벤더는 대체하지 않는다**: 사용자가 벤더를 지명했는데 CLI 미설치/인증 만료면,
  복구 명령(설치·`codex login` 등)을 안내하고 재시도를 기본 흐름으로. Claude 자체 리뷰로의
  조용한 대체 금지(동의 시에만). WHITE2 실전 테스트에서 나온 피드백 반영
- `refresh_token_reused` gotcha 추가: auth.json을 머신 간 복사/sync하면 발생 —
  재로그인으로 해소, auth 파일 비복제가 근본 해법
- README에 CLI 설치 경로(B) 추가: `claude -p "/plugin marketplace add …"` +
  `claude plugin install`(hidden command, 실측)

## 0.1.0 — 2026-07-03

첫 공개.

- `second-opinion` 스킬: Codex(`codex exec -` stdin 경유)·Antigravity(`agy --model <라벨> -p` + stdin close) 어댑터
- 자연어 트리거(한/영), 벤더 자동 제안(코드→Codex / 다각·볼륨→Gemini / 중요 판단→병렬 대조)
- 실측 gotcha 내장: agy stdin EOF 무한 hang · `--model` slug silent-ignore(계정 기본값 강등) · Windows codex sandbox 파일읽기 불능(발췌 동봉 폴백) · agy argv 30,000자 한계 · false-negative 편향 전달 원칙
- 데이터 경계 규칙(시크릿·원시 덤프 전송 금지)·정직 실패 보고 원칙
- 검증: Windows(Git Bash)에서 양 벤더 라이브 스모크 통과. macOS/Linux 미실측(정직 라벨)
