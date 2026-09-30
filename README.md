# SilverBridge QA - 실제 화면 E2E 자동화

Playwright 로 **dev 서버(https://devdmu.gosky.kr)의 실제 화면**을 브라우저로 조작해서, 기능이 의도대로 동작하는지 검사한다.
단위·통합 테스트가 못 잡는 것(FE↔BE 계약, 실시간 알림, 역할별 화면 이동, 외부 서비스 연동, 접근성)을 잡는 게 목적이다.

## 실행

```bash
cd ~/SilverBridgeQA
npm test              # 전체 (약 4분, 한 개씩 순서대로)
npm run test:smoke    # 스모크만 (메뉴·접근 제어, 약 30초)
npm run test:headed   # 브라우저 창을 띄워서 보면서 실행 (WSLg)
npm run test:ui       # Playwright UI 모드 (테스트 골라 실행·디버깅)
npm run report        # 마지막 결과 HTML 리포트 열기 (http://localhost:9323)
npx playwright test tests/sos          # 폴더 하나만
npx playwright test -g "연결 요청"      # 이름으로 골라서
```

처음 한 번만:

```bash
npm install
npx playwright install chromium
npm run init:env      # .env 생성 (테스트 계정 비밀번호 자동 생성)
sudo apt install -y fonts-noto-cjk   # 스크린샷의 한글이 □ 로 나오지 않게 (선택)
```

필요 조건: WSL 에서 `ssh gosky` 가 비밀번호 없이 되어야 한다 (계정 준비·결과 확인에 dev DB/Redis 를 직접 쓴다).

## 결과 보는 법

- 실패한 테스트마다 **스크린샷 · 영상 · trace**(모든 클릭·네트워크·콘솔을 되감아 보는 파일)가 `reports/` 에 남는다.
  `npm run report` → 실패 항목 클릭 → Trace 탭.
- 테스트 이름 옆 `issue` 주석이 붙은 실패는 **이미 원인을 확인한 제품 버그**다.
  발견한 문제·QA 결과는 저장소에 두지 않고 모두 Notion `DMU > SilverBridgeQA` 에 정리한다: https://app.notion.com/p/3eb2f400f9a08187b1c2cb8b94229949
- 모든 화면에서 자동으로 감시하는 것: **처리되지 않은 JS 예외**, **/api 5xx 응답** → 화면이 멀쩡해 보여도 실패로 처리.
  `console.error` 는 실패시키지 않고 리포트에 첨부만 한다.

## 테스트 구성

| 폴더 | 내용 |
|---|---|
| `tests/smoke` | 역할별 전 메뉴 진입, 비로그인·역할 불일치 접근 차단, 위조 토큰 |
| `tests/auth` | 로그인/로그아웃(토큰 블랙리스트까지), 회원가입 전 과정, 아이디·비밀번호 찾기, 카카오 인증 리다이렉트 |
| `tests/connection` | 보호자↔피보호자 연결 요청·수락·거절·취소·해제 - **두 브라우저를 동시에 띄워 실시간 알림까지** |
| `tests/medication` | 약 등록·수정·삭제, 피보호자 복용 체크 → 보호자 화면 실시간 반영, 알림 설정 저장 |
| `tests/sos` | SOS 3가지 동작 설정별 흐름, 보호자 실시간 알림, SOS 이력, **서버 알림 발송 기록(notification_log)** 확인 |
| `tests/settings` | 알림 채널, 비밀번호 변경(이전 토큰 무효화), 회원 탈퇴, 피보호자 글자 크기·고대비·접근성 |
| `tests/features` | 병원 예약(실제 예약→취소), AI 챗봇, 이상감지 모니터, 화면 송출(가짜 카메라), 게임, 공지 |
| `tests/features/anomaly.spec.ts` | **화재 이상감지 전 과정**: 화면 송출로 화재 사진 전송 → AI 판정 → BE 상황 생성 → 알림 기록·실시간 이벤트 → 보호자 판정 → 관리자 로그 |

## 테스트 계정 (dev DB)

매 실행 시작 때 `tests/global.setup.ts` 가 **E2E 전용 계정을 지우고 다시 만든다** (팀원 계정은 건드리지 않음).
정의: `src/accounts.ts`

| 키 | ID | 용도 |
|---|---|---|
| admin | e2ea01 | 관리자 API 로 셋업·검증 (FE 에 관리자 화면 없음) |
| guardian1 ↔ ward1 | e2eg01 ↔ e2ew01 | 기본 연결 쌍 - 복약·SOS |
| guardian2, ward2, ward3 | e2eg02, e2ew02, e2ew03 | 연결 요청·수락·거절·해제 |
| guardian3 | e2eg03 | 비밀번호 변경 (토큰이 전부 무효화되므로 전용) |
| ward4 | e2ew04 | 회원 탈퇴 (영구 삭제되므로 전용) |

- 이메일: `e2e.*@silverbridge.test` (예약 TLD → 메일이 실제로 나가지 않음)
- 전화번호: `010-0000-9xxx` (가입자에게 배정되지 않는 국번)
- 비밀번호: `.env` 의 `E2E_PASSWORD`

## 안전장치 - dev 서버는 실제로 문자·알림톡을 보낸다

- **SOS**: BE 는 FCM 을 보내고 실패하면 SMS 로 폴백한다. 헤드리스 브라우저엔 FCM 토큰이 없으므로
  **"SOS → 보호자 실시간 알림" 테스트 1개가 실행마다 Solapi 로 SMS 1건을 실제 발송 요청한다**
  (수신 번호 010-0000-9101 = 미배정 국번이라 받는 사람은 없지만 Solapi 는 접수하고, BE 기록상 `SMS_FALLBACK`).
  나머지 SOS 테스트는 BE 의 30초 알림 쿨다운 안에서 이력만 남긴다. 이 1건도 막으려면 `.env` 에 `E2E_SKIP_SMS=1`.
- **회원가입 문자 인증**: 인증번호 발송/확인 API 응답만 가짜로 주고, BE 가 가입 때 확인하는 Redis 인증 표식을 미리 넣는다.
  문자는 나가지 않지만 가입 API 는 실제 검증을 그대로 거친다.
- **알림 채널 테스트**는 실제 발송 채널(SMS·알림톡)을 켜지 않고 이메일 채널로 저장 동작을 확인한다.
- **카카오 로그인**은 실제 카카오 계정을 쓰지 않는다 (인증 리다이렉트 URL 만 확인).
- **이상감지**: 알림은 앱 푸시 고정 + 문자·알림톡은 사용자가 켠 경우만이라 E2E 계정(기본값)에는 문자가 나가지 않는다.
  테스트가 발송 기록에서 문자·알림톡이 없음을 확인한다. 화재 사진은 gosky 의 데이터셋 이미지를 받아 `.cache/` 에 둔다(`E2E_FIRE_IMAGE`).

## dev 서버에 남기는 흔적

| 무엇 | 어디 | 정리 |
|---|---|---|
| E2E 계정과 그 데이터(연결·약·SOS·알림 기록) | dev DB | 다음 실행 때 자동 삭제 후 재생성 |
| 로그인 레이트리밋 카운터 `rate:signin:*` 삭제 | dev Redis | 1분 10회 제한을 풀어 주는 방향이라 해 없음 (팀원 IP 카운터도 초기화됨) |
| 병원 예약 1건 생성 → 바로 취소 | 예약 서비스 | 취소 상태로 남음 |
| 예약 서비스 계정 `sb-e2eqXX@silverbridge.local` | 예약 서비스 DB | **자동 정리 안 됨** - "첫 방문" 회귀 테스트가 실행마다 1개씩 만든다 |
| AI 챗봇 대화 1건 | AI 서버 | 정리 안 됨 |
| 카메라 등록 → 테스트 끝에 삭제, 이상감지 상황·이력 | dev DB | 다음 실행 때 E2E 계정과 함께 삭제 |
| 송출 세션 `ward_e2ew01_*` (약 30초간 이상감지 모니터 목록에 보임) | AI 서버 | 테스트 끝에 종료. 분석 결과 기록은 AI DB 에 남음 |

## 테스트 작성 규칙

- 역할이 필요하면 `openAs('guardian1', '/guardian/medication')` - 계정별로 **별도 브라우저 컨텍스트**가 열린다.
  보호자·피보호자를 동시에 열면 실시간 상호작용을 그대로 재현할 수 있다. 실시간 검증 전엔 `waitForRealtime(page)`.
- 셋업·교차검증용 API 는 `apiAs('admin')` (로그인 토큰을 재사용해서 열려 있는 브라우저를 로그아웃시키지 않음).
- 화면 로그인·로그아웃·비밀번호 변경을 한 테스트는 `markStale(계정)` 을 호출 (저장된 토큰이 무효가 됐을 수 있음).
- 로케이터 우선순위: `getByRole(…, { name })` → `getByLabel` → `getByPlaceholder` → `input[name=…]`.
  FE 에 `data-testid` 가 없고 CSS 모듈 클래스는 해시라 쓰지 않는다.
- `window.confirm` 은 기본이 "취소"다 → `acceptNextConfirm(page)`.
- 알려진 버그를 검증하는 테스트는 `test.info().annotations.push({ type: 'issue', description })` 로 원인을 남긴다.
