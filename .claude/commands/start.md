---
description: English Conversation Studio 서버를 시작하고 브라우저를 엽니다
allowed-tools: Bash(powershell:*), Bash(node:*)
---
English Conversation Studio를 실행하세요.

1. Bash 도구의 `run_in_background: true`로 다음 명령을 실행합니다:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1`
2. 몇 초 뒤 백그라운드 출력에서 "English Conversation Studio: http://127.0.0.1:4177" 줄과 `[sync]` 줄을 확인합니다.
3. 사용자에게 주소(http://127.0.0.1:4177, 브라우저는 자동으로 열림)와 `[sync]` 결과를 한 줄로 알려 주세요. 포트 충돌 등 오류가 나면 원인을 알려 주세요.
