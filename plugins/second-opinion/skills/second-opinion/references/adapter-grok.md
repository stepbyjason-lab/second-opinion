# adapter-grok — Grok Build CLI (SuperGrok 구독)

정본 호출은 디스패처다. raw `grok -p "..."` 는 쓰지 않는다 — prompt가 process argv에 노출된다.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor grok --operation text \
  --brief brief.txt --cwd <작업 repo> --model grok-4.6 --effort medium \
  --out grok-result.json --err grok-stderr.txt
```

읽기 전용 plan/review는 `--mode plan|review`를 붙인다. dispatcher가 `--permission-mode plan`과 `--tools read_file,grep,list_dir`와 `--no-subagents`를 넣는다. default는 `--permission-mode bypassPermissions`로 headless 승인 프롬프트를 피한다.

Grok CLI의 `--effort`는 선택값이다. 다만 Madi를 비롯한 코드 리뷰의 **표준 예시는 가성비 기준
`--effort medium`**을 명시한다. dispatcher는 이를 Grok CLI의 `--effort`로 그대로 전달하고,
영수증의 `effortRequested`로 요청값을 남긴다. 더 깊은 검토가 필요할 때만 caller가 명시적으로
올린다.

### ⚠ `--tools` allowlist는 이름이 맞을 때만 막는다 — 전부 틀리면 **조용히 열린다**

**실측 2026-08-19 (grok 1.0.5, `--permission-mode bypassPermissions` 고정, 파일 쓰기 요청)**

| `--tools` 값 | 읽기 | 쓰기 | 결과 |
|---|---|---|---|
| `read_file,grep,list_dir` (**dispatcher가 쓰는 값**) | — | **차단** | `NO_WRITE_TOOL` 응답, 파일 미생성 |
| `bogus_tool_xyz` (전부 무효) | 가능 | **가능** | 요청한 파일이 **실제로 생성됨** |

**이름이 맞으면 allowlist가 실제로 먹는다.** 그러나 **이름이 전부 무효면 grok이 에러를 내지 않고 전체 도구를 연다.**
`bypassPermissions`(전부 자동 승인)와 겹치면, **grok이 다음 버전에서 내장 도구 이름을 바꾸면
plan/review가 소리 없이 full-access가 된다.** 실패가 산출물에 드러나지 않는다.

- dispatcher는 plan/review에 **`--permission-mode plan`을 `--tools`와 함께** 건다. allowlist가 깨져도 native plan이 바닥이다. default는 그대로 `bypassPermissions`.
- **업그레이드 때마다 위 표를 다시 돌려라.** `--tools <틀린이름>`으로 쓰기를 시켜 **차단되는지**가 판정이다. 이번 구현의 재실측은 `--permission-mode plan`을 켠 채로 해야 한다.
- 내장 도구 이름 목록은 `grok --help`·`grok inspect` 어디에도 없다. 위 실측이 유일한 근거다.

### ⚠ Grok은 다른 하네스 설정을 기본으로 읽어 온다 — 리뷰 호출에서 env로 끈다

`grok inspect` 실측(2026-08-19):

```
Harness Compatibility
└ cursor : skills · rules · agents · mcps · hooks · sessions — 전부 on (default)
└ claude : skills · rules · agents · mcps · hooks · sessions — 전부 on (default)
└ codex  : sessions — on (default)
```

**읽기만이 아니라 따른다.** 같은 프로브에서 응답 `thought`에 호출자의 전역 `Claude.md` 규칙
(*"MemKraft rule about searching first on each turn"* · *"check memory first"*)이 그대로 나타났다.
`Permissions` 절도 `~/.claude/settings.json`을 원본으로 읽고(97 loaded / 20 skipped) 모르는 항목만 건너뛴다.

끄는 키(grok 1.0.5 user-guide): env > config.toml > default(on).
`GROK_CONFIG` overlay는 compat 테이블을 받지 않는다.

`--mode plan|review` spawn이 `false`로 덮는 칸은 **13개**다.

| 벤더 | 강제 env | grok 1.0.5에서 실제로 켜지는 것 |
|---|---|---|
| Claude | `GROK_CLAUDE_{SKILLS,RULES,AGENTS,MCPS,HOOKS,SESSIONS}_ENABLED` | 지침·훅·MCP·스킬 포함 |
| Cursor | `GROK_CURSOR_{SKILLS,RULES,AGENTS,MCPS,HOOKS,SESSIONS}_ENABLED` | 동형 |
| Codex | `GROK_CODEX_SESSIONS_ENABLED`만 | `sessions` 하나. 나머지 Codex 칸은 예약·inert |

사용자 `config.toml`은 쓰지 않는다. default 호출은 강제하지 않는다.

**켜서 검증하지 않는다.** 호환 on은 이미 실측됐고(지침·훅·MCP를 읽고 세션이 죽는다).
검증은 **꺼진 상태**만 본다: `grok inspect`의 Harness Compatibility가 off인지, spawn env가
13개 모두 `false`인지. 칸을 `true`로 올려 덮기를 확인하는 호출은 하지 않는다.

**남는 갭(공시):** 프로젝트 루트 `CLAUDE.md` / `AGENTS.md`는 compat를 꺼도 파일 이름
자체로 인식된다. Grok 자기 `~/.grok` 스킬·훅·플러그인도 그대로다. Claude 채널
`--safe-mode`와 같은 전면 격리는 아니다.

## 인증·설치

- 공식 Windows 설치: `irm https://x.ai/cli/install.ps1 | iex`
- native 경로: `%USERPROFILE%\.grok\bin\grok.exe` (정션으로 `D:\AppData\.grok` 등)
- PATH에 없어도 dispatcher가 그 fallback을 찾는다
- 구독 로그인: `grok login` (SuperGrok OAuth). API key 경로는 이 어댑터 범위 밖이다
- 확인: `grok version` · `grok models`

## Transport

- brief는 `--prompt-file <brief 절대경로>`로 넘긴다. dispatcher는 stdin을 닫기만 하고 brief 본문을 쓰지 않는다.
- `--request-json` 구독 생성은 `--output-format json` 결과의 `text` 필드를 응답 본문과 stream chunk로 꺼낸다. 전체 JSON 문서를 `response.text`나 chunk로 쓰지 않는다. `text`가 없거나 JSON이 아니면 fail-closed.
- `--output-format json` — 실측(2026-08-19, grok 1.0.5, SuperGrok OAuth):
  - `text`, `stopReason`, `usage.input_tokens` / `output_tokens` / `total_tokens`
  - `modelUsage["grok-4.6-build"]` (요청 slug `grok-4.6`의 실행 키)
  - `total_cost_usd` 가 이 프로브에서는 존재했음. 없으면 토큰 필드로만 귀속한다.
- image-analyze / image-generate 는 거부한다.

## 모델

`grok models` 실측: default `grok-4.6`, available `grok-4.6` · `grok-4.5`.
요청 모델과 `modelUsage` 키가 접두로 맞으면 통과한다 (`grok-4.6` ↔ `grok-4.6-build`).
모르는 모델은 fail-closed. 조용한 강등 없음.

## 복구

1. `executable_not_found` — 공식 install.ps1 재실행, 새 셸에서 PATH 확인, 또는 `%USERPROFILE%\.grok\bin\grok.exe` 존재 확인
2. 인증 실패 / `No auth credentials` — `grok login` 후 재시도
3. 빈 JSON / usage 없음 — 구독 fail-closed. 전역 규율을 풀지 않는다
