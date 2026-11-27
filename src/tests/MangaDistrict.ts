import { type Chapter, type TestLogger } from "@paperback/types";
import { expect } from "chai";

import { applyChapterVersions, cleanTitle, MangaDistrictExtension } from "../MangaDistrict/main.js";
import { type MadaraSearchForm } from "../utils/madara/forms.js";
import { TestSuite } from "./suite.js";

// Fixtures trimmed from live mangadistrict.com markup.
const item = (slug: string, title: string) => `
<div class="page-item-detail manga  ">
  <div id="manga-item-327633" class="item-thumb  c-image-hover" data-post-id="327633">
    <a href="https://mangadistrict.com/series/${slug}/" title="${title}">
      <img post-id="327633" fifu-featured="1" width="321" height="476" src="https://cdn.mangadistrict.com/thumbnail/${slug}-3.webp" class="img-responsive" alt="${title}">
    </a>
  </div>
  <div class="item-summary">
    <div class="post-title font-title"><h3 class="h5"><a href="https://mangadistrict.com/series/${slug}/">${title}</a></h3></div>
  </div>
</div>`;

const listing = (pagenavi: string) => `
<div class="page-listing-item">
  ${item("teach-me-first-uncensored", "Teach Me first! (Uncensored)")}
  ${item("moby-dick-official", "Moby Dick (Official)")}
</div>
<div class="wp-pagenavi" role="navigation">${pagenavi}</div>`;

const MANY_PAGES =
  '<span aria-current="page" class="current">1</span><a class="page larger" title="Page 2" href="https://mangadistrict.com/series/page/2/?m_orderby=views">2</a><a class="last" aria-label="Last Page" href="https://mangadistrict.com/series/page/205/?m_orderby=views"><i class="fas fa-fast-forward"></i></a>';
// Search with only two result pages: no "last" link.
const TWO_PAGES =
  '<span aria-current="page" class="current">1</span><a class="page larger" title="Page 2" href="https://mangadistrict.com/page/2/?s=secret+class&amp;post_type=wp-manga">2</a>';
const LAST_PAGE =
  '<a class="page smaller" title="Page 1" href="https://mangadistrict.com/page/1/?s=secret+class&amp;post_type=wp-manga">1</a><span aria-current="page" class="current">2</span>';

const chapterRow = (path: string, title: string, date: string) => `
<li class="wp-manga-chapter"> <a href="https://mangadistrict.com/series/moby-dick-official/${path}/"> ${title} </a> <span class="chapter-release-date"> <span class="timediff"><i>${date}</i></span><span class="views"><i class="fa fa-eye"></i> 17,340</span> </span> </li>`;

const details = `
<div class="post-title"><h1> Moby Dick (Official) </h1></div>
<div class="summary_image"><a href="#"><img post-id="1" src="https://cdn.mangadistrict.com/thumbnail/moby-dick-official.webp" class="img-responsive" alt="Moby Dick (Official)"></a></div>
<div class="post-content_item"><div class="summary-heading"><h5>Rating</h5></div><div class="summary-content vote-details">Average <span property="ratingValue" id="averagerate"> 4.6</span> / <span>5</span></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Alternative</h5></div><div class="summary-content">Mobi Dik, 모비딕</div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Author(s)</h5></div><div class="summary-content"><div class="author-content"><a href="https://mangadistrict.com/publication-author/yansae/" rel="tag">Yansae</a></div></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Artist(s)</h5></div><div class="summary-content"><div class="artist-content"><a href="https://mangadistrict.com/publication-artist/dini/" rel="tag">Dini</a></div></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Genre(s)</h5></div><div class="summary-content"><div class="genres-content"><a href="https://mangadistrict.com/publication-genre/drama/" rel="tag">Drama</a><a href="https://mangadistrict.com/publication-genre/romance/" rel="tag">Romance</a></div></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content"> OnGoing </div></div>
<div class="description-summary"><div class="summary__content show-more"> <p>A whale of a story.</p> </div></div>
<div class="page-content-listing single-page"><div class="listing-chapters_wrap cols-1 show-more">
<ul class="main version-chap no-volumn active">
  ${chapterRow("chapter-35", "Chapter 35 - New arc", "November 20, 2026")}
  ${chapterRow("chapter-2", "Chapter 2", "September 14, 2024")}
  ${chapterRow("chapter-1", "Chapter 1", "September 14, 2024")}
</ul>
<ul class="main version-chap volumns">
  <li class="parent has-child"><a href="javascript:void(0)" class="has-child">[V2] FULL QUALITY</a>
    <ul class="sub-chap list-chap"><li><ul class="sub-chap-list">
      ${chapterRow("v2-full-quality/chapter-2_1", "Chapter 2", "September 15, 2024")}
      ${chapterRow("v2-full-quality/chapter-1_1", "Chapter 1", "September 15, 2024")}
    </ul></li></ul>
  </li>
</ul>
</div></div>`;

// Reader with the decoy banner, eager images, a lazy image and its <noscript> copy.
const reader = `
<div class="reading-content">
  <script>(function(){})();</script>
  <div class="page-break no-gaps"><img id="image-99999" src="https://cdn.mangadistrict.com/assets/publication/media/image/000001.jpg" width="3000" height="1500" class="wp-manga-chapter-img"></div>
  <div class="page-break no-gaps"><img id="image-0" src="https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/001.jpg" class="wp-manga-chapter-img"></div>
  <div class="page-break no-gaps"><img id="image-1" data-src="https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/002.jpg" src="data:image/gif;base64,R0lGOD" class="wp-manga-chapter-img"><noscript><img id="image-1" src="https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/002.jpg" class="wp-manga-chapter-img"></noscript></div>
  <div class="page-break no-gaps"><noscript><img id="image-2" src="https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/003-noscript.jpg"></noscript><img id="image-2" data-wpfc-original-src="https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/003.jpg" src="https://mangadistrict.com/wp-content/plugins/wp-fastest-cache-premium/pro/images/blank.gif" class="wp-manga-chapter-img"></div>
</div>`;

const chapter = (chapterId: string, chapNum: number, title = `Chapter ${chapNum}`): Chapter =>
  ({
    chapterId,
    chapNum,
    title,
    sourceManga: { mangaId: "moby-dick-official" },
  }) as Chapter;

export async function runTests(logger: TestLogger) {
  const suite = new TestSuite("MangaDistrict tests", logger);
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
  const withSettings = async (
    settings: { clean?: boolean; versions?: string },
    fn: () => Promise<void>,
  ) => {
    Application.setState(settings.clean ?? false, "mangadistrict.settings.cleanTitles");
    Application.setState(settings.versions ?? "all", "mangadistrict.settings.chapterVersions");
    try {
      await fn();
    } finally {
      Application.setState(false, "mangadistrict.settings.cleanTitles");
      Application.setState("all", "mangadistrict.settings.chapterVersions");
    }
  };

  suite.test("discover lists /series/ items and follows WP-PageNavi", async () => {
    const urls = respond(() => listing(MANY_PAGES));
    const extension = new MangaDistrictExtension();
    const result = await extension.getDiscoverSectionItems(
      { id: "most_popular", title: "Most Popular", type: 1 } as never,
      undefined,
    );
    expect(urls[0]).to.equal("https://mangadistrict.com/series?m_orderby=views");
    expect(result.items.map((i) => ("mangaId" in i ? i.mangaId : ""))).to.deep.equal([
      "teach-me-first-uncensored",
      "moby-dick-official",
    ]);
    expect(result.items[1]).to.include({
      title: "Moby Dick (Official)",
      imageUrl: "https://cdn.mangadistrict.com/thumbnail/moby-dick-official-3.webp",
    });
    expect(result.metadata).to.deep.include({ page: 2 });
  });

  suite.test(
    "search sees a next page without a 'last' link and stops on the last page",
    async () => {
      let page = 1;
      const urls = respond(() => listing(page === 1 ? TWO_PAGES : LAST_PAGE));
      const extension = new MangaDistrictExtension();
      const first = await extension.getSearchResults(
        { title: "secret class" },
        undefined,
        undefined,
      );
      expect(urls[0]).to.contain("https://mangadistrict.com?s=secret%20class&post_type=wp-manga");
      expect(first.items).to.have.length(2);
      expect(first.metadata).to.deep.include({ page: 2 });

      page = 2;
      const second = await extension.getSearchResults(
        { title: "secret class" },
        first.metadata,
        undefined,
      );
      expect(urls[1]).to.contain("/page/2");
      expect(second.metadata).to.equal(undefined);
    },
  );

  suite.test("filter form offers genres and sends them as genre[]", async () => {
    const extension = new MangaDistrictExtension();
    const form = (await extension.getAdvancedSearchForm({ title: "" })) as MadaraSearchForm;
    const ids = form.getSections().map((s) => s.id);
    expect(ids).to.include("genres");

    await form.updateGenres(["romance", "school-life"]);
    await form.updateGenreCondition(["1"]);
    await form.updateStatus(["upcoming"]);
    const metadata = form.getSearchQueryMetadata();
    expect(metadata.searchMeta.genres).to.deep.equal(["romance", "school-life"]);

    const urls = respond(() => listing(LAST_PAGE));
    await extension.getSearchResults({ title: "", metadata }, undefined, undefined);
    expect(urls[0]).to.contain("genre[]=romance&genre[]=school-life");
    expect(urls[0]).to.contain("status[]=upcoming");
    expect(urls[0]).to.contain("op=1");

    // Unknown genres in saved metadata are dropped, not sent.
    const bad = { searchMeta: { ...metadata.searchMeta, genres: ["../x"] } };
    await extension.getSearchResults({ title: "", metadata: bad }, undefined, undefined);
    expect(urls[1]).to.not.contain("genre[]");
  });

  suite.test("details parse the series page", async () => {
    respond(() => details);
    const manga = await new MangaDistrictExtension().getMangaDetails("moby-dick-official");
    expect(manga.mangaInfo).to.include({
      primaryTitle: "Moby Dick (Official)",
      author: "Yansae",
      artist: "Dini",
      status: "Ongoing",
      synopsis: "A whale of a story.",
      thumbnailUrl: "https://cdn.mangadistrict.com/thumbnail/moby-dick-official.webp",
    });
    expect(manga.mangaInfo.secondaryTitles).to.deep.equal(["Mobi Dik", "모비딕"]);
    expect(manga.mangaInfo.shareUrl).to.equal(
      "https://mangadistrict.com/series/moby-dick-official",
    );
  });

  suite.test("Inkdex library entries (WP post ids) resolve to the series slug", async () => {
    // Inkdex's MangaDistrict shares this source id and stores the post id;
    // mangadistrict.com redirects /?p=<id> to the canonical /series/<slug>/.
    const urls = respond((url) =>
      url.includes("?p=")
        ? '<link rel="canonical" href="https://mangadistrict.com/series/moby-dick-official/">'
        : details,
    );
    const extension = new MangaDistrictExtension();
    const manga = await extension.getMangaDetails("326799");
    expect(manga.mangaId).to.equal("326799");
    expect(manga.mangaInfo.primaryTitle).to.equal("Moby Dick (Official)");
    const chapters = await extension.getChapters(manga);
    expect(chapters[0].chapterId).to.equal("chapter-35");
    expect(urls).to.deep.equal([
      "https://mangadistrict.com/?p=326799",
      "https://mangadistrict.com/series/moby-dick-official",
      "https://mangadistrict.com/series/moby-dick-official",
    ]);
  });

  suite.test("inline chapter list keeps every version, labelled", async () => {
    const urls = respond(() => details);
    const extension = new MangaDistrictExtension();
    await withSettings({}, async () => {
      const chapters = await extension.getChapters({ mangaId: "moby-dick-official" } as never);
      expect(chapters.map((c) => [c.chapterId, c.title, c.chapNum])).to.deep.equal([
        ["chapter-35", "Chapter 35 - New arc", 35],
        ["chapter-2", "Chapter 2", 2],
        ["chapter-1", "Chapter 1", 1],
        ["v2-full-quality/chapter-2_1", "Chapter 2 · V2 Full Quality", 2],
        ["v2-full-quality/chapter-1_1", "Chapter 1 · V2 Full Quality", 1],
      ]);
      expect(chapters[0].publishDate?.getFullYear()).to.equal(2026);
      // Chapters are inline: no AJAX chapter request.
      expect(urls).to.deep.equal(["https://mangadistrict.com/series/moby-dick-official"]);
    });
  });

  suite.test("chapter version preference keeps one copy per chapter", async () => {
    const chapters = [
      chapter("chapter-35", 35),
      chapter("chapter-2", 2),
      chapter("chapter-1", 1),
      chapter("v2-full-quality/chapter-2_1", 2),
      chapter("v2-full-quality/chapter-1_1", 1),
      chapter("v1-high-quality-optimized-for-moderate-data-usage/chapter-1", 1),
      chapter("special", 0, "Special"),
    ];
    const ids = (preference: "high" | "full") =>
      applyChapterVersions(chapters, preference).map((c) => c.chapterId);
    expect(ids("full")).to.deep.equal([
      "chapter-35",
      "v2-full-quality/chapter-2_1",
      "v2-full-quality/chapter-1_1",
      "special",
    ]);
    expect(ids("high")).to.deep.equal([
      "chapter-35",
      "chapter-2",
      "v1-high-quality-optimized-for-moderate-data-usage/chapter-1",
      "special",
    ]);
  });

  suite.test("reader skips the decoy banner and noscript copies", async () => {
    const urls = respond(() => reader);
    const details = await new MangaDistrictExtension().getChapterDetails(
      chapter("v2-full-quality/chapter-248", 248),
    );
    expect(urls[0]).to.equal(
      "https://mangadistrict.com/series/moby-dick-official/v2-full-quality/chapter-248/",
    );
    expect("pages" in details ? details.pages : []).to.deep.equal([
      "https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/001.jpg",
      "https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/002.jpg",
      "https://cdn.mangadistrict.com/publication/manga_66e58cf484d5f/chapter-248/003.jpg",
    ]);
  });

  suite.test("title cleaning strips version tags only when enabled", async () => {
    expect(cleanTitle("Moby Dick (Official)")).to.equal("Moby Dick");
    expect(cleanTitle("[MANGA DISTRICT EDITION] Man of Vengeance (UNCENSORED)")).to.equal(
      "Man of Vengeance",
    );
    expect(cleanTitle("Teach Me first! (Uncensored)")).to.equal("Teach Me first!");
    expect(cleanTitle("Got A Room? / Official")).to.equal("Got A Room?");
    expect(cleanTitle("(Uncensored)")).to.equal("(Uncensored)");
    expect(cleanTitle("Secret Class")).to.equal("Secret Class");

    respond((url) => (url.includes("?s=") || url.includes("m_orderby") ? listing("") : details));
    const extension = new MangaDistrictExtension();
    await withSettings({}, async () => {
      const off = await extension.getSearchResults({ title: "moby" }, undefined, undefined);
      expect(off.items.map((i) => i.title)).to.include("Moby Dick (Official)");
    });
    await withSettings({ clean: true }, async () => {
      const search = await extension.getSearchResults({ title: "moby" }, undefined, undefined);
      expect(search.items.map((i) => i.title)).to.deep.equal(["Teach Me first!", "Moby Dick"]);
      const manga = await extension.getMangaDetails("moby-dick-official");
      expect(manga.mangaInfo.primaryTitle).to.equal("Moby Dick");
      expect(manga.mangaInfo.secondaryTitles[0]).to.equal("Moby Dick (Official)");
    });
  });

  try {
    await suite.run();
  } finally {
    Application.scheduleRequest = scheduleRequest;
  }
}
