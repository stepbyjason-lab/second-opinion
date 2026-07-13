# Claude Code — 역방향 채널 (host가 Codex 등 비-Claude일 때만, 실측 2026-07-07)

⚠️ **host guard (MUST NOT 위반)** — 이 채널은 **호출하는 쪽이 Claude가 아닐 때만**
쓴다(Codex 등). **Claude Code host에서는 아래 세 변형을 절대 쓰지 않는다** — 의견
렌즈로 쓰면 동일 벤더 자기검증이 되어 교차 검증 목적 자체가 무너진다. Claude Code
host에서 다른 시각이 필요하면 멈추고 Codex나 Antigravity를 대신 쓸 것.

기본 커맨드는 SKILL.md fast-path 참조. 단 Claude 역방향 채널은 SKILL.md 코어에 실행 커맨드가 없고, 이 파일의 host guard를 먼저 적용한다.

## 텍스트 과업 세부

(역방향 채널은 텍스트 검토·견해 전용 — 이미지 분석·생성 카테고리는 없다.)

```bash
timeout 280 claude -p --model sonnet --effort high --output-format json \
  --no-session-persistence < brief.txt
```

- **`--model` 생략 금지** — 실측: 모델을 안 정하면 `claude-opus-4-8`로 라우팅된다
  (콘솔 캡처에 `[1m]`이 붙어 보일 수 있으나 이는 ANSI SGR 포맷팅 아티팩트이며 모델
  식별자가 아니다). 의도치 않은 모델·비용을 피하려면 항상 `--model sonnet --effort
  high`를 명시할 것
- **비용 주의**: nested 호출은 매번 풀 세션을 새로 띄운다 — 실측 1회 호출에 컨텍스트
  캐시 생성 ~80~93K 토큰(약 $0.55). agy/codex 렌즈보다 한 자릿수 비싸다. 일상적
  교차점검은 agy/codex를 우선하고, 이 채널은 Claude 자체 시각이 꼭 필요할 때만 쓸 것
- **Codex Desktop에서 호출 시**: 샌드박스 내부 실행은 45초 무출력 timeout 관측(실측).
  **이미 host 정책상 unsandboxed/network-enabled 실행이 허용돼 있는 경우에 한해서만**
  그 경로로 실행할 것 — 이 문서가 새로운 샌드박스 우회·권한 상승을 권장하는 것은
  아니다. 허용되지 않은 환경이면 timeout을 실패로 보고하고 host 쪽 정책 확인을 안내

**read-only consult** (파일은 읽되 쓰기·실행 금지):

```bash
timeout 280 claude -p --model sonnet --effort high --output-format json \
  --no-session-persistence --disable-slash-commands \
  --allowedTools Read,Grep,Glob \
  --disallowedTools Bash,PowerShell,Edit,Write < brief.txt
```

또는 더 좁은 접근 — `--tools`로 허용 도구만 열거 (실측 2026-07-07 통과):

```bash
timeout 280 claude -p --model sonnet --effort high --output-format json \
  --no-session-persistence --disable-slash-commands \
  --tools Read,Grep,Glob < brief.txt
```

`--tools Read,Grep,Glob`는 이 설치된 CLI에서 실측 통과한 더 좁은 레시피이다.
임의 파일 생성 프롬프트를 `NO_WRITE_TOOL`로 거부함을 확인(2026-07-07). 단 이것은
이 CLI 버전에서의 관측이며, MCP/플러그인/도구 표면이 변경되면 결과가 달라질 수 있다
— 하드 샌드박스 보증으로 취급하지 말 것.

- ⚠️ **Windows 필수: `PowerShell`을 disallow 목록에 반드시 넣을 것.**
  `--disallowedTools Bash,Edit,Write`만 쓰면(흔한 실수) `Bash`라는 이름의 도구만
  막히고 별도 존재하는 `PowerShell` 도구는 안 막혀 임의 명령 실행이 그대로 뚫린다
  (실측 확인: "파일 하나 써봐" 요청이 PowerShell 경유로 실제 파일 생성에 성공,
  `permission_denials`조차 비어 있었음 — `PowerShell`을 목록에 추가하자 차단 확인)
- ⚠️ `--allowedTools`는 배타적 allowlist가 아니다 — 언급 안 된 도구는 기본값(가용)으로
  남는다. 안전은 `--disallowedTools`의 **포괄성**에서 나온다. **이 목록(`Bash,
  PowerShell,Edit,Write`)이 모든 환경에서 완전하다고 가정하지 말 것** — 실행·위임
  성격의 새 도구(WSL/ssh, 노트북 실행기, 쓰기 가능한 MCP 도구 등)가 있다면 그것도
  추가로 disallow해야 한다. 이 조합을 하드 샌드박스로 신뢰하지 말 것 — 실수 방지용이지
  적대적 콘텐츠에 대한 보증은 아니다
- `--allowedTools`/`--disallowedTools`는 가변 인자 옵션이라, 뒤에 prompt를 positional
  argument로 붙이면 prompt 단어를 도구명으로 오인할 수 있다. 위 예시처럼 **반드시 brief를
  stdin으로 넣을 것** (`< brief.txt` 또는 PowerShell pipe)
- Agent/Task 같은 위임형 도구는 환경별로 다르게 남을 수 있다. 2026-07-07 실측 2건:
  (1) 자기 제한 우회 시도를 하네스가 "deny-rule circumvention"으로 차단한 사례,
  (2) Agent가 가용했지만 하위 세션에도 쓰기·실행 도구가 없어 파일 생성이 불가능했던 사례.
  어느 쪽도 문서화·보장된 보안 경계가 아니다. 최종 방어선은 여전히 host guard와 brief
  큐레이션이지 위임 차단/상속 동작이 아니다

**tool-less review/challenge** (도구 없이 견해만):

```bash
timeout 280 claude -p --model sonnet --effort high --output-format json \
  --disable-slash-commands --tools "" < brief.txt
```

- PowerShell에서는 빈 문자열 인자가 사라져 `--tools ""`가 `argument missing`으로 실패할
  수 있다. 그때는 `--tools=`를 쓰거나 stop-parsing으로 `claude --% ... --tools ""`를
  사용한다 (둘 다 2026-07-07 실측 통과)
- ⚠️ 도구가 전혀 없어도 항상 깔끔하게 "도구 없음"으로 거부하지는 않는다 — brief가 파일
  접근을 요구하면 **가짜 tool-call을 narrate**할 수 있다(실측: 실제로는 아무것도 안
  읽었으면서 "Tool call: Read … Result: (whatever the tool returns)" 같은 placeholder를
  진짜 결과처럼 출력). brief 본문에 검토 대상을 전부 포함하고 파일 참조를 요구하지 말 것
- 이 모드도 `--model` 생략 시 위 opus 강등이 동일 적용되므로 예시처럼 항상 명시할 것

(이 블록의 커맨드는 SKILL.md 코어 fast-path 티저와 동일 문자열이어야 한다 — 코어 수정 시 여기도 동기화. Claude 역방향 채널은 코어에 실행 커맨드가 없으므로 host guard와 이 파일 내부 변형만 대조한다)

> **Codex Desktop / Windows 호스트 참고** (Claude 역방향 채널):
> 위 세 변형의 `< brief.txt`는 Bash stdin 리다이렉트이다. PowerShell에서는
> pipe로 대체한다:
>
> ```powershell
> Get-Content brief.txt | claude -p --model sonnet --effort high --output-format json --no-session-persistence
> ```
>
> `--tools ""`는 PowerShell에서 빈 문자열 인자가 누락되어 `argument missing`으로
> 실패할 수 있다 — `--tools=` 형태를 쓸 것 (실측 2026-07-07 통과).
>
> Codex Desktop 샌드박스 내부에서는 45초 무출력 timeout이 관측됨(실측). 이미
> 호스트 정책상 unsandboxed/network-enabled 실행이 허용된 경우에 한해 사용할 것.

## 설치·업데이트·복구

이 역방향 채널은 host가 codex/antigravity 등 **비-Claude일 때** 쓰므로, 그 호스트에
`claude` CLI가 없을 수 있다. 없으면 설치한다 — 공식 안내: <https://code.claude.com/docs/en/setup>

- **설치(권장: native installer, 백그라운드 자동 업데이트)**:
  - Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`
  - macOS·Linux·WSL: `curl -fsSL https://claude.ai/install.sh | bash`
  - npm 대안: `npm install -g @anthropic-ai/claude-code` (업데이트는 `@latest` 재설치, `npm update -g` 아님)
  - 설치 경로(native): `~/.local/bin/claude`.
- **업데이트**: native는 자동. 즉시 적용은 `claude update`. (winget/npm은 수동.)
- **검증**: `claude --version`(상세 `claude doctor`). **실제 스모크로 확인**한 뒤에만 성공으로
  본다(파일 존재 ≠ 동작).
- **stale PATH 주의**: 방금 설치·갱신했다면 이 세션(호스트 앱)이 그 전에 떠 있어 낡은 PATH를
  물 수 있다 — 호스트 앱 재시작(재부팅 불필요)으로 배제, 급하면 절대경로 직접 호출.
- **여러 채널 혼용 금지**: native·npm·winget을 섞으면 PATH 순서로 어느 게 실행될지 모호해진다
  (codex 어댑터에서 실측한 사고 — 낡은 본이 조용히 잡힘). 한 채널만 유지한다.
- **인증**: Pro/Max/Team/Enterprise 계정 필요(무료 플랜 불가). `claude` 실행 후 브라우저 로그인
  (OAuth라 에이전트가 대행 못 한다). 재설치는 `~/.claude` 설정을 건드리지 않는다.
