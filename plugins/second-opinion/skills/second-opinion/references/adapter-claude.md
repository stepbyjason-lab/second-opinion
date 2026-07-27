# adapter-claude — Claude Code reverse channel

> 비-Claude 호스트 전용. dispatcher bridge 실측 기준 2026-07-28.

## Host guard

이 채널은 **호출하는 쪽이 Claude가 아닐 때만** 쓴다. Claude Code host에서 Claude를
리뷰어로 다시 부르면 동일 벤더 자기검증이 되므로 사용하지 않는다. dispatcher는
`CLAUDECODE`가 활성인 환경에서 `--vendor claude` 실제 실행을 spawn 전에 exit 2로 거부하고
uninvoked receipt를 남긴다. Claude Code host에서는 Codex나 Antigravity를 대신 쓴다.

## 정식 호출

raw `claude -p`나 셸 `timeout` wrapper를 직접 쓰지 않는다.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor claude --operation text \
  --brief brief.txt --cwd <작업 repo 또는 임시 dir> \
  --model opus --effort high \
  --out claude-result.json --err claude-stderr.txt
```

PowerShell도 동일한 `node ... dispatch.mjs` argv를 사용한다. brief 내용은 dispatcher가
바이트 그대로 stdin으로 전달하므로 `Get-Content | claude`를 조립하지 않는다.

- `--model`과 `--effort`는 필수다. Claude CLI 2.1.215 실측 effort는
  `low | medium | high | xhigh | max`다.
- `--out`과 `--err`도 필수다. raw JSON·stderr가 증거 봉투의 backend output이 된다.
- `SECOND_OPINION_RECEIPT=<JSONL 경로>`를 설정하면 요청 모델·실제 model family·token
  usage·cost·exit·duration·invoked 여부를 한 행으로 묶는다.
- Claude 결과가 exit 0이어도 빈 결과, 깨진 JSON, `is_error`, modelUsage 부재, 요청과 다른
  실제 model family는 exit 4로 fail-closed한다. raw output은 그대로 보존한다.
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

R033-H2 최소 bridge는 `--disable-slash-commands --tools=`를 고정한 **tool-less text
review**다. 따라서 brief 본문에 검토 대상을 모두 포함해야 하며 파일 경로만 주면 안 된다.
도구가 없어도 모델이 가짜 tool-call을 서술할 수 있으므로 brief 끝에 “도구 호출·파일 접근을
서술하지 말고 inline 대상만으로 최종 답을 직접 출력하라”고 명시한다.

read-only/tool-enabled Claude mode, MCP allowlist, adapter registry는 R034 범위이며 이
hotfix에 포함하지 않는다.

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
