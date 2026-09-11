// PWA 설치 요건을 채우기 위한 최소 서비스워커.
//
// ⚠ 일부러 **아무것도 캐시하지 않는다.** 정적 파일을 고쳤는데 폰이 옛 코드를 물고 있던
//   사고가 이미 있었고(그래서 index.html 에 ?v=N 을 붙인다), SW 캐시는 그 사고를
//   훨씬 질기게 만든다. fetch 리스너를 등록만 하고 respondWith 를 부르지 않으면
//   브라우저가 평소대로 네트워크에서 가져온다 — 설치 요건은 충족하고 캐시는 없다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
