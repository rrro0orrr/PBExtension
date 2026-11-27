import { CloudflareError, type TestLogger } from "@paperback/types";
import { expect } from "chai";

import { MadaraDexCookieStore, MadaraDexExtension } from "../MadaraDex/main.js";
import { TestSuite } from "./suite.js";

// Trimmed from the live madaradex.org "madaradex-reader" theme markup.
const card = (slug: string, title: string) => `
<article class="mdxr-card mdxr-update-card" data-nsfw="true">
  <div class="mdxr-card-art"><a class="mdxr-cover-link" href="https://madaradex.org/title/${slug}/" aria-label="${title}"><img width="300" height="420" src="https://madaradex.org/wp-content/uploads/767.webp" class="mdxr-cover wp-post-image" alt="${title} cover"></a></div>
  <div class="mdxr-card-copy"><h3><a href="https://madaradex.org/title/${slug}/" title="${title}">${title}</a></h3>
    <div class="mdxr-chapter-shortcuts"><a class="mdxr-chapter-button" href="https://madaradex.org/title/${slug}/chapter-171/"><span>Chapter 171</span></a></div>
  </div>
</article>`;

const listing = (
  next: boolean,
) => `<main>${card("secret-class-uncensored", "Secret Class (Uncensored)")}${card("other", "Other")}</main>
<nav class="mdxr-index-pagination"><span class="mdxr-index-page-actions">${
  next
    ? '<a rel="next" href="https://madaradex.org/all/?mdxr_index=1&amp;order=views&amp;mdxr_page=2">»</a>'
    : ""
}</span></nav>
<section class="mdxr-related"><article class="mdxr-card mdxr-related-card"><h3><a href="https://madaradex.org/title/related/">Related</a></h3></article></section>`;

const details = `
<section class="mdxr-series-overview">
  <aside class="mdxr-series-rail"><div class="mdxr-series-cover"><img src="https://madaradex.org/wp-content/uploads/767.webp" class="mdxr-cover wp-post-image"><div class="mdxr-badge-row"><a class="mdxr-type-badge" href="#">Manhwa</a></div></div></aside>
  <div class="mdxr-series-copy">
    <div class="mdxr-title-block"><h1 id="mdxr-series-title">Secret Class (Uncensored)</h1>
      <section class="mdxr-alternative-titles" data-alternative-titles=""><p><bdi>비밀 수업</bdi>, <bdi>秘密教學</bdi></p><details><p><bdi>Bimilsueop</bdi></p></details></section></div>
    <div class="mdxr-title-stats" data-mdxr-rating="767" data-rating-value="3.6"></div>
    <section id="mdxr-about" class="mdxr-synopsis"><h2>Summary</h2><div class="description-summary" id="mdxr-summary-text"><p>When Dae-Ho was a child…</p></div></section>
    <dl class="mdxr-series-facts">
      <div data-detail-row="status"><dt>Status</dt><dd data-detail-field="status"><a class="mdxr-detail-term">Ongoing</a></dd></div>
      <div data-detail-row="author"><dt>Author</dt><dd data-detail-field="author"><a class="mdxr-detail-term">Iron King</a></dd></div>
      <div data-detail-row="artist"><dt>Artist</dt><dd data-detail-field="artist"><a class="mdxr-detail-term">Minachan</a></dd></div>
    </dl>
    <section class="mdxr-term-group" data-term-group="genres"><a class="mdxr-detail-term" href="#">Comedy</a><a class="mdxr-detail-term" href="#">Slice of Life</a></section>
    <section class="mdxr-term-group" data-term-group="tags"><a class="mdxr-detail-term" href="#">Uncensored</a></section>
  </div>
</section>`;

const chapterRow = (n: number) => `
<li class="wp-manga-chapter ">
  <a data-local-chapter="${n}" href="https://madaradex.org/title/secret-class-uncensored/chapter-${n}/">
    <span class="mdxr-chapter-name" data-original-chapter-name="Chapter ${n}" data-chapter-number="${n}" data-chapter-release="1788730940">Chapter ${n}</span>
    <time class="chapter-release-date" datetime="2026-09-06 23:42:20">September 6, 2026</time>
    <span class="mdxr-chapter-views" title="2,091 views"><span aria-hidden="true">2,091</span></span>
  </a>
</li>`;

const chapterPage = (rows: number[], next?: number) => `${details}
<div class="mdxr-chapter-list" data-mdxr-chapter-paged=""><ul class="mdxr-chapter-rows">${rows.map(chapterRow).join("")}</ul></div>
<nav class="mdxr-chapter-toolbar" aria-label="Chapter pages"><span>Page 1 of 2</span>${
  next
    ? `<a class="mdxr-button" rel="next" href="https://madaradex.org/title/secret-class-uncensored/?mdxr_chapter_page=${next}&amp;mdxr_chapter_order=number-desc&amp;mdxr_find#mdxr-chapters">Next page</a>`
    : ""
}</nav>`;

export async function runTests(logger: TestLogger) {
  const suite = new TestSuite("MadaraDex tests", logger);
  const scheduleRequest = Application.scheduleRequest;
  const respond = (handler: (url: string) => string) => {
    const urls: string[] = [];
    Application.scheduleRequest = async ({ url }) => {
      urls.push(url);
      return [
        { url, status: 200, headers: {}, cookies: [] },
        new TextEncoder().encode(handler(url)).buffer,
      ];
    };
    return urls;
  };

  suite.test("discover sections read mdxr cards from the /all/ index", async () => {
    const urls = respond(() => listing(true));
    const extension = new MadaraDexExtension();
    const result = await extension.getDiscoverSectionItems(
      { id: "most_popular", title: "Most Popular", type: 1 } as never,
      undefined,
    );
    expect(urls[0]).to.equal("https://madaradex.org/all/?mdxr_index=1&order=views");
    expect(result.items.map((i) => ("mangaId" in i ? i.mangaId : ""))).to.deep.equal([
      "secret-class-uncensored",
      "other",
    ]);
    expect(result.items[0]).to.include({
      title: "Secret Class (Uncensored)",
      imageUrl: "https://madaradex.org/wp-content/uploads/767.webp",
    });
    expect(result.metadata).to.deep.include({ page: 2 });
  });

  suite.test("search queries q= and maps the page parameter", async () => {
    const urls = respond(() => listing(false));
    const extension = new MadaraDexExtension();
    const result = await extension.getSearchResults(
      { title: "secret class" },
      { page: 2, searchCollectedIds: [] },
      undefined,
    );
    expect(urls[0]).to.equal(
      "https://madaradex.org/all/?mdxr_index=1&q=secret%20class&mdxr_page=2",
    );
    expect(result.items).to.have.length(2);
    expect(result.metadata).to.equal(undefined);
  });

  suite.test("details and paginated chapter list parse the new layout", async () => {
    const urls = respond((url) =>
      url.includes("mdxr_chapter_page=2") ? chapterPage([1]) : chapterPage([3, 2], 2),
    );
    const extension = new MadaraDexExtension();
    const manga = await extension.getMangaDetails("secret-class-uncensored");
    expect(manga.mangaInfo).to.include({
      primaryTitle: "Secret Class (Uncensored)",
      author: "Iron King",
      artist: "Minachan",
      status: "Ongoing",
      synopsis: "When Dae-Ho was a child…",
      thumbnailUrl: "https://madaradex.org/wp-content/uploads/767.webp",
      contentType: "comic",
    });
    expect(manga.mangaInfo.secondaryTitles).to.deep.equal(["비밀 수업", "秘密教學", "Bimilsueop"]);
    expect(manga.mangaInfo.tagGroups?.map((g) => g.tags.length)).to.deep.equal([2, 1]);

    const chapters = await extension.getChapters(manga);
    expect(chapters.map((c) => [c.chapterId, c.title, c.chapNum])).to.deep.equal([
      ["chapter-3", "Chapter 3", 3],
      ["chapter-2", "Chapter 2", 2],
      ["chapter-1", "Chapter 1", 1],
    ]);
    expect(chapters[0].publishDate?.getTime()).to.equal(1788730940000);
    expect(urls.at(-1)).to.equal(
      "https://madaradex.org/title/secret-class-uncensored/?mdxr_chapter_page=2&mdxr_chapter_order=number-desc&mdxr_find",
    );
  });

  suite.test("chapter pages read data-mdx-protected-src images", async () => {
    respond(
      () => `<div class="reading-content">
        <div class="page-break"><img id="image-0" class="wp-manga-chapter-img" data-mdx-protected-src="https://cdn.madaradex.org/manga_x/chapter-171/0.webp" data-mdx-chapter-claim="/manga_x/chapter-171/|tok"></div>
        <div class="page-break"><img id="image-1" class="wp-manga-chapter-img" data-mdx-protected-src="https://cdn.madaradex.org/manga_x/chapter-171/1.webp" data-mdx-chapter-claim="/manga_x/chapter-171/|tok"></div>
      </div>`,
    );
    const extension = new MadaraDexExtension();
    const details = await extension.getChapterDetails({
      chapterId: "chapter-171",
      sourceManga: { mangaId: "secret-class-uncensored" } as never,
      chapNum: 171,
      langCode: "🇬🇧",
    });
    expect(details)
      .to.have.property("pages")
      .that.deep.equals([
        "https://cdn.madaradex.org/manga_x/chapter-171/0.webp",
        "https://cdn.madaradex.org/manga_x/chapter-171/1.webp",
      ]);
  });

  suite.test("a refused CDN image asks for verification on the chapter page", async () => {
    Application.scheduleRequest = async ({ url }) => {
      const status = url.startsWith("https://cdn.madaradex.org/") ? 403 : 200;
      const body = `<div class="reading-content"><div class="page-break"><img class="wp-manga-chapter-img" data-mdx-protected-src="https://cdn.madaradex.org/manga_x/chapter-126/0.webp"></div></div>`;
      return [{ url, status, headers: {}, cookies: [] }, new TextEncoder().encode(body).buffer];
    };
    const extension = new MadaraDexExtension();
    const error = await extension
      .getChapterDetails({
        chapterId: "chapter-126",
        sourceManga: { mangaId: "some-title" } as never,
        chapNum: 126,
        langCode: "🇬🇧",
      })
      .catch((e: unknown) => e);
    expect(error).to.be.instanceOf(CloudflareError);
    expect(JSON.stringify(error)).to.include("https://madaradex.org/title/some-title/chapter-126/");
  });

  suite.test("a refused image first asks for the grant without a CAPTCHA", async () => {
    let granted = false;
    let grantBody = "";
    Application.scheduleRequest = async ({ url, method, body }) => {
      let status = 200;
      let text = `<div class="reading-content"><div class="page-break"><img class="wp-manga-chapter-img" data-mdx-protected-src="https://cdn.madaradex.org/manga_x/chapter-126/0.webp" data-mdx-chapter-claim="/manga_x/chapter-126/|tok"></div></div>`;
      if (url.startsWith("https://cdn.madaradex.org/")) status = granted ? 200 : 403;
      if (url.endsWith("/wp-admin/admin-ajax.php") && method === "POST") {
        grantBody = typeof body === "string" ? body : "";
        granted = true;
        text = '{"success":true,"data":{"scheme":6,"expiresAt":9999999999}}';
      }
      return [{ url, status, headers: {}, cookies: [] }, new TextEncoder().encode(text).buffer];
    };
    const extension = new MadaraDexExtension();
    const details = await extension.getChapterDetails({
      chapterId: "chapter-126",
      sourceManga: { mangaId: "some-title" } as never,
      chapNum: 126,
      langCode: "🇬🇧",
    });
    expect(details)
      .to.have.property("pages")
      .that.deep.equals(["https://cdn.madaradex.org/manga_x/chapter-126/0.webp"]);
    expect(grantBody).to.include("action=mdx_image_auth_refresh");
    expect(grantBody).to.include(
      `chapter_claim=${encodeURIComponent("/manga_x/chapter-126/|tok")}`,
    );
    expect(grantBody).to.include("cf-turnstile-response=&");
  });

  suite.test("falls back to the web view when the server wants verification", async () => {
    Application.scheduleRequest = async ({ url, method }) => {
      let status = 200;
      let text = `<div class="reading-content"><div class="page-break"><img class="wp-manga-chapter-img" data-mdx-protected-src="https://cdn.madaradex.org/manga_x/chapter-126/0.webp" data-mdx-chapter-claim="/manga_x/chapter-126/|tok"></div></div>`;
      if (url.startsWith("https://cdn.madaradex.org/")) status = 403;
      if (method === "POST") {
        status = 403;
        text =
          '{"success":false,"data":{"verificationRequired":true,"challenge":"0123456789abcdef0123456789abcdef"}}';
      }
      return [{ url, status, headers: {}, cookies: [] }, new TextEncoder().encode(text).buffer];
    };
    const extension = new MadaraDexExtension();
    const error = await extension
      .getChapterDetails({
        chapterId: "chapter-126",
        sourceManga: { mangaId: "some-title" } as never,
        chapNum: 126,
        langCode: "🇬🇧",
      })
      .catch((e: unknown) => e);
    expect(error).to.be.instanceOf(CloudflareError);
  });

  suite.test("keeps madaradex.org session cookies with an expiry", async () => {
    const store = new MadaraDexCookieStore({ storage: "memory" });
    await store.interceptResponse(
      { url: "https://madaradex.org/", method: "GET" },
      {
        url: "https://madaradex.org/",
        status: 200,
        headers: {},
        cookies: [
          { name: "session", value: "a", domain: ".madaradex.org", path: "/" },
          { name: "other", value: "b", domain: "example.com", path: "/" },
        ],
      },
      new ArrayBuffer(0),
    );
    store.setCookie({ name: "cdn", value: "c", domain: "cdn.madaradex.org", path: "/" });
    const byName = Object.fromEntries(store.cookies.map((c) => [c.name, c]));
    expect(byName.session.expires?.getTime()).to.be.greaterThan(Date.now() + 29 * 86400000);
    expect(byName.cdn.expires).to.be.instanceOf(Date);
    expect(byName.other.expires).to.equal(undefined);
  });

  try {
    await suite.run();
  } finally {
    Application.scheduleRequest = scheduleRequest;
  }
}
