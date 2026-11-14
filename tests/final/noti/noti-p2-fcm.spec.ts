/**
 * 최종 QA - 알림(NOTI) P2 - FCM 토큰 등록·삭제 입력 검증
 *
 * 임시 사용자만 쓴다. 토큰은 실제로 발급된 적 없는 가짜 값이라 푸시는 나가지 않는다.
 * 기준은 배포 코드다: FcmTokenRegisterRequest(token 공백 불가·500자 이하, platform 은 대문자 ANDROID|IOS|WEB 만).
 */
import { bodyOf, expect, P2_TAGS, platformOfToken, test } from './_helpers-noti-p2';
import { fakeToken, fcmTokenOwner } from './_helpers-noti';
import { fcmTokenCount } from '../../../src/variables';

const FCM_TOKEN_API = '/api/notifications/fcm-token';

test.describe('FCM 토큰 플랫폼·길이·삭제', () => {
  test('NOTI-N03 platform 3종(android/ios/web) 모두 등록', P2_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const { api } = await login(user);
    test.info().annotations.push({
      type: '문서와 코드 차이',
      description: '케이스 문장은 android/ios/web 소문자처럼 읽히지만 배포 코드(FcmTokenRegisterRequest)와 FE(platform: WEB)는 대문자 ANDROID, IOS, WEB 이다. 대문자로 고정해 확인했다(소문자는 NOTI-A03 에서 400 으로 확인)',
    });

    for (const platform of ['ANDROID', 'IOS', 'WEB']) {
      const token = fakeToken(user.id, `n03${platform.toLowerCase()}`);
      const res = await api.raw('POST', FCM_TOKEN_API, { token, platform });
      expect(res.status(), `${platform} 등록은 200`).toBe(200);
      expect((await bodyOf(res)).success, `${platform} 등록 성공 응답`).toBe(true);
      expect(platformOfToken(token), `${platform}: DB 에 같은 플랫폼으로 저장`).toBe(platform);
      expect(fcmTokenOwner(token), `${platform}: 주인은 이 사용자`).toEqual([user.id]);
    }
    expect(fcmTokenCount({ userId: user.id }), '세 플랫폼 토큰이 모두 따로 저장됨').toBe(3);
  });

  test('NOTI-A03 platform이 허용 외 값', P2_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const { api } = await login(user);
    test.info().annotations.push({
      type: '문서와 코드 차이',
      description: '케이스 문장은 "android|ios|web 외 값"이지만 배포 코드의 허용 값은 대문자 ANDROID|IOS|WEB 이다. 그래서 소문자 android, ios, web 도 400 이다(코드 값으로 고정)',
    });
    const bad: Record<string, unknown> = {
      windows: 'windows',
      WINDOWS: 'WINDOWS',
      '빈 문자열': '',
      '공백': ' ',
      '소문자 android': 'android',
      '소문자 web': 'web',
      '앞뒤 공백 WEB': ' WEB ',
      null: null,
    };
    for (const [label, platform] of Object.entries(bad)) {
      const res = await api.raw('POST', FCM_TOKEN_API, { token: fakeToken(user.id, 'a03'), platform });
      const body = await bodyOf(res);
      expect.soft(res.status(), `platform=${label}: 400`).toBe(400);
      expect.soft(body.success, `platform=${label}: 실패 응답`).toBe(false);
      expect.soft(body.code, `platform=${label}: 오류 코드`).toBe('INVALID_INPUT');
    }
    const omitted = await api.raw('POST', FCM_TOKEN_API, { token: fakeToken(user.id, 'a03') });
    expect.soft(omitted.status(), 'platform 생략: 400').toBe(400);
    expect(fcmTokenCount({ userId: user.id }), '검증에 걸린 요청은 아무것도 저장하지 않는다').toBe(0);

    const ok = await api.raw('POST', FCM_TOKEN_API, { token: fakeToken(user.id, 'a03ok'), platform: 'WEB' });
    expect(ok.status(), '대조: 올바른 platform 은 200').toBe(200);
  });

  test('NOTI-A04 아주 긴 토큰 문자열', P2_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const { api } = await login(user);

    const tooLong: Record<string, string> = {
      '501자(한도 바로 위)': 'a'.repeat(501),
      '5천자': 'b'.repeat(5_000),
    };
    for (const [label, token] of Object.entries(tooLong)) {
      const res = await api.raw('POST', FCM_TOKEN_API, { token, platform: 'WEB' });
      const body = await bodyOf(res);
      expect.soft(res.status(), `${label}: 400 (500 이 아니다)`).toBe(400);
      expect.soft(body.code, `${label}: 오류 코드`).toBe('INVALID_INPUT');
    }
    expect(fcmTokenCount({ userId: user.id }), '너무 긴 토큰은 저장되지 않는다').toBe(0);

    // 대조: 한도(500자) 딱 맞는 토큰은 저장된다 - 길이 제한이 한도 안쪽까지 막고 있지 않다는 증거
    const edge = `e2e-${user.id}-`.padEnd(500, 'c');
    expect(edge).toHaveLength(500);
    const ok = await api.raw('POST', FCM_TOKEN_API, { token: edge, platform: 'WEB' });
    expect(ok.status(), '500자 토큰은 200').toBe(200);
    expect(fcmTokenCount({ userId: user.id }), '500자 토큰 1건 저장').toBe(1);
  });

  test('NOTI-A05 없는 토큰 삭제는 200(멱등)', P2_TAGS, async ({ tempUser, login }) => {
    const owner = await tempUser('GUARDIAN', { phone: null });
    const other = await tempUser('GUARDIAN', { phone: null });
    const [o, x] = [await login(owner), await login(other)];

    const missing = fakeToken(owner.id, 'a05none');
    const first = await o.api.raw('DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(missing)}`);
    expect(first.status(), '등록한 적 없는 토큰 삭제는 200').toBe(200);
    expect((await bodyOf(first)).success, '성공 응답').toBe(true);
    const second = await o.api.raw('DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(missing)}`);
    expect(second.status(), '같은 요청을 또 보내도 200').toBe(200);

    // 남의 토큰 값을 지우려 해도 200 이지만 남의 토큰은 그대로여야 한다(본인 것만 삭제)
    const othersToken = fakeToken(other.id, 'a05other');
    expect((await x.api.raw('POST', FCM_TOKEN_API, { token: othersToken, platform: 'WEB' })).status(), '준비: 다른 사용자 토큰 등록').toBe(200);
    const foreign = await o.api.raw('DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(othersToken)}`);
    expect(foreign.status(), '남의 토큰 값을 지우려 해도 응답은 200').toBe(200);
    expect(fcmTokenOwner(othersToken), '남의 토큰은 그대로 남아 있다').toEqual([other.id]);
  });
});
