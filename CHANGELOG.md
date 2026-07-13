# Changelog

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
