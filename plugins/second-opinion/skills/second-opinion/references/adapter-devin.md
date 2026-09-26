# adapter-devin — Devin CLI subscription channel

> 기준: Devin CLI 3000.10.31, Windows.

## 정식 호출

raw `devin -p`를 직접 조립하지 않고 dispatcher를 쓴다.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor devin --operation text \
  --brief brief.txt --cwd <작업 repo> --model swe-2-max \
  --out devin-result.txt --err devin-stderr.txt
```

`--vendor devin`은 필수다. Devin 모델 이름은 다른 벤더와 겹칠 수 있어 자동 모델 카탈로그·라우팅에
들어가지 않는다. model slug는 호출자가 준 문자열 그대로 전달하며 `--effort`는 받지 않는다.

## 모델 — SWE-2

Devin에는 effort 인자가 없다. **effort는 슬러그 끝으로 고른다** — `--effort`를 주면 spawn 전에 거부된다.
이 채널에서 쓰는 모델은 SWE-2 하나다(`devin models list`로 확인).

| `--model` | effort | 비고 |
|---|---|---|
| `swe-2-high` | high | Free · 262K context |
| `swe-2-medium` | medium | Free · 262K context |
| `swe-2-max` | max | Free · 262K context |
| `swe` | high | 별칭. 실호출 영수증 `vendorUsage.actualModels`는 `SWE-2 High`로 남는다 |

- 무엇이 실제로 돌았는지는 영수증 `vendorUsage.actualModels`(transcript의 `agent.model_name`)로 확인한다.
  영수증 `model`은 호출자가 준 문자열 그대로다.
- 목록이 바뀌었는지는 `devin models list`로 확인한다. 거기 나오는 모델 UID·계열 슬러그·별칭은
  `--model`에 그대로 줄 수 있다.

## 입력·실행 자세

- dispatcher는 brief 본문을 argv나 stdin에 넣지 않고 `--prompt-file <절대경로>`로만 넘긴다.
- `-p` 단발 비대화 실행이며 `--respect-workspace-trust false`로 headless trust prompt를 피한다.
- mode 생략은 차단 hook 없는 config와 `--permission-mode dangerous`: 읽기·쓰기·명령을 승인 입력 없이 수행한다.
- `--mode plan|review`는 write/edit/notebook_edit/write_to_process를 막는 PreToolUse
  hook이 든 read-only config와 `dangerous`를 함께 쓴다. `exec`는 열어 두어 리뷰어가
  `git diff`·`git log`·시험을 직접 돌린다. 셸이 도는 이상 셸로 파일을 쓸 수 있으므로
  쓰기를 붙잡는 것은 brief의 금지 지시뿐이다(claude 리뷰와 같은 자세). hook의 block 이유가
  자식에게 돌아가므로 세션은 계속된다. 두 mode의
  권한 자세는 같고 receipt identity만 plan/review로 보존한다.
- image-analyze/image-generate와 `--effort`는 spawn 전에 거부한다.

## 호스트 격리

dispatcher는 default에 `scripts/devin-isolated-config.json`, plan/review에
`scripts/devin-readonly-config.json`을 `--config`로 넘긴다. 두 파일은
`read_config_from`의 `agents_standard`, `cursor`, `windsurf`, `claude`, `copilot`, `opencode`, `vscode`,
`zed`를 모두 `false`로 둔다. read-only 파일은 추가로 위 네 도구를 PreToolUse에서 block하고
`exec`는 열어 둔다.
`apply_patch`도 예방적으로 matcher에 포함하지만, Devin CLI 3000.10.31 기준 미노출 도구이므로
실제 호출·차단 성공으로 세지 않는다.
두 설정에는 계정·조직 ID나 절대 홈 경로 같은 기계 고유값을 넣지 않으며, `shell.setup_complete`만으로
새 설정 위치의 첫 호출 환영 배너를 막는다.
이 설정에서 `devin mcp list`는 서버 0개이고,
`devin skills list --json`에는 Devin이 자체 제공하는 기본 항목만 남는다.

이 격리는 호출자 하네스의 스킬·MCP를 끄는 설정이지 filesystem sandbox가 아니다. 프로젝트나 사용자
경로의 `AGENTS.md`처럼 Devin이 상시 지시 문서로 직접 찾는 표면은 차단되지 않는다. receipt의
raw `hostIsolation.argv`는 실제로 넘긴 config 경로와 permission mode를 기록하며, config 내용을 복제하지 않는다.
portable 영수증은 그 경로를
`bundled:devin-isolated-config.json` 또는 `bundled:devin-readonly-config.json`으로 기록한다.

검증 범위: 로컬 단위 테스트는 설정의 matcher와 hook 명령이 반환하는 block 결정·이유를 확인한다.
Devin의 실제 도구 호출이나 거절 뒤 실행 계속 여부를 대신 증명하지 않는다. 3000.10.31 기준 실호출에서
plan/review 각각 쓰기 도구의 차단 이유와 이후 읽기 단계 진행이 확인된다.

## 영수증

dispatcher가 내부 임시 경로로 `--export`를 지정하고 호출 종료 뒤 transcript JSON을 읽는다.

- `session_id` → `vendorUsage.sessionId`
- `agent.model_name` → `vendorUsage.actualModels`
- `final_metrics.total_prompt_tokens` → `inputTokens`
- `final_metrics.total_completion_tokens` → `outputTokens`
- `final_metrics.total_cached_tokens` → `cachedInputTokens`
- prompt + completion → `totalTokens`

이 수치는 한 프롬프트 문자열의 크기가 아니라 transcript 모든 step의 합계다. transcript가 없거나
깨졌거나 필드가 불완전하면 `vendorUsage: null`과 구체적인 `vendorUsageStatus`를 남긴다. usage 수집 실패는
이미 성공한 자식 결과를 실패로 바꾸지 않는다.

## 설치·복구

- 확인: `devin --version`
- 인증: Devin CLI의 OAuth 로그인 상태를 그대로 사용한다.
- PATH에서 못 찾으면 Windows 기본 위치 `%LOCALAPPDATA%\devin\cli\bin\devin.exe`를 찾는다.
- `executable_not_found`: 공식 설치를 복구하고 새 셸에서 PATH 또는 위 fallback 파일을 확인한다.
- 이 adapter는 로컬 단발 CLI만 다룬다. cloud session, handoff, ACP, 모델 카탈로그는 범위 밖이다.
