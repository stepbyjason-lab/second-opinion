# adapter-codex — Codex/GPT

기본 커맨드는 SKILL.md fast-path 참조.

금지(하지마) 규칙에는 근본원인(버전·버그·환경)을 함께 적는다 — 원인이 바뀌면 우회 해제 여부를 판단할 수 있다.

## 텍스트 과업 세부

### 통합 생성 adapter 계약

`--request-json/--response-json` 경로에서 Codex adapter는 request의 `system`과 `user`를
서로 다른 필드로 받은 뒤 단일-stdin CLI의 명시적 tagged 경계로 직렬화한다. stdout
chunk는 해당 시도가 완료되고 usage까지 검증된 뒤에만 상위 streaming observer에 전달한다.
재시도하더라도 `max_completion_tokens`를 나누거나 바꾸지 않는다. Codex CLI에는 이 상한을
전달할 provider-native 인자가 없으므로 영수증의 `completionTokenLimit`는 요청값과
`not-applicable-cli`를 명시한다.
정상 종료한 구독 어댑터의 출력이 문자열로 존재하지만 공백뿐이면 `vendor-error`/`vendor`
일시 실패로 같은 provider를 재시도한다. 형식 파싱이 실패한 malformed 응답은 영구 실패다.
완료 뒤 Codex rollout
영수증의 token count를 `prompt_tokens`·`completion_tokens`·`total_tokens`로 표준화하며,
usage가 없으면 성공처럼 반환하지 않는다. Codex CLI가 응답 model을 직접 보고하지 않으므로
이 경로의 `model_reported`는 정직하게 `none`이다. usage를 읽는 내부 임시 receipt는 caller가
설정한 `SECOND_OPINION_RECEIPT`·`SECOND_OPINION_PORTABLE_RECEIPT`와 분리되며, caller sink는
기존 raw writer와 shipped closed portable emitter가 그대로 기록한다.
두 영수증 모두 `transport=cli`, `vendor=codex`, `provider=null`, 호출자가 준 `lensId`(없으면
`null`)를 기록한다. HTTP provider로의 폴백은 없고 Codex 실패는 다른 벤더 호출로 이어지지 않는다.

### 모델 입력 정규화

dispatcher는 `--effort`가 따로 없을 때 `--model 5.6 sol@ultra`의 마지막 `@ultra`를
effort로 분리한다. `light`·`very-high`·`maximum`은 각각 `low`·`xhigh`·`max`로 바뀌며,
현재 Codex 전체 표면은 `low | medium | high | xhigh | max | ultra`이며 자동 라우팅은
선택 모델이 카탈로그에서 광고한 지원값만 허용한다. Codex 모델 값은
`CODEX_HOME/models_cache.json` 또는 기본 `~/.codex/models_cache.json`의 slug,
display name, 논리 별칭을 대소문자·구분자 차이 없이 대조한다.

예: `terra` → `gpt-5.6-terra`, `gpt 5.5` 또는 `5.5` → `gpt-5.5`.
동순위 후보가 복수면 추측하지 않는다. 명시적 `--vendor codex` 호출에서 로컬 cache를
읽지 못하거나 일치하지 않으면 원문을 전달해 Codex의 loud reject에 맡긴다.

고정 별칭표와 fuzzy matching은 없다. `--vendor` 생략 시 쓰는 공급자 통합 cache 정책은
SKILL.md를 따른다. receipt의 `modelRequested`는 호출자의 원문이고 `model`은 실제 CLI에
전달한 정규화 결과다. `--effort`를 따로 명시한 호출은 `model@effort`를 분해하지 않는다.

### 명시적 review mode

`--mode review`는 실제 repo cwd에서 native `codex exec review -`로 번역한다. sandbox,
worktree, snapshot, packet 분리를 만들지 않는다. mode 생략은 기존 `codex exec -`다.
Codex CLI에는 이 계약이 요구하는 non-sandbox native plan mapping이 없으므로
`--mode plan`은 호출 전 `mode_unsupported`로 실패하며 default로 폴백하지 않는다.

⚠ **Codex의 `--mode review`는 권한을 제한하지 않는다 — Codex CLI의 한계다.**
Claude는 `--tools` allowlist로, AGY는 native plan + 읽기 전용 입력 프로필로 쓰기 도구를
실제로 없앤다. Codex에는 그 층이 없다 — 권한을 좁히는 수단이 샌드박스(`-s read-only`)
뿐인데 이 프로젝트는 샌드박스를 쓰지 않는다(맥락 전달이 어렵고 결과 품질이 떨어진다).
`codex exec review --help`가 내놓는 옵션도 `--uncommitted`·`--base`처럼 **무엇을 볼지**를
고르는 것이지 권한이 아니다. 실측: `--mode review`로 부른 호출의 영수증에
`sandbox: danger-full-access`가 그대로 찍혔고, 그 값은 mode가 아니라
`~/.codex/config.toml`의 `sandbox_mode`에서 온다.
→ **Codex 리뷰에서 파일을 지키는 것은 brief의 금지 지시뿐이다.** `--mode review`를
읽기 전용 보증으로 계산하지 말고, 쓰기 금지가 중요하면 brief에 명시하고 호출 후
`git status`로 확인한다.

- 비-git cwd는 디스패처가 `--skip-git-repo-check`를 자동 판정·삽입한다
- 출력 머리에 taskkill 한글 잡음(프로세스 정리 메시지)이 섞일 수 있음 — 본문만 취하면 됨
- codex는 로컬 파일을 읽는다(전 sandbox 모드 실측). 큰 내용은 파일로 두고 경로를 지시한다.
  과거 CryptUnprotectData 오류는 elevated sandbox 계정의 DPAPI stale 버그로 상위 수정됐다.
  재발 시 `/sandbox-add-read-dir`로 읽기 디렉토리를 추가하거나 `[windows] sandbox="unelevated"`,
  또는 bypass를 쓰며, 내용을 brief에 **발췌 동봉**하는 방법은 안전 폴백으로 유지한다

정본은 `scripts/vendor-policy.mjs`이며 아래 커맨드는 비정본 설명이다.

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

## 파일 입력 과업 — 이미지·영상 분석

이미지는 `-i`로 붙이고 분석 지시는 stdin으로 준다.

```bash
codex exec -i <이미지파일> - < brief.txt
```

영상은 ffmpeg가 필요하다. 먼저 프레임을 추출하고, 대표 프레임들을 각각 `-i`로 모델에 전달한다.

```bash
mkdir -p frames
ffmpeg -i <영상파일> -vf "fps=1/5" frames/frame-%03d.png
codex exec -i frames/frame-001.png -i frames/frame-002.png - < brief.txt
```

## 파일 산출물 과업 — 이미지 생성

### Codex (gpt-image-2)

**brief 내용 (정본 — Claude가 brief에 담는다)**: 먼저 `references/image-craft.md`로 프롬프트를 채운 뒤, brief에 아래 image_gen 지시를 담는다:

```text
Use the built-in image_gen tool. Prompt: '<프롬프트>'. Size: 1024x1024 (또는 1024x1536/1536x1024/auto). Quality: auto (또는 low/medium/high). Count: 1 (여러 장이면 원하는 장수). 저장 파일명: 1장이면 '<타임스탬프 절대경로>.png', 2장 이상이면 '<타임스탬프 절대경로>-1.png'/'-2.png' 식 suffix (확장자 .png는 한 번만, 기존 파일 덮어쓰지 말 것). print the saved path(s).
```

**실행 (정본 — 디스패처)**: `node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor codex --operation image-generate --brief brief.txt [--model <라벨> --effort <레벨>] --out out.txt --err err.txt` — 디스패처가 `-s workspace-write`를 자동 삽입한다. raw `echo … | codex exec -s workspace-write …`는 비정본(내부 동작 설명용)이며 정본은 디스패처 호출이다.

- **`-s workspace-write` 필수** — 기본 샌드박스에선 이미지 과업을 수행하지 못한다 (실측:
  NO-IMAGE-CAPABILITY 회신)
- 산출물 원본은 `~/.codex/generated_images/<세션>/`에 생성된다. Windows에선 요청 경로로의
  복사가 샌드박스 오류로 실패할 수 있다(벤더는 실패를 정직하게 보고) — 그 폴더에서 최신
  파일을 직접 회수해 원하는 위치로 복사한다

- **프롬프트 품질**: 이미지 생성 전 `references/image-craft.md`(벤더무관 프롬프트 크래프트)로
  프롬프트를 채운다 — 조명·카메라·스타일·구도를 구체화하면 결과가 확연히 좋아진다.
- **네거티브 프롬프트 미지원**: gpt-image-2는 네거티브 프롬프트를 지원하지 않는다 — "피할 것"을
  나열하지 말고 원하는 것을 긍정문으로 묘사한다("no blur" 대신 "sharp focus").
- **이미지 에러 처리**: 모델 접근 거부 → OpenAI 플랜에 gpt-image-2 접근 권한 확인 ·
  생성 timeout(2분+) → `quality`를 낮춰(예: low) 재시도 · rate limit → 잠시 후 재시도.
- **비용(대략, OpenAI 계정 청구)**: 1024x1024 low ~$0.02 · 1024x1024 high ~$0.04 · 1024x1536 high ~$0.06.

## 설치·업데이트·복구

**정본 = 공식 standalone installer 하나로만 유지한다.** 여러 채널(npm·winget·수동 배치)을 섞지 않는다.
- 설치·업데이트(같은 명령, Windows) — 공식 안내: <https://learn.chatgpt.com/docs/codex/cli#getting-started>

  ```powershell
  powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
  ```

  - 설치 경로: `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` (installer가 User PATH에 자동 등록).
  - **업데이트도 위 명령 재실행**이 정본이다(별도 업데이트 명령 없음).

- **여러 채널 혼용 금지**(2026-07-11 실측 사고): npm 전역·winget·수동 배치본을 섞으면 PATH 순서로
  어느 게 실행될지 모호해져 **낡은 본이 조용히 잡히고**, 최신 모델(예: gpt-5.6)이 서버에서 400
  `"requires a newer version of Codex"`를 낸다(= CLI가 낡은 것이지 모델이 막힌 게 아니다).
  기존 난립본은 정리한다: `winget uninstall OpenAI.Codex` + npm shim(`~/AppData/Roaming/npm/codex{,.cmd}`)·
  수동 폴더 삭제. installer 재실행으로 최신 갱신.

- **`codex`를 못 찾거나 낡은 게 잡히면** — "미설치"로 단정 말고 순서대로:
  1. **stale PATH 먼저 배제**: 방금 설치·갱신했다면 이 세션(또는 호스트 앱)이 그 전에 떠 있어
     낡은 PATH를 문 것이다 — 새 User PATH는 새로 뜬 프로세스만 읽는다. **호스트 앱 재시작**
     (재부팅 불필요)으로 배제. 급하면 절대경로 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`
     직접 호출. **`codex --version` + 실제 모델 스모크로 검증**한 뒤에만 성공으로 본다(파일 존재 ≠ 동작).
  2. 그래도 없으면 위 installer 재실행.

- Codex 인증 만료(`refresh_token_reused` 포함): 터미널에서 `codex login` 1회
  (브라우저 OAuth라 에이전트가 대신 못 한다). 재설치는 `~/.codex/`(auth 포함)를 건드리지 않으므로
  재로그인이 필요 없는 게 정상.
- `refresh_token_reused`는 같은 refresh token이 두 번 쓰인 것(전형: auth.json을
  머신 간 복사/sync). 재로그인으로 풀리지만, **auth 파일을 머신 간 복제하지 않는 것**이
  근본 해법이다. 머신별 독립 `codex login`은 안전하게 공존한다 (통제 실험 2026-07-03:
  한 머신의 신규 로그인 전후로 다른 머신 정상 동작 확인).
