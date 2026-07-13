# enforcement.md — 강제는 caller의 몫 (중개자는 차단하지 않는다)

second-opinion은 **중개(relay) 스킬**이다 — 요청을 외부 벤더로 넘기고 결과를 돌려줄 뿐, **아무것도 차단하지 않는다.** 커맨드 정합성(예: 이미지 생성일 때만 `-s workspace-write`)은 디스패처(`scripts/dispatch.mjs`)가 보장하는 **도구**다.

"Claude가 벤더를 직접 부르지 말고 반드시 디스패처를 거치게" 강제하고 싶다면, 그건 **부르는 쪽(caller) 프로젝트의 정책**이다. 중개자가 온 머신에 전역으로 강제하면 다른 프로젝트(madi 등)의 정당한 codex/agy 직접호출까지 막는다 — 그게 0.5.x가 저지른 버그이자 이 문서의 이유다.

## caller가 자기 프로젝트에서 강제하는 법

강제를 원하는 프로젝트는 **자기 레포 스코프**에 PreToolUse 훅을 건다.

### 1. 훅 입력 형태
PreToolUse 훅은 stdin으로 JSON을 받는다:

```json
{ "tool_name": "Bash", "tool_input": { "command": "timeout 280 codex exec - < brief.txt" } }
```

`tool_input.command`에서 명령 문자열을 꺼내 판정한다.

### 2. 최소 훅 스크립트 + 등록 (프로젝트 로컬)

훅 스크립트 — command를 읽어 직접호출이면 exit 2, 아니면 exit 0(fail-open):

```js
// your-project/.claude/hooks/block-direct-vendor.mjs
import { detectDirectInference } from "./detect-vendor.mjs";  // (3)에서 복사한 탐지 로직(같은 이름 유지)
let raw = ""; for await (const c of process.stdin) raw += c;
let cmd = "";
try { cmd = JSON.parse(raw)?.tool_input?.command ?? ""; }
catch { process.exit(0); }                          // 깨진 입력 → 통과(fail-open)
if (detectDirectInference(cmd)) {                   // 벤더명(truthy) 반환 시 차단, null이면 통과
  process.stderr.write("Direct codex/agy call blocked in THIS project — route through your dispatcher.\n");
  process.exit(2);
}
process.exit(0);
```

등록 — 프로젝트 훅 설정에 PreToolUse로 건다(예: `your-project/.claude/hooks.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/block-direct-vendor.mjs\"" }
        ]
      }
    ]
  }
}
```

### 3. 탐지 로직 — 복사해서 쓴다 (import 아님)

탐지 참조 구현은 `scripts/vendor-policy.mjs`의 `detectDirectInference(command)`다 — codex `exec` 서브커맨드 / agy 비-관리 호출을 (셸 구분자·투명 wrapper[timeout·env 등] 건너뛰기·셸 wrapper[bash -lc·cmd /c] 재귀까지) 판정해 벤더명 또는 null을 돌려준다.

**그 파일을 직접 import하지 말 것.** 플러그인은 전역 버전 고정 경로(`~/.claude/plugins/cache/second-opinion/<버전>/…/scripts/vendor-policy.mjs`)에 설치돼, 버전이 오르면 그 경로가 깨진다. 대신 `detectDirectInference` 로직을 **네 레포로 복사**해(위 예시의 `./detect-vendor.mjs`, 같은 함수명 유지) 직접 관리하라. (안정적 모듈 경로가 필요하면 CLI/패키지 배포는 향후 과제다.)

## 경계

이 훅은 **그 프로젝트에서만** 발동한다. 다른 프로젝트의 codex/agy 직접호출은 건드리지 않는다 — 그게 중개자와 caller-강제의 올바른 스코프다.
