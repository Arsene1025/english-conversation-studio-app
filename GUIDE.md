# 사용 설명서

Claude와 영어로 대화하며 문법/표현을 교정받는 로컬 웹 앱입니다. (자세한 내용은 [README](README.md))

## 1. 준비물
- Windows, [Node.js](https://nodejs.org) 20 이상, Git
- [Claude Code](https://claude.com/claude-code) 설치 후 터미널에서 `claude`를 한 번 실행해 **로그인**
  - 이 앱은 로그인된 Claude Code 계정(구독 플랜)의 사용량을 씁니다. API 키는 쓰지 않습니다.
- (선택) 음성 대화: Chrome 또는 Edge + 마이크

## 2. 설치와 실행
```
git clone https://github.com/Arsene1025/english-conversation-studio-app
cd english-conversation-studio-app
scripts\setup.cmd     # 환경 점검 (처음 한 번)
scripts\start.cmd     # 서버 시작, 브라우저가 http://127.0.0.1:4177 로 열림
```
종료는 서버 창에서 `Ctrl+C`.

## 3. 사용 방법
1. 상단 드롭다운에서 모드를 고릅니다: **텍스트 / 음성 / 혼합** (대화 중에도 변경 가능)
2. 영어로 말하거나 입력하면 Claude가 영어로 답하고, 틀린 부분은 **교정 카드**(최대 3개)로 한국어 설명과 함께 보여줍니다.
   - 문법 오류와 스타일 제안은 구분되어 표시됩니다.
   - 음성 인식 결과는 입력창에 먼저 나오니 확인/수정 후 전송하세요. 인식 오류는 문법 오류로 취급하지 않습니다.
3. 진도와 복습 목록은 쌓인 세션 요약에서 자동 집계됩니다. 발음 점수는 제공하지 않습니다.

## 4. 학습 기록
- `data/private/` — 원본 대화와 설정. 내 PC에만 있고 업로드되지 않습니다.
- `data/sync/sessions/` — 정제된 세션 요약. 여러 PC에서 학습 기록을 이어가려면 **본인의 Private GitHub 저장소**에 연결해 동기화합니다 (`scripts\sync.cmd`, 상태 확인은 `scripts\status.cmd`).
- 동기화가 필요 없으면 아무 설정도 하지 않아도 됩니다.

## 5. Claude Code 슬래시 커맨드 (선택)
이 폴더에서 Claude Code를 열면 쓸 수 있습니다.
| 명령 | 동작 |
|---|---|
| `/start` | 서버 시작 |
| `/sync` | 학습 기록 수동 동기화 |
| `/status` | 동기화 / 진도 / 음성 상태 확인 |

`.claude/skills/english-coach/`는 코칭 규칙 참고용 스킬입니다.

## 6. 음성 모드
- 기본은 브라우저 음성(Web Speech API). Chrome/Edge의 음성 인식은 오디오를 브라우저 벤더 서버로 보냅니다.
- 로컬 엔진 VoiceStudio(실험적)는 별도 설치가 필요하며 자동 설치하지 않습니다. README의 "Voice setup" 참고.
- 말하기: 마이크 버튼을 누르고 있는 동안 녹음합니다. 에코 방지를 위해 이어폰을 권장합니다.

## 7. 문제 해결
| 증상 | 해결 |
|---|---|
| `Claude Code CLI not found` | Claude Code 설치 후 새 터미널에서 `claude` 실행 |
| 응답이 오지 않음/에러 | `claude`로 로그인되어 있는지, 구독 사용량 한도가 남았는지 확인 |
| 포트 충돌 (4177) | 이미 실행 중인 서버를 종료하거나 `scripts\start.ps1 -Port 4178` |
| 동기화 실패 | `scripts\status.cmd`로 확인. 충돌 시 앱은 병합을 취소하고 안내만 합니다 (강제 덮어쓰기 없음) |

## 8. 개발
`npm test` — 가짜 코치와 임시 git 저장소를 쓰므로 실제 데이터를 건드리지 않습니다.
