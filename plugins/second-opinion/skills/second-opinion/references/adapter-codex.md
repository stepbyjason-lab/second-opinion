# adapter-codex — Codex/GPT

기본 커맨드는 SKILL.md fast-path 참조.

## 텍스트 과업 세부

- git repo가 아닌 cwd면 `codex exec --skip-git-repo-check -`
- 출력 머리에 taskkill 한글 잡음(프로세스 정리 메시지)이 섞일 수 있음 — 본문만 취하면 됨
- ⚠️ Windows에서 codex sandbox의 **파일 읽기는 불능**(CryptUnprotectData 오류 실측) — "이 파일 읽어봐"는 안 되고, 내용을 brief에 **발췌 동봉**해야 한다

(이 블록의 커맨드는 SKILL.md 코어 fast-path 티저와 동일 문자열이어야 한다 — 코어 수정 시 여기도 동기화)

> **Codex Desktop / Windows 호스트 참고** (실측 2026-07-08):
> SKILL.md fast-path의 Bash 예시는 Bash (Git Bash / WSL) 문법이다. Codex Desktop의 `exec_command`는
> 기본적으로 PowerShell을 실행하므로 Bash `timeout 280 ... < brief.txt` 구문은
> 직접 사용할 수 없다. PowerShell 등가 패턴:
>
> ```powershell
> Get-Content brief.txt | codex exec - > out.txt 2> err.txt
> ```
>
> PowerShell에는 Bash `timeout`에 대응하는 내장 명령이 없다 (Windows `timeout.exe`는
> 대기 타이머이지 프로세스 실행시간 제한이 아니다). 호스트가 자체 실행시간 제한을
> 두고 있다면 그것에 의존하고, 아니면 brief 크기를 합리적으로 제한하는 것이 실용적이다.

## 파일 산출물 과업 — 이미지 생성

### Codex (gpt-image-2)

```bash
echo "Use the built-in image_gen tool to generate an image. Prompt: '<프롬프트>'. Size: 1024x1024. Copy the result to '<원하는 절대경로>.png' and print the saved path." | timeout 280 codex exec -s workspace-write --skip-git-repo-check -
```

- **`-s workspace-write` 필수** — 기본 샌드박스에선 이미지 과업을 수행하지 못한다 (실측:
  NO-IMAGE-CAPABILITY 회신)
- 산출물 원본은 `~/.codex/generated_images/<세션>/`에 생성된다. Windows에선 요청 경로로의
  복사가 샌드박스 오류로 실패할 수 있다(벤더는 실패를 정직하게 보고) — 그 폴더에서 최신
  파일을 직접 회수해 원하는 위치로 복사한다

## 벤더 불능 시 — Codex 복구 커맨드

- **`codex` 명령을 못 찾으면 곧바로 "미설치"로 단정하지 말 것** — 순서대로 확인:
  1. **stale PATH 의심**: 방금 codex를 설치·재설치했다는 언급이 있었다면, 이 세션(또는
     호스트 앱)이 그보다 먼저 떠 있었을 수 있다 — 새 PATH는 새로 뜬 프로세스만 읽는다.
     Claude Code 앱 재시작(재부팅까지는 불필요)으로 먼저 배제
  2. **winget 설치 흔적 확인** (실측 확정 버그 — 아래 참고). **user-scope와 machine-scope
     둘 다** 확인할 것(`winget install --scope machine`이면 Program Files에 깔린다):
     `find "$LOCALAPPDATA/Microsoft/WinGet/Packages" "/c/Program Files/WinGet/Packages" -maxdepth 1 -iname "OpenAI.Codex_*" 2>/dev/null`
     (PowerShell: `Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages","$env:ProgramFiles\WinGet\Packages" -Filter "OpenAI.Codex_*" -ErrorAction SilentlyContinue`)
     — 나오면 3번, 안 나오면 진짜 미설치로 간주해 기존대로 `npm install -g @openai/codex` → `codex login`
  3. **winget 별칭 버그 진단** — 해당 폴더 안 실행파일은 `codex.exe`가 아니라
     `codex-x86_64-pc-windows-msvc.exe`(타깃-트리플) 이름 그대로다. winget 설치 로그가
     "별칭 추가함"이라 표시해도 실제로는 안 만들어진 것 — **알려진 미해결 upstream 버그**
     ([openai/codex#28321](https://github.com/openai/codex/issues/28321)). 두 가지 중 선택:
     - **권장**: `winget uninstall OpenAI.Codex` 후 공식 스크립트로 재설치 —
       Windows: `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`
       (이 경로는 `codex.exe`를 정상 이름으로 설치하고 PATH도 즉시 갱신한다 — 버그 없음)
     - **비파괴적 우회**: 위 find/Get-ChildItem으로 찾은 폴더 안에서 `codex-*.exe`
       (helper인 `codex-command-runner.exe`·`codex-windows-sandbox-setup.exe` 제외) 실행파일을
       찾아, 이미 PATH에 있고 사용자 소유인 안전한 디렉토리(예: npm 전역 bin — PATH 포함
       여부와 기존 `codex`/`codex.cmd` 부재를 먼저 확인)에 그 경로로 포워딩하는 `codex`(bash)
       `codex.cmd`(PowerShell/cmd) shim을 만든다. **`codex --version`으로 실제 검증** 후에만
       성공으로 보고 — 파일을 만들었다는 것 자체가 성공이 아니다
     - 참고(별개 이슈, 혼동 금지): 이 실행파일이 일부 환경에서 Windows Defender에
       Trojan으로 오탐되는 사례도 있다 ([openai/codex#3207](https://github.com/openai/codex/issues/3207))
- Codex 인증 만료(`refresh_token_reused` 포함): 터미널에서 `codex login` 1회
  (브라우저 OAuth라 에이전트가 대신 못 한다)
- `refresh_token_reused`는 같은 refresh token이 두 번 쓰인 것(전형: auth.json을
  머신 간 복사/sync). 재로그인으로 풀리지만, **auth 파일을 머신 간 복제하지 않는 것**이
  근본 해법이다. 머신별 독립 `codex login`은 안전하게 공존한다 (통제 실험 2026-07-03:
  한 머신의 신규 로그인 전후로 다른 머신 정상 동작 확인).
