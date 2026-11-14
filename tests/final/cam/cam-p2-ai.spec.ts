/**
 * 최종 QA - 카메라·이상감지(CAM) P2 - AI 서버 공개 경로와 서버 설정·AI 신호가 필요한 케이스
 *
 * AI 서버 키는 QA 환경에 없고 서버에서 꺼내 쓰는 것도 금지라서 키가 필요한 경로는 직접 부르지 않는다(공개 경로만).
 * 환경변수·재기동·AI 쪽에서 만들어 보내는 신호가 필요한 케이스(N51·A23·A24·A48)는 fixme 로 이유를 남긴다.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { request } from '@playwright/test';

import { expect, test } from '../../../src/fixtures';
import { remoteBash } from '../../../src/remote';
import { cleanupAll, loginUser, mkUser, proxyFor, TAGS } from './_helpers-cam-p2';

test.afterEach(async () => {
  await cleanupAll();
});

/** AI 서버 공개 주소(FE 번들의 NEXT_PUBLIC_AI_API_DOMAIN 값). 다르면 E2E_AI_URL 로 바꾼다 */
const AI_URL = process.env.E2E_AI_URL ?? 'https://testai.gosky.kr';

const FRAME_PATH = '/api/v1/stream-sessions/{session_id}/frame';

test.describe('카메라·이상감지 P2 - AI 서버 공개 경로', () => {
  test('CAM-N59 /health는 키 없이 200, Swagger 노출', TAGS, async () => {
    const ctx = await request.newContext({ baseURL: AI_URL });
    try {
      // 문서 경로(/api/docs, /api/openapi.json)는 키 없이 열린다
      const docs = await ctx.get('/api/docs');
      expect(docs.status(), 'GET /api/docs').toBe(200);
      expect(docs.headers()['content-type'] ?? '', '/api/docs 는 HTML').toContain('text/html');
      const spec = await ctx.get('/api/openapi.json');
      expect(spec.status(), 'GET /api/openapi.json').toBe(200);
      const doc = (await spec.json()) as {
        info?: { title?: string };
        paths?: Record<string, Record<string, { responses?: Record<string, unknown>; requestBody?: { required?: boolean; content?: Record<string, { schema?: { required?: string[] } }> } }>>;
      };
      expect(doc.info?.title, '문서 제목').toBe('SilverBridge AI Server');
      const frame = doc.paths?.[FRAME_PATH]?.post;
      expect(frame, '프레임 수신 경로가 문서에 있다').toBeDefined();

      // 에러 설명이 실제 응답과 같다(ANOM-G17): 문서는 프레임 본문을 multipart 의 필수 'frame' 으로, 오류는 422 로 적는다.
      // 실제로 'frame' 칸 없이 보내면 같은 422 와 검증 오류 형식(detail 목록)이 온다(피보호자 임시 계정으로 FE 프록시를 통해 - 세션 확인보다 먼저 검사되어 세션이 필요 없다)
      expect(frame?.requestBody?.required, '문서의 본문 필수 여부').toBe(true);
      expect(frame?.requestBody?.content?.['multipart/form-data']?.schema?.required, '문서의 multipart 필수 칸').toEqual(['frame']);
      // 문서의 응답 코드에 실제로 나는 오류(400·401·413)가 적혀 있어야 한다. 적혀 있지 않으면 실패로 남긴다(AI 팀: 라우터 responses 에 추가 필요)
      const documented = Object.keys(frame?.responses ?? {});
      for (const code of ['400', '401', '413']) {
        expect.soft(documented, `문서의 응답 코드에 ${code} 가 있어야 한다(실제 문서: ${documented.sort().join('·')})`).toContain(code);
      }
      const w = await loginUser(mkUser('WARD', 'E2E문서본인'));
      const proxy = await proxyFor(w.login);
      const missing = await proxy.post('/api/streams/v1/stream-sessions/e2e-p2-doc/frame', { multipart: { other: 'x' } });
      expect(missing.status(), "'frame' 칸 없는 업로드(문서의 422)").toBe(422);
      const missingText = await missing.text();
      // 본문 확인은 soft: 실패로 남기되 뒤의 /health 확인은 계속한다(앞단이 422 본문을 HTML 안내 페이지로 바꾸는 문제를 따로 드러내기 위해)
      const isJson = missingText.startsWith('{');
      expect.soft(isJson, `422 본문이 JSON 이어야 한다(실제 ${missing.headers()['content-type']}): ${missingText.slice(0, 120).replace(/\s+/g, ' ')}`).toBe(true);
      const detail = isJson ? (JSON.parse(missingText) as { detail?: { type?: string; loc?: (string | number)[] }[] }).detail : undefined;
      expect.soft(detail?.[0]?.type, '검증 오류 종류').toBe('missing');
      expect.soft(detail?.[0]?.loc, '검증 오류 위치').toEqual(['body', 'frame']);
      test.info().annotations.push({
        type: '문서와 다른 점',
        description: '문서(openapi)는 프레임 경로의 오류를 422 하나만 적지만 실제로는 400 STREAM_FRAME_INVALID_TYPE·404 STREAM_SESSION_NOT_FOUND·413 STREAM_FRAME_TOO_LARGE 도 낸다(앱 코드 live_stream_router). 문서가 적은 422 는 상태 코드만 같고, 본문은 이 공개 경로에서 JSON 이 아니라 HTML 안내 페이지로 바뀌어 온다',
      });

      // /health: 공개 주소는 앞단 nginx 가 /api/ 만 AI 서버로 넘기도록 일부러 막아 둔 구성이라 404 가 정상이다(AI 보안 점검 문서 2026-11-10).
      // 키 없이 200 {success:true, data:{status:'ok'}} 는 내부 주소(서버 안에서 6017)에서 읽기 전용 GET 한 번으로 확인한다
      const health = await ctx.get('/health');
      expect(health.status(), `GET /health 공개 주소 실제 ${health.status()} (정책상 404)`).toBe(404);
      const raw = remoteBash(`curl -s -m 10 -w '\\n%{http_code}' http://127.0.0.1:6017/health || curl -s -m 10 -w '\\n%{http_code}' http://10.0.22.1:6017/health`).trim();
      const lines = raw.split('\n');
      const code = lines[lines.length - 1];
      expect(code, '내부 GET /health 상태 코드').toBe('200');
      const body = JSON.parse(lines.slice(0, -1).join('\n')) as { success?: boolean; data?: { status?: string } };
      expect(body.success, '내부 /health success').toBe(true);
      expect(body.data?.status, '내부 /health data.status').toBe('ok');
      test.info().annotations.push({
        type: '정책상 정상',
        description: '공개 주소 /health 404 는 nginx 가 /api/ 만 넘기고 6017 외부 접근도 막은 구성의 결과다. 공개 주소에서 상태 확인이 필요하면 인프라가 location = /health 를 따로 열어야 한다(인프라 결정). 인프라 버그: 같은 nginx 가 /api/ 의 4xx JSON 응답을 HTML 안내 페이지로 바꾼다. 위 422 본문 확인이 그 증거다',
      });
    } finally {
      await ctx.dispose();
    }
  });

  test.fixme('CAM-N51 클립 기능 끄기(ANOMALY_CLIP_ENABLED=false)', TAGS, async () => {
    // 백엔드 환경변수를 false 로 바꿔 재기동해야 한다(서버 설정·컨테이너 변경 금지, 공유 dev 서버).
    // 확인할 내용: 새 클립만 안 만들어지고, 이미 있는 클립의 조회·삭제·청소는 계속 동작(BE 1960-1962). 검증용 환경에서 수동 확인.
  });

  test.fixme('CAM-A23 confidence 가 범위 밖이면 0~1 로 잘라 넣고 신호는 유지', TAGS, async () => {
    // 이 값은 AI 서버가 백엔드 WebSocket 으로 보내는 분석 결과 안에 들어 있다. QA 에서 AI 쪽 신호의 confidence 를 1.5·-0.2·45 로 만들어 보낼 길이 없다
    // (AI 서버 키가 환경에 없고, 화재 사진을 보내면 AI 가 정상 범위의 값만 만든다). 백엔드 로그 WARN 확인에도 그 신호가 필요하다.
    // 확인할 내용: 0~1 로 잘려 저장·WARN, 신호는 버리지 않음, 45(퍼센트)는 1.0 으로 잘리는 보류 이슈(ANOM-G15, BE 1518). 백엔드 단위 테스트나 AI 모의 서버로 확인.
  });

  test.fixme('CAM-A24 모르는 종류·danger 칸 없음은 WARN 만 남긴다', TAGS, async () => {
    // A23 과 같은 이유로 results[] 에 알 수 없는 종류·danger 칸 누락 신호를 AI 쪽에서 만들어 보낼 수 없다.
    // 확인할 내용: WARN 만 남고 기록·알림·기존 판정은 그대로, danger 가 계속 false 면 [ANOMALY-DANGER-MISMATCH] WARN(BE 1523-1526). 백엔드 단위 테스트나 AI 모의 서버로 확인.
  });

  test.fixme('CAM-A48 WS 잘못된 action·없는 세션 구독', TAGS, async () => {
    // AI 서버 WebSocket(/api/v1/ws/live)은 X-API-Key 로 접속해야 하고 그 키는 QA 환경에 없다(서버에서 꺼내 쓰는 것도 금지).
    // 키 없이는 앞단에서 401 로 끊겨(CAM-A44 가 확인) 접속 뒤의 action·sessionId·JSON 처리와 viewerCount 를 볼 수 없다.
    // 확인할 내용: 알 수 없는 action·없는 세션 subscribe·잘못된 JSON 에도 연결 유지 또는 정의된 오류, 다른 구독자 영향 없음, viewerCount 정확(AI 188-196).
  });

  test('CAM-A49 GPU 없음이면 기동 실패하는 코드가 있고, dev AI 기동 로그에 GPU 인식과 오류 없음(읽기만)', TAGS, async () => {
    // 재기동 없이 읽기만 한다: (1) AI 저장소의 코드를 git show 로 읽고 (2) dev AI 컨테이너 로그를 읽는다.
    // 실제로 CUDA 없는 환경에서 기동이 실패하는 동작은 재기동이 필요해 계속 수동 확인으로 남긴다.
    const repo = path.join(os.homedir(), 'SilverBridgeAiServer');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const commit = '9cf51d6';
    const cfg = git('show', `${commit}:app/core/config.py`);
    expect(cfg, 'REQUIRE_GPU 설정 항목(기본 꺼짐)').toMatch(/require_gpu: bool = _as_bool\("REQUIRE_GPU", False\)/);
    const main = git('show', `${commit}:app/main.py`);
    expect(main, 'REQUIRE_GPU 가 켜져 있고 CUDA 가 없으면 기동을 중단하는 분기').toMatch(/if settings\.require_gpu and not cuda_available:\s*\n\s*raise RuntimeError/);

    // dev AI 컨테이너(읽기만: docker inspect·docker logs). 기동 로그는 WARNING 이상만 남아 "[GPU]" 정보 줄은 로그에 없다(INFO 수준).
    // 그래서 GPU 인식은 컨테이너 설정의 GPU 할당(DeviceRequests)과, 로그에 기동 실패 흔적이 없는 것으로 확인한다
    const out = remoteBash(
      `docker inspect -f 'GPU={{json .HostConfig.DeviceRequests}}' silverbridge-ai-server; ` +
        `echo "TRACEBACK=$(docker logs silverbridge-ai-server 2>&1 | grep -c Traceback || true)"; ` +
        `echo "CUDA_FAIL=$(docker logs silverbridge-ai-server 2>&1 | grep -c 'CUDA를 사용할 수 없습니다' || true)"; ` +
        `echo "STARTUP_FAILED=$(docker logs silverbridge-ai-server 2>&1 | grep -c 'STARTUP-FAILED' || true)"; ` +
        `echo "LOG_LINES=$(docker logs silverbridge-ai-server 2>&1 | wc -l)"`,
    );
    expect(out, '컨테이너에 GPU 가 할당되어 있다(DeviceRequests 에 gpu 능력)').toMatch(/GPU=.*"gpu"/);
    expect(out, '로그에 Traceback 이 없다').toContain('TRACEBACK=0');
    expect(out, '로그에 "CUDA 사용 불가로 기동 중단" 오류가 없다').toContain('CUDA_FAIL=0');
    expect(out, '로그에 기동 실패 표시가 없다').toContain('STARTUP_FAILED=0');
    expect(Number(/LOG_LINES=(\d+)/.exec(out)?.[1] ?? 0), '로그가 비어 있지 않다(기동해 동작 중)').toBeGreaterThan(0);
    test.info().annotations.push({
      type: '확인한 범위',
      description: `코드(${commit})의 기동 중단 분기와 dev AI 컨테이너의 GPU 할당·로그를 읽기만으로 확인했다. 기동 로그에 [GPU] 정보 줄은 남지 않는다(INFO 수준). CUDA 없는 환경에서 실제로 기동이 실패하는 동작은 재기동이 필요해 검증용 환경에서 수동 확인한다`,
    });
  });
});
