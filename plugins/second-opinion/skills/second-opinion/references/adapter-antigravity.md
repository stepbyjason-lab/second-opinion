# adapter-antigravity — Antigravity/Gemini

기본 커맨드는 SKILL.md fast-path 참조.

금지(하지마) 규칙에는 근본원인(버전·버그·환경)을 함께 적는다 — 원인이 바뀌면 우회 해제 여부를 판단할 수 있다.

## 텍스트 과업 세부

- **brief는 무-플래그 stdin으로** (파일 리다이렉트) — 대용량 실측 통과, argv 경로의
  30,000자 한계 없음. 파일 리다이렉트가 stdin을 닫아주므로 hang 걱정도 없다.
  `-p -`는 1.1.1에서 `-`가 리터럴 프롬프트로 바뀌어 깨졌다. stdin은 미문서화
  (#525/#542)라 자동업데이트로 다시 깨질 수 있으므로, 대형 입력이나 재파손 시
  `--add-dir`로 디렉토리를 허용하고 파일 경로를 읽게 하는 폴백을 쓴다
- ⚠️ argv로 줄 때(`-p "$(cat brief.txt)"`)만 적용되는 함정 둘: **`</dev/null` 필수**
  (stdin 안 닫으면 무한 hang) + **30,000자 한계** (Windows CreateProcess) — 특별한
  이유가 없으면 stdin 경로를 기본으로 쓸 것
- ⚠️ `--model`은 **디스플레이 라벨 그대로**(`"Gemini 3.1 Pro (High)"`). slug/ID 형식(`gemini-3-1-pro-high` 등)은 **exit 0인 채 silent-ignore → 계정 기본값(저급 모델)으로 조용히 강등** (실측). **정확한 라벨은 `agy models`로 확인**해서 그대로 복사할 것
- 모델 메뉴 (`agy models` 실측, 2026-07-03 기준 — 라벨은 벤더가 바꿀 수 있으니 실행해
  재확인): Gemini 3.1 Pro (High/Low) · Gemini 3.5 Flash (High/Medium/Low) ·
  GPT-OSS 120B (Medium) · Claude Opus/Sonnet 4.6 (Thinking)
- ⚠️ `antigravity chat`은 이 스킬의 headless 채널이 아니다 — IDE 채팅 디스패치이며
  `--model` 표면이 `agy`와 다르다. headless second-opinion에는 반드시 `agy`를 쓸 것
- ⚠️ quota: 사용량이 여러 모델에서 **동일 %로 동반 상승**하는 것이 관측됨 (2026-07-03
  사용자 실측) — **모델을 바꾸면 quota를 아낀다고 가정하지 말 것** (풀 구조 미확정)
- ⚠️ Antigravity가 제공하는 Claude 모델(Opus/Sonnet)은 Claude Code 결과를 독립
  벤더로 교차 검증했다는 증거가 아니다. 사용자가 Claude-family 고추론 렌즈를 명시하면
  쓸 수 있지만, 그 결과는 Antigravity 호스트의 Claude-family 의견으로 라벨링하고
  Claude Code host/runtime 검증으로 포장하지 말 것
- Codex 불능 상태에서 GPT 계보의 제3 시각이 필요하면: **`"GPT-OSS 120B (Medium)"`**
  (OpenAI 오픈웨이트, Antigravity 제공 — 실측). 단 Codex 본체의 대체가 아니라 추가
  시각이며, 지명 벤더 무단 대체 금지 규칙은 그대로 적용된다
- **인증: Antigravity IDE 로그인을 공유** (실측) — IDE에 로그인돼 있으면 agy 별도
  로그인 불필요. IDE가 없거나 응답 없이 exit 0이면 `agy` 1회 대화 실행(로그인) 안내

(이 블록의 커맨드는 SKILL.md 코어 fast-path 티저와 동일 문자열이어야 한다 — 코어 수정 시 여기도 동기화)

> **Codex Desktop / Windows 호스트 참고** (실측 2026-07-08):
> SKILL.md fast-path의 Bash 예시는 Bash 문법이다. Codex Desktop의 `exec_command`에서는 `timeout`과
> `< brief.txt` 리다이렉트를 그대로 쓸 수 없다.
>
> `agy`가 PATH에 없을 수 있다 — Codex 세션에서 `Get-Command agy`가 실패하면
> 다음 fallback 경로를 사용 (실측 확인):
> `$env:LOCALAPPDATA\agy\bin\agy.exe`
> (예: `C:\Users\<user>\AppData\Local\agy\bin\agy.exe`)
>
> PowerShell 등가 패턴:
>
> ```powershell
> $agy = if (Get-Command agy -ErrorAction SilentlyContinue) { "agy" } else { "$env:LOCALAPPDATA\agy\bin\agy.exe" }
> Get-Content brief.txt | & $agy --model "Gemini 3.1 Pro (High)" > out.txt 2> err.txt
> ```
>
> `agy models` 출력으로 사용 가능한 모델 라벨을 확인할 수 있다 (Codex 세션에서도
> 실측 통과 — 2026-07-08).

## 파일 입력 과업 — 이미지·영상 분석

이미지와 영상 모두 파일이 있는 디렉토리를 허용하고 짧은 경로 지시를 준다. argv 프롬프트를
쓰므로 기존 hang 방지를 위해 `</dev/null`을 유지한다.

```bash
FILE="<이미지 또는 영상 파일의 절대경로>"
timeout 280 "$AGY" --model "Gemini 3.1 Pro (High)" --add-dir "$(dirname "$FILE")" -p "Read and analyze this file: $FILE" </dev/null
```

## 파일 산출물 과업 — 이미지 생성

이미지 생성 전 `references/image-craft.md`(벤더무관 프롬프트 크래프트)로 프롬프트를 채운다.

### Antigravity (agy)

```bash
echo "Generate an image: <프롬프트>. Save it as <파일명>.png." | timeout 280 "$AGY"
```

- 사진급 생성모델 실측 확인. 단 **저장 위치 지시를 무시**하고 자기 scratch 디렉토리
  `~/.gemini/antigravity-cli/scratch/`에 저장한다 (파일명은 지시대로 따름) — 거기서
  회수해 사용자가 원한 위치로 복사
- "IMG-SAVED" 같은 성공 답변이 요청 경로 기준으로는 거짓일 수 있다 (실측)

## 벤더 불능 시 — Antigravity 복구 커맨드

- **설치·업데이트(같은 명령, 공식 installer)** — Windows PowerShell:
  `irm https://antigravity.google/cli/install.ps1 | iex`
  / macOS·Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
  (v1.0.15 미만은 Windows 비-TTY 출력 유실 버그 — 이상이면 위 명령 재실행으로 업데이트).
  **검증**: `agy --version` + 실제 스모크(파일 존재 ≠ 동작). Antigravity IDE가 깔려 있어도
  headless CLI `agy`는 별개다 — IDE 존재를 설치됨으로 오인하지 말 것. 채널 혼용 시 stale
  PATH로 낡은 본이 잡힐 수 있으니(codex 실측 사고) 설치 후 호스트 앱 재시작으로 배제.
- agy 인증 문제: `agy` 1회 대화 실행(재로그인)
