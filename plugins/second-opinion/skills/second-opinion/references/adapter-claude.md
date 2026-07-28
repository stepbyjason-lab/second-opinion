# adapter-claude — Claude Code reverse channel

> dispatcher bridge 실측 기준 2026-07-28.

## 리뷰 독립성과 중립 broker

dispatcher는 호출자의 실행 요청을 중립적으로 중계하며, 동일 호스트/벤더 호출 여부를 기계적으로 차단하지 않는다. 동일 벤더 호출 시 독립 리뷰 인정 여부는 caller(Madi 등)가 실제 기록된 영수증과 역할을 대조해 판정한다.

Claude Code 부모에서 실행할 때 dispatcher는 parent session marker `CLAUDECODE`를 child
환경에서만 제거한다. 그렇지 않으면 Claude CLI 자체의 nested-session 보호가 정당한
same-host 호출까지 거부한다. 다른 환경과 receipt의 caller 증거는 바꾸지 않는다.


## 정식 호출

raw `claude -p`나 셸 `timeout` wrapper를 직접 쓰지 않는다.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor claude --operation text \
  --brief brief.txt --cwd <작업 repo 또는 임시 dir> \
  --model opus --effort high \
  --out claude-result.json --err claude-stderr.txt
```

같은 실제 project cwd를 읽는 plan/review는 각각 `--mode plan|review`를 추가한다. 둘 다
Claude native `--permission-mode plan`과 `Read,Glob,Grep` 도구로 번역된다. mode 생략은
아래 tool-less default 호출이며 자동으로 plan/review가 되지 않는다.

PowerShell도 동일한 `node ... dispatch.mjs` argv를 사용한다. brief 내용은 dispatcher가
바이트 그대로 stdin으로 전달하므로 `Get-Content | claude`를 조립하지 않는다.

- `--model`과 `--effort`는 필수다. Claude CLI 2.1.215 실측 effort는
  `low | medium | high | xhigh | max`다.
- `--out`과 `--err`도 필수다. raw JSON·stderr가 증거 봉투의 backend output이 된다.
- `SECOND_OPINION_RECEIPT=<JSONL 경로>`를 설정하면 요청 모델·실제 model family·token
  usage·cost·exit·duration·invoked 여부를 한 행으로 묶는다.
- Claude 결과가 exit 0이어도 빈 결과, 깨진 JSON, `is_error`, modelUsage 부재, 요청과 다른
  실제 model family는 exit 4로 fail-closed한다. raw output은 그대로 보존한다.
- safe mode의 보조 Haiku classifier도 `modelUsage`에 남을 수 있다. 요청 모델 검증은
  최대 output token을 낸 dominant model에 결속하며, 최대값이 다른 model family 사이에서
  동률이면 fail-closed한다. receipt의 `actualModels`에는 보조 모델까지 모두 보존한다.
- `modelUsage` key 끝의 `[1m]`은 Claude CLI의 ANSI 표시 아티팩트다. receipt에는 이를
  제거한 모델명을 기록한다.

## Timeout과 hang

Claude argv에는 짧은 작업 timeout을 넣지 않는다. dispatcher 기본 1800초는 정상 추론을
중단시키는 작업 예산이 아니라 비정상 hang을 회수하는 runaway backstop이다. 도달하면
Windows에서는 `taskkill /T /F`, POSIX에서는 강제 종료로 자식 트리까지 회수하고 receipt
exit를 `timeout`으로 기록한다. 중단된 리뷰는 resume하지 않고 같은 brief로 처음부터 다시
실행한다.

실측: 46,446-byte·1,010-line Opus high 리뷰는 raw 280초 제한에서 빈 출력으로 종료됐지만,
dispatcher 규율에서는 303.92초에 exit 0·실제 `claude-opus-4-8`·유효 리뷰를 반환했다.

## 도구 경계

default Claude child는 `--safe-mode --disable-slash-commands --tools=`인 tool-less text
호출이다. brief 본문에 대상을 포함해야 하며 파일 경로만 주면 안 된다.

명시적 `--mode plan|review`에서는 같은 `--safe-mode`를 유지하되
`--permission-mode plan --tools=Read,Glob,Grep`로 실제 project cwd 전체를 읽는다.
Write·Edit·Bash는 제공하지 않는다. sandbox·worktree·snapshot·packet 분리는 사용하지 않는다.

## 비용

nested Claude 호출은 풀 세션이다. 2026-07-28 Opus high 46KB 실측은 cache creation
41,807·output 21,923 tokens, 약 $0.97였다. 모델과 effort를 생략하지 말고, 현재 검증에
필요한 최소 brief만 보낸다.

## 설치·복구

- 확인: `claude --version`
- 공식 native installer: Windows `irm https://claude.ai/install.ps1 | iex`
- native 기본 경로: `~/.local/bin/claude`
- 업데이트: `claude update`
- 인증: Pro/Max/Team/Enterprise 계정 필요

native·npm·winget을 섞지 않는다. Windows에서 `.cmd`/`.bat`만 발견되고 native
`claude.exe`가 없으면 dispatcher는 channel mixing으로 거부한다.
