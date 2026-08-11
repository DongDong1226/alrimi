// ============================================================
//  EIASS 중계 (Supabase Edge Function, 서울 리전)
//
//  왜 있나
//    GitHub 러너(미국 Azure)에서는 EIASS 접속이 6번 중 1번만 됐다.
//    같은 순간 VWorld(한국)는 0.43초에 붙었으니 경로 문제가 아니라
//    EIASS 쪽이 그 대역을 불안정하게 거절하는 것이다. (docs/HISTORY.md §4)
//    그래서 **EIASS 로 가는 요청만** 서울에서 대신 걸어 준다.
//    2026-08-09 실측: 서울에서 13번 호출 13번 성공 (GitHub 은 17%).
//
//  ★ 배포할 때 반드시 지킬 것
//    1. Supabase 프로젝트 지역이 **Northeast Asia (Seoul)** 여야 한다. 나중에 못 바꾼다.
//    2. 부르는 쪽이 헤더에 **x-region: ap-northeast-2** 를 넣어야 한다.
//       안 넣으면 "부르는 사람과 가까운 곳"에서 도는 게 기본이라 **미국에서 돌아 버린다.**
//       응답의 x-sb-edge-region 으로 어디서 돌았는지 확인할 수 있다.
//    3. 함수 설정에서 **Verify JWT 를 끈다.** 대신 아래 RELAY_KEY 로 막는다.
//    4. Supabase 환경변수에 **RELAY_KEY** 를 넣는다. 저장소에는 절대 넣지 않는다.
//
//  이 파일은 대시보드 편집기에 붙여넣는 원본이다.
//  대시보드는 버전 관리가 없어서 지우면 복구가 안 되므로 여기에 보관한다.
// ============================================================

// EIASS 는 자기 인증서만 보내고 **중간 인증서를 보내지 않는다.**
// 브라우저·파이썬은 알아서 보충하지만 Deno 는 안 해서 UnknownIssuer 로 끊긴다.
// 검증을 끄는 것이 아니라 **빠진 한 장을 채워 정상적으로 검증되게** 하는 것이다.
//
// ⚠️ EIASS 인증서는 2027-03-29 에 만료된다. 갱신할 때 인증기관이 바뀌면
//    이 인증서가 안 맞아 중계가 멈춘다. 그때는 아래 명령으로 새 중간 인증서를 받는다:
//      openssl s_client -connect www.eiass.go.kr:443 -servername www.eiass.go.kr \
//        | openssl x509 -noout -text | grep -A2 "Authority Information Access"
//    거기 나오는 CA Issuers 주소의 .crt 를 받아 PEM 으로 바꿔 넣으면 된다.
//    (이 Sectigo 중간 인증서 자체는 2030-12-31 까지 유효하다)
const SECTIGO_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIGEzCCA/ugAwIBAgIQfVtRJrR2uhHbdBYLvFMNpzANBgkqhkiG9w0BAQwFADCB
iDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0pl
cnNleSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNV
BAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMTgx
MTAyMDAwMDAwWhcNMzAxMjMxMjM1OTU5WjCBjzELMAkGA1UEBhMCR0IxGzAZBgNV
BAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEYMBYGA1UE
ChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFJTQSBEb21haW4g
VmFsaWRhdGlvbiBTZWN1cmUgU2VydmVyIENBMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEA1nMz1tc8INAA0hdFuNY+B6I/x0HuMjDJsGz99J/LEpgPLT+N
TQEMgg8Xf2Iu6bhIefsWg06t1zIlk7cHv7lQP6lMw0Aq6Tn/2YHKHxYyQdqAJrkj
eocgHuP/IJo8lURvh3UGkEC0MpMWCRAIIz7S3YcPb11RFGoKacVPAXJpz9OTTG0E
oKMbgn6xmrntxZ7FN3ifmgg0+1YuWMQJDgZkW7w33PGfKGioVrCSo1yfu4iYCBsk
Haswha6vsC6eep3BwEIc4gLw6uBK0u+QDrTBQBbwb4VCSmT3pDCg/r8uoydajotY
uK3DGReEY+1vVv2Dy2A0xHS+5p3b4eTlygxfFQIDAQABo4IBbjCCAWowHwYDVR0j
BBgwFoAUU3m/WqorSs9UgOHYm8Cd8rIDZsswHQYDVR0OBBYEFI2MXsRUrYrhd+mb
+ZsF4bgBjWHhMA4GA1UdDwEB/wQEAwIBhjASBgNVHRMBAf8ECDAGAQH/AgEAMB0G
A1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAbBgNVHSAEFDASMAYGBFUdIAAw
CAYGZ4EMAQIBMFAGA1UdHwRJMEcwRaBDoEGGP2h0dHA6Ly9jcmwudXNlcnRydXN0
LmNvbS9VU0VSVHJ1c3RSU0FDZXJ0aWZpY2F0aW9uQXV0aG9yaXR5LmNybDB2Bggr
BgEFBQcBAQRqMGgwPwYIKwYBBQUHMAKGM2h0dHA6Ly9jcnQudXNlcnRydXN0LmNv
bS9VU0VSVHJ1c3RSU0FBZGRUcnVzdENBLmNydDAlBggrBgEFBQcwAYYZaHR0cDov
L29jc3AudXNlcnRydXN0LmNvbTANBgkqhkiG9w0BAQwFAAOCAgEAMr9hvQ5Iw0/H
ukdN+Jx4GQHcEx2Ab/zDcLRSmjEzmldS+zGea6TvVKqJjUAXaPgREHzSyrHxVYbH
7rM2kYb2OVG/Rr8PoLq0935JxCo2F57kaDl6r5ROVm+yezu/Coa9zcV3HAO4OLGi
H19+24rcRki2aArPsrW04jTkZ6k4Zgle0rj8nSg6F0AnwnJOKf0hPHzPE/uWLMUx
RP0T7dWbqWlod3zu4f+k+TY4CFM5ooQ0nBnzvg6s1SQ36yOoeNDT5++SR2RiOSLv
xvcRviKFxmZEJCaOEDKNyJOuB56DPi/Z+fVGjmO+wea03KbNIaiGCpXZLoUmGv38
sbZXQm2V0TP2ORQGgkE49Y9Y3IBbpNV9lXj9p5v//cWoaasm56ekBYdbqbe4oyAL
l6lFhd2zi+WJN44pDfwGF/Y4QA5C5BIG+3vzxhFoYt/jmPQT2BVPi7Fp2RBgvGQq
6jG35LWjOhSbJuMLe/0CjraZwTiXWTb2qHSihrZe68Zk6s+go/lunrotEbaGmAhY
LcmsJWTyXnW0OMGuf1pGg+pRyrbxmRE1a6Vqe8YAsOf4vmSyrcjC8azjUeqkk+B5
yOGBQMkKW+ESPMFgKuOXwIlCypTPRpgSabuY0MLTDXJLR27lk8QyKGOHQ+SwMj4K
00u/I5sUKUErmgQfky3xxzlIPK1aEn8=
-----END CERTIFICATE-----`;

// **이 주소로만 대신 걸어 준다.** 이 줄이 없으면 아무나 우리 함수로
// 아무 사이트나 긁을 수 있는 '열린 대리 서버'가 된다.
const ALLOW_PREFIX = "https://www.eiass.go.kr/";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const RELAY_KEY = Deno.env.get("RELAY_KEY") ?? "";

/** 헤더에는 아스키만 실을 수 있어서 쿠키 목록을 base64 로 접어 보낸다. */
function packCookies(list: string[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(list));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** 중계가 거절할 때. **까닭(한글)은 반드시 본문에 담는다.**
 *  HTTP 헤더 값에는 라틴 문자만 넣을 수 있어서, 한글을 헤더에 넣으면
 *  오류를 알리려다 그 자리에서 또 죽는다(TypeError). 실제로 겪어서 고쳤다.
 *  헤더에는 짧은 아스키 코드만 넣는다. */
function fail(status: number, code: string, msg: string): Response {
  return new Response(msg, {
    status,
    headers: { "x-relay-error": code, "content-type": "text/plain; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  // ① 키 확인. RELAY_KEY 를 안 넣어 뒀으면 아예 열지 않는다(빈 문자열 통과 방지).
  if (!RELAY_KEY) return fail(500, "no-relay-key", "RELAY_KEY 환경변수가 설정되지 않았습니다");
  if (req.headers.get("x-relay-key") !== RELAY_KEY) return fail(401, "bad-key", "x-relay-key 가 맞지 않습니다");

  // ② 주소 확인 — EIASS 외에는 대신 걸어 주지 않는다
  const url = req.headers.get("x-relay-url") ?? "";
  if (!url.startsWith(ALLOW_PREFIX)) {
    return fail(403, "not-allowed", `이 중계는 ${ALLOW_PREFIX} 주소만 처리합니다`);
  }

  const method = (req.headers.get("x-relay-method") ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? new Uint8Array(await req.arrayBuffer()) : undefined;

  const headers: Record<string, string> = {
    "User-Agent": req.headers.get("x-relay-ua") || DEFAULT_UA,
  };
  if (hasBody) {
    headers["Content-Type"] =
      req.headers.get("content-type") ?? "application/x-www-form-urlencoded";
  }
  const cookie = req.headers.get("x-relay-cookie");
  if (cookie) headers["Cookie"] = cookie;

  try {
    const client = (Deno as any).createHttpClient({ caCerts: [SECTIGO_INTERMEDIATE] });
    const t0 = Date.now();
    const up = await fetch(url, {
      client,
      method,
      body,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(90_000),
    } as any);
    const buf = new Uint8Array(await up.arrayBuffer());

    // 원래 응답을 그대로 돌려준다.
    // 함수 자체는 늘 200 이고, EIASS 가 준 상태 코드는 x-upstream-status 에 담는다.
    // (그래야 부르는 쪽이 '중계가 실패한 것'과 'EIASS 가 404 를 준 것'을 구분할 수 있다)
    const h = new Headers({
      "content-type": "application/octet-stream",
      "x-upstream-status": String(up.status),
      "x-upstream-content-type": up.headers.get("content-type") ?? "",
      "x-upstream-ms": String(Date.now() - t0),
    });
    const sc = (up.headers as any).getSetCookie?.() ?? [];
    if (sc.length) h.set("x-upstream-cookies", packCookies(sc));
    return new Response(buf, { status: 200, headers: h });
  } catch (e) {
    const msg = String(e);
    // 인증서 문제는 원인이 뚜렷하므로 따로 짚어 준다 (2027-03-29 갱신 때 겪을 수 있다)
    const hint = msg.includes("UnknownIssuer") || msg.includes("certificate")
      ? " ← EIASS 인증서가 바뀐 것 같습니다. 이 파일 맨 위 주석의 방법으로 중간 인증서를 새로 받아 넣으세요."
      : "";
    return fail(502, "upstream-failed", `EIASS 호출 실패: ${msg}${hint}`);
  }
});
