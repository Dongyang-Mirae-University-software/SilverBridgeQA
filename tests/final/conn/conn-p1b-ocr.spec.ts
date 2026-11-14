/**
 * 최종 QA - 약 봉투 OCR(CONN) P1 묶음 b: A47 A48 A49 A50 A51 A52 N36 N37 N38.
 *
 * 임시 사용자만 쓴다. AI(Claude)를 실제로 부르는 것은 최소로 한다:
 *  - 약 봉투 사진 1건(N36·N38 이 같은 응답을 나눠 쓴다), 풍경 사진 1건(N38), 화면 등록 흐름 1건(N37), 동시 실행 상한 5건(A50)
 *  - 나머지(A47 A48 A49)는 사진 형식·크기·속도 제한 검사에서 끝나거나 AI 가 가짜 사진을 거절하는 데서 끝난다.
 * 사진·약 이름·응답 본문은 실패 문구에 넣지 않는다.
 */
import { Page } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, LoggedIn, test } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import { TempUser, TempUserOptions } from '../../../src/seed';
import { connect } from '../../../src/variables';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { logLineCount } from './_helpers-conn';
import {
  BAG_FAKE_PREFIX, bagItems, clearOcrRate, expectRes, fakeJpeg, MB, ocrPath, OcrData, OcrDrug, ocrRateKeys, postImage, renderBagPng, renderLandscapePng, Res, TAGS,
} from './_helpers-conn-p1b';

const SLOTS = ['MORNING', 'LUNCH', 'DINNER', 'BEDTIME'];
const DRUG_KEYS = ['name', 'perDose', 'timesPerDay', 'days', 'slots', 'timing', 'confidence', 'inList', 'suggestions'];

function medCount(wardId: string): number {
  return Number(psql(`SELECT count(*) FROM medication WHERE ward_id = ${sqlStr(wardId)};`));
}
function ocrLogLines(guardianId: string): number {
  return logLineCount(env.apiContainer, ['[MED-OCR]', `guardianId=${guardianId},`], 900);
}
function failMsg(r: Res) {
  return `상태 코드 ${r.status}, 오류 코드 ${r.code ?? '없음'}`;
}

// ── 약 봉투 사진 읽기 응답 한 번을 나눠 쓴다 (Claude 호출을 줄이려고) ──
interface RealBag {
  png: Buffer;
  stamp: string;
  res: Res;
  data: OcrData;
}
let realBag: RealBag | undefined;

async function realBagOcr(
  page: Page,
  tempUser: (role: TempUser['role'], options?: TempUserOptions) => Promise<TempUser>,
  loginAs: (user: TempUser) => Promise<LoggedIn>,
): Promise<RealBag> {
  if (realBag) return realBag;
  const guardian = await tempUser('GUARDIAN');
  const ward = await tempUser('WARD');
  connect(guardian.id, ward.id);
  const g = await loginAs(guardian);
  const stamp = String(Date.now() % 10000).padStart(4, '0');
  const png = await renderBagPng(page, bagItems(stamp));
  try {
    const res = await postImage(ocrPath(ward.id), g.login, { buffer: png, name: 'bag.png', mimeType: 'image/png' });
    expect(res.status, `약 봉투 읽기 응답 (${failMsg(res)})`).toBe(200);
    expect(medCount(ward.id), '읽기만으로는 아무 약도 등록되지 않는다').toBe(0);
    realBag = { png, stamp, res, data: res.data as OcrData };
    return realBag;
  } finally {
    clearOcrRate(guardian.id);
  }
}

// 보호자 약 추가 화면에서 읽기 응답만 지정한 오류로 바꿔, 안내 문구와 다시 시도·직접 등록 길이 열려 있는지 본다
async function expectOcrFailureScreen(
  page: Page,
  tempUser: (role: TempUser['role'], options?: TempUserOptions) => Promise<TempUser>,
  loginAs: (user: TempUser) => Promise<LoggedIn>,
  openAs: (who: LoggedIn['who'], path: string) => Promise<Page>,
  failures: { reason: 'failed' | 'timedout'; label: string }[],
) {
  const guardian = await tempUser('GUARDIAN');
  const ward = await tempUser('WARD');
  connect(guardian.id, ward.id);
  const g = await loginAs(guardian);
  const png = await renderBagPng(page, [{ name: '타이레놀정500밀리그램', dose: '1정' }]);
  try {
    const guardianPage = await openAs(g.who, '/guardian/medication');
    let current = failures[0];
    let routed = 0;
    await guardianPage.route('**/medication/ocr', async route => {
      routed += 1;
      await route.abort(current.reason); // 5xx 를 흉내 내면 공용 5xx 감시가 실패로 잡으므로, 응답을 못 받은 것으로 처리한다(화면은 503·504·시간 초과를 같은 안내로 처리)
    });
    await guardianPage.getByRole('button', { name: '첫 약 추가하기' }).click();
    const dialog = guardianPage.getByRole('dialog', { name: '약 추가' });
    await expect(dialog).toBeVisible();

    for (const [i, failure] of failures.entries()) {
      await test.step(`${failure.label}: 읽기에 실패해도 "직접 써 주세요" 안내와 다시 찍기·직접 쓰기 길이 열려 있고 약은 등록되지 않는다`, async () => {
        current = failure;
        await dialog.locator('input[type="file"]').setInputFiles({ name: 'bag.png', mimeType: 'image/png', buffer: png });
        await expect(dialog.getByRole('alert'), '실패 안내 문구').toHaveText('지금은 인식할 수 없어요. 직접 써 주세요', { timeout: 30_000 });
        expect(routed, '읽기 요청이 나갔다').toBe(i + 1);
        await expect(dialog.getByRole('button', { name: '다시 찍기' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '직접 쓰기로' })).toBeVisible();
        expect(medCount(ward.id), '실패해도 약이 등록되지 않는다').toBe(0);
      });
    }

    await test.step('[직접 쓰기로]를 누르면 실패 안내가 사라지고 직접 등록 화면으로 간다', async () => {
      await dialog.getByRole('button', { name: '직접 쓰기로' }).click();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      expect(medCount(ward.id)).toBe(0);
    });
  } finally {
    clearOcrRate(guardian.id);
  }
}

test.describe('CONN 약 봉투 OCR P1 묶음 b', () => {
  test('CONN-A47 사진 크기 경계', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    try {
      await test.step('정확히 8MB(8388608 바이트): 크기 검사는 통과하고 AI 까지 가서 가짜 사진이라 거절된다(400 MEDICATION_OCR_INVALID_IMAGE)', async () => {
        const r = await postImage(ocrPath(ward.id), g.login, { buffer: fakeJpeg(8 * MB), name: 'exact8mb.jpg', mimeType: 'image/jpeg' });
        expect(r.status, `크기 검사가 413 으로 막으면 안 된다 (${failMsg(r)})`).not.toBe(413);
        expectRes(r, 400, 'MEDICATION_OCR_INVALID_IMAGE', '8MB 정확히');
        await expect
          .poll(() => ocrLogLines(guardian.id), { message: 'BE 로그: AI 호출 단계까지 간 흔적([MED-OCR] 실패)', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
      });

      await test.step('8MB + 1바이트: 413 MEDICATION_OCR_IMAGE_TOO_LARGE, AI 호출 단계로 가지 않는다', async () => {
        const r = await postImage(ocrPath(ward.id), g.login, { buffer: fakeJpeg(8 * MB + 1), name: 'over8mb.jpg', mimeType: 'image/jpeg' });
        expectRes(r, 413, 'MEDICATION_OCR_IMAGE_TOO_LARGE', '8MB+1');
        expect(ocrLogLines(guardian.id), 'AI 호출 단계 로그가 늘지 않았다').toBe(1);
      });

      await test.step('10MB 초과(11MB): 앞단 nginx 가 413 으로 거절한다(BE 의 JSON 오류 코드 없음)', async () => {
        const r = await postImage(ocrPath(ward.id), g.login, { buffer: fakeJpeg(11 * MB), name: 'over10mb.jpg', mimeType: 'image/jpeg' });
        expect(r.status, `상태 코드 (서버 헤더 ${r.headers['server'] ?? '없음'})`).toBe(413);
        expect(r.code, '앞단에서 거절했으니 BE 의 JSON 오류 코드가 없다').toBeUndefined();
        expect(r.headers['server'] ?? '', '거절한 곳은 앞단 nginx').toMatch(/^nginx/i);
        test.info().annotations.push({
          type: '8MB 이하 통과 경계',
          description: '정확히 8MB 는 가짜 사진으로 AI 단계 도달까지 확인했다. 실제로 읽히는(200) 8MB 바로 아래 사진은 Claude 호출 비용 때문에 확인하지 않았다.',
        });
        expect(ocrLogLines(guardian.id), '10MB 초과도 AI 호출 단계로 가지 않는다').toBe(1);
      });
    } finally {
      clearOcrRate(guardian.id);
    }
  });

  test('CONN-A48 사진 형식 검사', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    try {
      const files: [string, { buffer: Buffer; name: string; mimeType: string } | null][] = [
        ['확장자만 jpg 인 텍스트 파일', { buffer: Buffer.from('이 파일은 사진이 아니라 글자입니다. '.repeat(40)), name: 'fake.jpg', mimeType: 'image/jpeg' }],
        ['GIF', { buffer: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 1)]), name: 'a.gif', mimeType: 'image/gif' }],
        ['PDF', { buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]), name: 'a.pdf', mimeType: 'application/pdf' }],
        ['0바이트 파일', { buffer: Buffer.alloc(0), name: 'empty.jpg', mimeType: 'image/jpeg' }],
        ['image 파트 없음', null],
      ];
      for (const [label, file] of files) {
        const r = await postImage(ocrPath(ward.id), g.login, file);
        expectRes(r, 400, 'MEDICATION_OCR_INVALID_IMAGE', label);
      }
      expect(ocrLogLines(guardian.id), 'AI 호출 단계로 간 흔적이 하나도 없다 (모두 BE 검사에서 거절)').toBe(0);
      expect(medCount(ward.id)).toBe(0);
    } finally {
      clearOcrRate(guardian.id);
    }
  });

  test('CONN-A49 OCR 속도 제한', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const minuteUser = await tempUser('GUARDIAN');
    const hourUser = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(minuteUser.id, ward.id);
    connect(hourUser.id, ward.id);
    const a = await loginAs(minuteUser);
    const b = await loginAs(hourUser);
    const bad = { buffer: Buffer.from('사진이 아닌 글자'), name: 'x.jpg', mimeType: 'image/jpeg' };
    try {
      await test.step('1분에 10번까지는 통과(사진이 아니라 400), 11번째는 429 TOO_MANY_REQUESTS 와 Retry-After', async () => {
        for (let i = 1; i <= 10; i++) {
          expectRes(await postImage(ocrPath(ward.id), a.login, bad), 400, 'MEDICATION_OCR_INVALID_IMAGE', `${i}번째`);
        }
        const r = await postImage(ocrPath(ward.id), a.login, bad);
        expectRes(r, 429, 'TOO_MANY_REQUESTS', '11번째');
        const retry = (r.data as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        expect(retry, '남은 시간은 1초 이상 60초 이하').toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(60);
        expect(Number(r.headers['retry-after']), 'Retry-After 헤더와 같은 값').toBe(retry);
        expect(Number(redis('GET', ocrRateKeys(minuteUser.id)[0])), '분 카운터는 11까지 센다').toBe(11);
      });

      await test.step('1시간에 60번까지는 통과, 61번째는 429 이고 기다릴 시간은 시간 창 기준(60초보다 길다)', async () => {
        // 이 임시 보호자의 시간 카운터만 59 로 맞춘다 (61번을 실제로 보내지 않기 위해)
        redis('SET', ocrRateKeys(hourUser.id)[1], '59', 'EX', '3000');
        expectRes(await postImage(ocrPath(ward.id), b.login, bad), 400, 'MEDICATION_OCR_INVALID_IMAGE', '60번째');
        const r = await postImage(ocrPath(ward.id), b.login, bad);
        expectRes(r, 429, 'TOO_MANY_REQUESTS', '61번째');
        const retry = (r.data as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 0;
        expect(retry, '시간 창이 넘어서 막혔으니 60초보다 오래 기다려야 한다').toBeGreaterThan(60);
        expect(retry).toBeLessThanOrEqual(3000);
        expect(Number(r.headers['retry-after'])).toBe(retry);
      });
      test.info().annotations.push({
        type: '문서와 코드 차이',
        description: '케이스는 "429 TOO_MANY_REQUESTS 또는 MEDICATION_OCR_LIMIT_EXCEEDED"로 적었다. 배포 코드에서 분·시간 속도 제한은 TOO_MANY_REQUESTS 이고, MEDICATION_OCR_LIMIT_EXCEEDED 는 동시 실행 상한(A50)이다. 코드 값으로 나누어 고정했다.',
      });
    } finally {
      clearOcrRate(minuteUser.id);
      clearOcrRate(hourUser.id);
    }
  });

  test('CONN-A50 OCR 동시 실행 상한', TAGS, async ({ tempUser, loginAs, page }) => {
    test.setTimeout(300_000);
    // 서버 전체 동시 상한은 공용 상태라 다른 영역의 OCR 과 겹치면 결과가 바뀐다. 겹쳤다면 잠시 뒤 다시 실행한다.
    const ward = await tempUser('WARD');
    const guardians: TempUser[] = [];
    for (let i = 0; i < 7; i++) {
      const guardian = await tempUser('GUARDIAN');
      connect(guardian.id, ward.id);
      guardians.push(guardian);
    }
    await relaxAuthRates();
    const logins: LoggedIn[] = [];
    for (let i = 0; i < guardians.length; i++) {
      if (i === 4) await relaxAuthRates(); // 로그인은 이 PC 기준 분당 10번까지라 중간에 한 번 더 비운다
      logins.push(await loginAs(guardians[i]));
    }
    const png = await renderBagPng(page, [{ name: '타이레놀정500밀리그램', dose: '1정' }]);
    const file = { buffer: png, name: 'bag.png', mimeType: 'image/png' };
    try {
      const isLimited = (r: Res) => r.status === 429 && r.code === 'MEDICATION_OCR_LIMIT_EXCEEDED';

      // 1단계: 다른 요청 없이 같은 보호자(7번째)만 동시에 2건. 전체 상한(5)에는 닿지 않는다.
      await test.step('같은 보호자의 동시 2건: 한 건만 처리되고(200) 한 건은 429 MEDICATION_OCR_LIMIT_EXCEEDED', async () => {
        const pair = await Promise.all([
          postImage(ocrPath(ward.id), logins[6].login, file),
          postImage(ocrPath(ward.id), logins[6].login, file),
        ]);
        test.info().annotations.push({ type: '같은 보호자 동시 2건 결과', description: `상태 코드 ${pair.map(r => r.status).join(', ')}` });
        expect(pair.filter(isLimited), '두 요청 중 정확히 한 건이 막힌다').toHaveLength(1);
        const done = pair.find(r => !isLimited(r))!;
        expect(done.status, `처리된 한 건은 읽기 성공 (${failMsg(done)})`).toBe(200);
      });

      // 2단계: 서로 다른 보호자 6명이 동시에 한 번씩 (전체 상한 5)
      await test.step('서버 전체 상한: 서로 다른 보호자 6명이 동시에 보내면 5건만 처리되고(200) 1건은 429 MEDICATION_OCR_LIMIT_EXCEEDED', async () => {
        const results = await Promise.all(logins.slice(0, 6).map(l => postImage(ocrPath(ward.id), l.login, file)));
        test.info().annotations.push({ type: '전체 상한 동시 6건 결과', description: `상태 코드 ${results.map(r => r.status).join(', ')}` });
        expect(results.filter(isLimited), '막힌 요청 수').toHaveLength(1);
        const admitted = results.filter(r => !isLimited(r));
        expect(admitted, '처리된 요청 수').toHaveLength(5);
        expect(admitted.map(r => r.status), '처리된 요청은 모두 200').toEqual([200, 200, 200, 200, 200]);
      });
      await test.step('자리는 요청이 끝난 뒤 돌아온다: 같은 보호자가 바로 다시 보내면 429 가 아니라 AI 가 가짜 사진을 거절한다(400)', async () => {
        const again = await postImage(ocrPath(ward.id), logins[0].login, { buffer: fakeJpeg(2048), name: 'again.jpg', mimeType: 'image/jpeg' });
        expect(again.status, `자리 반환 확인 (${failMsg(again)})`).not.toBe(429);
        expectRes(again, 400, 'MEDICATION_OCR_INVALID_IMAGE', '자리 반환 뒤 재요청');
      });
    } finally {
      for (const guardian of guardians) clearOcrRate(guardian.id);
    }
  });

  test('CONN-A51 AI·Claude 실패와 시간 초과', TAGS, async ({ tempUser, loginAs, openAs, page }) => {
    test.setTimeout(120_000);
    // 서버를 건드리지 않는다: 보호자 브라우저 안에서 읽기 요청만 실패로 바꿔 화면 반응을 본다(서버·Claude 호출 없음). 실제 503/504 응답 모양은 공용 5xx 감시 때문에 흉내 내지 않는다.
    await expectOcrFailureScreen(page, tempUser, loginAs, openAs, [
      { reason: 'failed', label: 'AI 사용 불가(503 대신 연결 실패)' },
      { reason: 'timedout', label: '시간 초과(504 대신 응답 없음)' },
    ]);
    test.info().annotations.push({
      type: '수동 확인 필요',
      description: 'BE 가 AI 중단·응답 지연(MEDICATION_OCR_CALL_TIMEOUT)일 때 실제로 503 MEDICATION_OCR_UNAVAILABLE / 504 MEDICATION_OCR_TIMEOUT 을 내는지는 서버 설정을 바꿔야 해서 이 QA 에서 확인하지 않는다. 여기서는 화면 반응만 확인했다.',
    });
  });

  test('CONN-A52 OCR 기능 끄기', TAGS, async ({ tempUser, loginAs, openAs, page }) => {
    test.setTimeout(120_000);
    // 기능이 꺼지면 BE 는 503 MEDICATION_OCR_UNAVAILABLE 을 낸다. 그 응답일 때의 화면만 본다.
    await expectOcrFailureScreen(page, tempUser, loginAs, openAs, [{ reason: 'failed', label: '기능 꺼짐(503 대신 연결 실패)' }]);
    test.info().annotations.push({
      type: '수동 확인 필요',
      description: 'MEDICATION_OCR_ENABLED=false 는 서버 환경 변수·컨테이너 재기동이 필요해 바꿀 수 없다(서버 설정 변경 금지). 끈 환경에서 BE 가 503 을 내고 사진이 AI 로 가지 않는지는 수동 확인한다(코드상 킬 스위치가 속도 제한·인가·사진 검사보다 먼저).',
    });
  });
  test('CONN-N36 약 봉투 사진을 올려 등록 초안 받기', TAGS, async ({ tempUser, loginAs, page }) => {
    test.setTimeout(240_000);
    const bag = await realBagOcr(page, tempUser, loginAs);
    const data = bag.data;

    expect(Object.keys(data).sort(), '응답 최상위 칸은 readable, drugs 둘뿐').toEqual(['drugs', 'readable']);
    expect(data.readable, '준비한 약 봉투는 읽혀야 한다').toBe(true);
    expect(data.drugs.length, '약이 1개 이상 읽혔다').toBeGreaterThanOrEqual(1);
    expect(bag.res.headers['cache-control'] ?? '', '약 이름이 담긴 응답은 저장하지 않게').toContain('no-store');

    for (const [i, drug] of data.drugs.entries()) {
      const where = `${i + 1}번째 약`;
      expect(Object.keys(drug).filter(k => !DRUG_KEYS.includes(k)), `${where}: 허용 칸 밖의 칸(reason·성분 등)이 없다`).toEqual([]);
      for (const key of DRUG_KEYS) expect(drug, `${where}: ${key} 칸이 있다(값은 null 가능)`).toHaveProperty(key);
      expect(typeof drug.name === 'string' && drug.name.length > 0 && drug.name.length <= 100, `${where}: 이름은 1~100자`).toBe(true);
      if (drug.perDose != null) expect(drug.perDose > 0 && drug.perDose <= 99, `${where}: 1회 복용량은 0 초과 99 이하`).toBe(true);
      if (drug.timesPerDay != null) expect(Number.isInteger(drug.timesPerDay) && drug.timesPerDay >= 1 && drug.timesPerDay <= 10, `${where}: 하루 횟수 1~10`).toBe(true);
      if (drug.days != null) expect(Number.isInteger(drug.days) && drug.days >= 1 && drug.days <= 365, `${where}: 일수 1~365`).toBe(true);
      const slots = drug.slots ?? [];
      expect(slots.every(s => SLOTS.includes(s)), `${where}: slots 는 4종만`).toBe(true);
      expect(slots, `${where}: 봉투에 표시되지 않은 취침 전은 지어내지 않는다`).not.toContain('BEDTIME');
      expect(['high', 'low'], `${where}: confidence 는 high 또는 low`).toContain(drug.confidence);
      if (drug.inList != null) expect(typeof drug.inList, `${where}: inList`).toBe('boolean');
      expect((drug.suggestions ?? []).length, `${where}: 제안은 최대 3개`).toBeLessThanOrEqual(3);
    }
    test.info().annotations.push({
      type: '읽은 결과 요약',
      description: `약 ${data.drugs.length}개, slots 가 있는 약 ${data.drugs.filter(d => (d.slots ?? []).length > 0).length}개 (이름·응답 본문은 기록하지 않음)`,
    });
  });

  test('CONN-N38 식약처 목록 대조 결과와 약 봉투가 아닌 사진', TAGS, async ({ tempUser, loginAs, page }) => {
    test.setTimeout(300_000);
    const bag = await realBagOcr(page, tempUser, loginAs);
    const drugs: OcrDrug[] = bag.data.drugs;

    await test.step('목록에 있는 이름(타이레놀정500밀리그램)은 inList true, 제안 없음', async () => {
      const known = drugs.find(d => (d.name ?? '').includes('타이레놀'));
      expect(known, '타이레놀 약이 읽혔다').toBeTruthy();
      expect(known!.inList, '식약처 목록에 있는 이름').toBe(true);
      expect(known!.suggestions ?? [], 'inList 가 true 이면 제안을 붙이지 않는다').toEqual([]);
    });

    await test.step('목록에 없는 이름은 inList false, 제안은 최대 3개·각 100자 이하, 이름은 자동으로 바뀌지 않는다', async () => {
      const fake = drugs.find(d => (d.name ?? '').includes(BAG_FAKE_PREFIX));
      expect(fake, '봉투에 쓴 가짜 이름이 그대로 읽혔다(제안으로 바뀌지 않음)').toBeTruthy();
      expect(fake!.inList, '목록에 없는 이름').toBe(false);
      const suggestions = fake!.suggestions ?? [];
      expect(suggestions.length).toBeLessThanOrEqual(3);
      expect(suggestions.every(s => s.length <= 100), '제안은 각 100자 이하').toBe(true);
      expect(suggestions.includes(fake!.name!), '읽은 이름 자체를 제안으로 되돌려주지 않는다').toBe(false);
    });

    await test.step('약 봉투가 아닌 사진(풍경): readable=false, drugs 빈 배열', async () => {
      const guardian = await tempUser('GUARDIAN');
      const ward = await tempUser('WARD');
      connect(guardian.id, ward.id);
      const g = await loginAs(guardian);
      try {
        const png = await renderLandscapePng(page);
        const r = await postImage(ocrPath(ward.id), g.login, { buffer: png, name: 'landscape.png', mimeType: 'image/png' });
        expect(r.status, `풍경 사진 응답 (${failMsg(r)})`).toBe(200);
        const data = r.data as OcrData;
        expect(data.readable, '약 봉투로 읽지 못한다').toBe(false);
        expect(data.drugs, 'drugs 는 빈 배열').toEqual([]);
        expect(r.headers['cache-control'] ?? '').toContain('no-store');
        expect(medCount(ward.id)).toBe(0);
      } finally {
        clearOcrRate(guardian.id);
      }
    });
  });

  test('CONN-N37 OCR 초안을 확인·수정 후 일괄 등록(자동 등록 없음)', TAGS, async ({ tempUser, loginAs, openAs, page }) => {
    test.setTimeout(300_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const stamp = String(Date.now() % 10000).padStart(4, '0');
    const png = await renderBagPng(page, bagItems(stamp));
    const editedName = `E2E수정이름${stamp}`;
    try {
      const guardianPage = await openAs(g.who, '/guardian/medication');
      let ocrBody!: OcrData;
      const batchBodies: { drugs: { name: string; doseAmount: number }[]; times: { doseTime: string }[] }[] = [];
      guardianPage.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith('/medication/batch')) batchBodies.push(JSON.parse(request.postData() ?? '{}'));
      });

      await guardianPage.getByRole('button', { name: '첫 약 추가하기' }).click();
      const dialog = guardianPage.getByRole('dialog', { name: '약 추가' });
      await expect(dialog).toBeVisible();

      await test.step('사진을 올리면 초안이 뜨지만 아무 약도 등록되지 않는다', async () => {
        const ocrResponse = guardianPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/medication/ocr'), { timeout: 90_000 });
        await dialog.locator('input[type="file"]').setInputFiles({ name: 'bag.png', mimeType: 'image/png', buffer: png });
        const ocrRes = await ocrResponse;
        expect(ocrRes.status(), '읽기 응답 상태 코드').toBe(200);
        ocrBody = ((await ocrRes.json()) as { data: OcrData }).data;
        await expect(dialog.getByText(/약 \d+개를 찾았어요/)).toBeVisible({ timeout: 90_000 });
        expect(ocrBody.readable).toBe(true);
        expect(medCount(ward.id), '읽기만으로는 아무 약도 등록되지 않는다').toBe(0);
        expect(batchBodies, '아직 등록 요청도 나가지 않았다').toHaveLength(0);
      });

      await test.step('보호자가 첫 약 이름을 고치고 1회 복용량을 반 알(0.5)로 맞춘 뒤 다음으로 간다', async () => {
        await dialog.getByLabel('1번째 약 이름').fill(editedName);
        const lower = dialog.getByRole('button', { name: '1번째 약 복용량 줄이기' });
        // 반 알(최소)에 닿으면 버튼이 꺼진다
        for (let i = 0; i < 4 && (await lower.isEnabled()); i++) await lower.click();
        await expect(lower, '반 알(0.5)이 최소라 더 줄일 수 없다').toBeDisabled();
        await dialog.getByRole('button', { name: '다음', exact: true }).click();
        await expect(dialog.getByRole('heading', { name: '언제 드세요?' })).toBeVisible();
        expect(medCount(ward.id), '다음 단계로 가도 아직 등록되지 않는다').toBe(0);
      });

      await test.step('[등록]을 눌러야만 일괄 등록 API 로 등록된다: 고친 이름·0.5정이 그대로, 나머지 약 이름은 읽은 그대로', async () => {
        const batch = guardianPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/medication/batch'));
        await dialog.getByRole('button', { name: '등록', exact: true }).click();
        expect((await batch).status(), '일괄 등록 응답').toBe(200);
        expect(batchBodies).toHaveLength(1);
        const body = batchBodies[0];
        expect(body.drugs[0].name, '고친 이름').toBe(editedName);
        expect(body.drugs[0].doseAmount, '반 알은 0.5 그대로 보낸다').toBe(0.5);
        for (let i = 1; i < body.drugs.length; i++) {
          expect(body.drugs[i].name, `${i + 1}번째 약 이름은 읽은 그대로(자동 변경 없음)`).toBe((ocrBody.drugs[i].name ?? '').trim());
        }
        // 봉투에 0.5정으로 적은 약: 읽은 0.5 가 사람 손을 거치지 않고 그대로 등록 요청·DB 로 간다
        const halfIdx = ocrBody.drugs.findIndex(d => (d.name ?? '').includes(BAG_FAKE_PREFIX));
        expect(halfIdx, '0.5정으로 적은 약이 읽혔다').toBeGreaterThanOrEqual(1);
        expect(ocrBody.drugs[halfIdx].perDose, '봉투의 0.5정을 0.5 로 읽었다').toBe(0.5);
        expect(body.drugs[halfIdx].doseAmount, '읽은 0.5 가 doseAmount 에 그대로').toBe(0.5);
        const halfName = body.drugs[halfIdx].name;
        const halfRows = psql(`SELECT dose_amount::text FROM medication WHERE ward_id = ${sqlStr(ward.id)} AND created_by = ${sqlStr(guardian.id)} AND name = ${sqlStr(halfName)};`)
          .split('\n')
          .filter(Boolean);
        expect(halfRows.length, '0.5정 약이 복용 시간 수만큼 등록됐다').toBe(body.times.length);
        expect(halfRows.every(r => Number(r) === 0.5), 'DB 에도 0.5').toBe(true);
        const rows = psql(`SELECT name || '|' || dose_amount::text FROM medication WHERE ward_id = ${sqlStr(ward.id)} AND created_by = ${sqlStr(guardian.id)};`)
          .split('\n')
          .filter(Boolean);
        expect(rows.length, '등록된 약 수 = 약 수 x 복용 시간 수').toBe(body.drugs.length * body.times.length);
        expect(rows.filter(r => r.startsWith(`${editedName}|`)).every(r => r.endsWith('|0.5')), 'DB 에도 0.5').toBe(true);
        expect(rows.some(r => r.startsWith(`${editedName}|`))).toBe(true);
      });
    } finally {
      clearOcrRate(guardian.id);
    }
  });
});
