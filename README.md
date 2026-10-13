# English Conversation Studio

Claude와 영어로 대화하며 문법을 교정받는 로컬 웹 앱. **텍스트 / 음성 / 혼합** 모드를 대화 도중에도 바꿀 수 있고, 학습 요약은 GitHub Private 저장소로 동기화됩니다.

📖 처음이라면 [사용 설명서 (GUIDE.md)](GUIDE.md)부터 보세요. 라이선스: MIT.

## 빠른 시작 (Windows)
1. 필요: Node.js 20+, Git, [Claude Code](https://claude.com/claude-code) (한 번 `claude`로 로그인), 선택: GitHub CLI `gh`
2. `scripts\setup.cmd` — 환경 점검 / git 초기화 / 기록 가져오기
3. `scripts\start.cmd` — 서버 시작 + 브라우저 열기 (http://127.0.0.1:4177)

텍스트 모드는 추가 설치 없이 바로 동작합니다.

## 비용 / 인증 (확인된 사실)
- 기본 백엔드 `claude-cli`: 로그인된 Claude Code를 `claude -p`로 헤드리스 호출합니다. API 키가 필요 없지만 **구독 플랜의 사용량 한도를 소모**합니다 (턴당 대략 5~7초).
- API 키 백엔드는 제거했습니다. `claude` 실행 시 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 환경변수는 자식 프로세스에서 제거되어 항상 구독 로그인으로만 동작합니다.
- 모델은 `COACH_MODEL`(기본 `sonnet`)로 바꿀 수 있습니다.

## 모드
| 모드 | 입력 | 출력 |
|---|---|---|
| 텍스트 | 키보드 | 텍스트 |
| 음성 | 마이크 | 음성 + 텍스트 |
| 혼합 | 개별 선택 | 개별 선택 |

대화 화면 상단의 드롭다운으로 언제든 전환합니다. 같은 세션/대화 기록이 유지되고, 전환 시 재생·녹음은 먼저 정리됩니다. 마지막 모드는 `data/private/settings.json`에 기억됩니다.

## 교정 방식
영어 답변(`reply_en`, 음성으로 읽는 유일한 텍스트)과 교정(`corrections`, 화면에만 표시)은 분리된 JSON 구조입니다. 교정은 최대 3개, **문법 오류**와 **스타일 제안**은 따로 표시합니다. 한국어 설명은 읽어 주지 않습니다. 음성 인식 결과는 입력창에 먼저 표시되므로 확인/수정 후 전송할 수 있고, 인식 오류로 의심되면 문법 오류로 단정하지 않고 경고합니다. 발음 평가/점수는 제공하지 않습니다.

## Voice setup (선택)
두 엔진 중 자동 선택됩니다.
- **브라우저 음성 (기본 폴백, 설치 불필요)**: Web Speech API. ⚠️ Chrome/Edge의 음성 인식은 오디오를 브라우저 벤더의 클라우드로 보냅니다. Chrome/Edge 권장.
- **VoiceStudio (로컬, 실험적)**: https://github.com/debpalash/VoiceStudio 설치 후 실행하면(기본 포트 3900) 앱이 `/.well-known/voicestudio-speech`로 감지해 STT(`/v1/audio/transcriptions`)와 TTS(MCP `generate_speech`)를 루프백으로 프록시합니다. 설치는 원격 스크립트 실행(`irm https://voicestudio.sh/install | iex`)과 수 GB 모델이 필요하므로 **자동으로 설치하지 않습니다.** STT 요청 필드와 TTS 텍스트 파라미터명은 VoiceStudio 문서에 명시되어 있지 않아 실제 설치본으로 검증이 필요합니다.
- 에코 방지: 재생 중에는 마이크가 비활성화(반이중)되며 `echoCancellation`을 켭니다. 이어폰 사용을 권장합니다.
- Push-to-Talk: 마이크 버튼을 누르고 있는 동안 녹음 (버튼 포커스 후 Space 길게도 가능). "발화 종료 자동 감지"를 켜면 말이 끝난 뒤 자동 전송합니다.

## 학습 기록 & 동기화
- `data/private/` (gitignore): 원본 대화, 설정, 머신 ID. 절대 업로드되지 않습니다.
- `data/sync/sessions/<날짜>_<머신>_<id>.json`: 세션당 파일 1개의 정제된 요약(이메일/URL/숫자 마스킹, 원문 대화 미포함). PC끼리 같은 파일을 수정하지 않으므로 충돌이 나지 않습니다. 진도/복습은 읽을 때 전체 요약을 집계합니다.
- 시작 시: `git fetch` + `pull --ff-only` (실패 시 아무것도 건드리지 않고 안내). 종료 시: 허용 목록만 stage → commit → push (거부되면 병합 시도, 충돌이면 병합 취소 후 안내). force push, hard reset, `git add -A` 없음. 오프라인이면 로컬에 커밋만 남고 다음 sync에 push됩니다.
- 수동: `scripts\sync.cmd`, 상태: `scripts\status.cmd`

## 다른 PC에서 복원
```
git clone https://github.com/<you>/english-conversation-studio
cd english-conversation-studio
scripts\setup.cmd
scripts\start.cmd
```
Claude Code 로그인, `gh auth login`, 음성 환경(VoiceStudio/마이크)은 PC마다 따로 설정합니다.

## English Coach 스킬
`.claude/skills/english-coach/` 에 [tianmind-studio/english-coach](https://github.com/tianmind-studio/english-coach)(MIT)의 `SKILL.md`를 프로젝트 안에 그대로 복사(vendored)해 두었고, 코칭 규칙 참고용으로 시스템 프롬프트에 포함됩니다. 원본 설치 명령은 전역(`-g`) 설치라서 사용하지 않았습니다.

## 제약
- 브라우저 음성 인식은 클라우드 서비스를 사용합니다.
- VoiceStudio 연동은 실제 설치본에서 검증되지 않았습니다.
- 윈도우 장치(마이크/스피커) 조작이 필요한 테스트는 사용자가 직접 수행해야 합니다.
