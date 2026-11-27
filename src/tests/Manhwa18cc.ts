import { type TestLogger } from "@paperback/types";
import { expect } from "chai";

import { isRawTitle, Manhwa18ccExtension, parseDate } from "../Manhwa18cc/main.js";
import { TestSuite } from "./suite.js";

// Fixtures trimmed from live manhwa18.cc markup.
const item = (slug: string, title: string) => `
<div class="manga-item"><div class="bsx wleft">
  <div class="thumb"><a href="https://manhwa18.cc/webtoon/${slug}" title="${title}"><span class="badge-adult">18+</span>
    <img data-src="https://manhwa18.cc/manga/${slug}m.jpg" src="https://manhwa18.cc/images/loading.gif" alt="${title}"></a></div>
  <div class="data wleft"><h3><a href="https://manhwa18.cc/webtoon/${slug}" title="${title}"> ${title} </a></h3></div>
</div></div>`;

const pagination = (next?: string) => `
<ul class="pagination"><li class="prev disabled"><span>«</span></li>
  <li class="active"><a href="https://manhwa18.cc/webtoons/1?orderby=trending" data-page="0">1</a></li>
  ${
    next
      ? `<li><a href="${next}" data-page="1">2</a></li><li class="next"><a href="${next}" data-page="1">»</a></li>`
      : '<li class="next disabled"><span>»</span></li>'
  }
</ul>`;

const listing = (items: string[], next?: string) =>
  `<div class="listing">${items.join("")}</div>${pagination(next)}`;

const details = `
<div class="post-title"> <h1> <span>18+</span> Wireless Onahole </h1> </div>
<div class="summary_image"><img class="img-loading" data-src="https://manhwa18.cc/manga/wireless-onaholem.jpg" src="https://manhwa18.cc/manga/wireless-onaholem.jpg" alt="Wireless Onahole"></div>
<div class="post-content_item"><div class="summary-heading"><h5>Rating:</h5></div><div class="summary-content">Average <span id="averagerate">3.13</span> / 5 out of 273</div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Alternative:</h5></div><div class="summary-content">무선 연결 오나홀</div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Author(s)</h5></div><div class="summary-content"><div class="author-content"><a href="https://manhwa18.cc/webtoon-author/swehwangjorongie">Swehwangjorongie</a></div></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Artist(s)</h5></div><div class="summary-content"><div class="artist-content"><a href="https://manhwa18.cc/webtoon-artist/ottogi">Ottogi</a></div></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Genre(s)</h5></div><div class="summary-content"><div class="genres-content"><a href="https://manhwa18.cc/webtoon-genre/drama" rel="tag">Drama</a> <a href="https://manhwa18.cc/webtoon-genre/school-life" rel="tag"> School Life</a></div></div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content"> OnGoing </div></div>
<div class="panel-story-description"><h2 class="manga-panel-title wleft">Summary</h2><div class="dsct"><p>“The onahole… moved?!”</p></div></div>
<ul class="row-content-chapter">
  <li class="a-h wleft"><a class="chapter-name text-nowrap" href="https://manhwa18.cc/webtoon/wireless-onahole/chapter-129" title="Wireless Onahole Chapter 129">Chapter 129</a> <span class="chapter-time text-nowrap">25 Nov 2026</span></li>
  <li class="a-h wleft"><a class="chapter-name text-nowrap" href="https://manhwa18.cc/webtoon/wireless-onahole/chapter-125-5" title="Wireless Onahole Chapter 125.5">Chapter 125.5</a> <span class="chapter-time text-nowrap">2 hours ago</span></li>
  <li class="a-h wleft"><a class="chapter-name text-nowrap" href="https://manhwa18.cc/webtoon/wireless-onahole/chapter-1" title="Wireless Onahole Chapter 1">Chapter 1</a> <span class="chapter-time text-nowrap">21 Mar 2025</span></li>
</ul>`;

const reader = `
<div class="read-content wleft tc">
  <img class="loading p1" data-src="https://img01.manhwa18.cc/online/4661/129/1-a832f.jpg" src="https://manhwa18.cc/images/loading.gif" loading="lazy">
  <img class="loading p2" data-src="https://img01.manhwa18.cc/online/4661/129/2-a832f.jpg" src="https://img01.manhwa18.cc/online/4661/129/2-a832f.jpg" loading="lazy">
  <img class="loading p3" src="https://img01.manhwa18.cc/online/4661/129/3-a832f.jpg">
</div>`;

export async function runTests(logger: TestLogger) {
  const suite = new TestSuite("Manhwa18cc tests", logger);
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
  const setHideRaw = (value: boolean) => Application.setState(value, "manhwa18cc.settings.hideRaw");

  suite.test("discover reads manga-item cards and follows the next link", async () => {
    const urls = respond(() =>
      listing(
        [item("keep-it-a-secret-from-your-mother-01", "Keep it a secret from your mother!")],
        "https://manhwa18.cc/webtoons/2?orderby=trending",
      ),
    );
    const extension = new Manhwa18ccExtension();
    const result = await extension.getDiscoverSectionItems(
      { id: "trending", title: "Trending", type: 0 } as never,
      undefined,
    );
    expect(urls[0]).to.equal("https://manhwa18.cc/webtoons?orderby=trending");
    expect(result.items[0]).to.include({
      mangaId: "keep-it-a-secret-from-your-mother-01",
      title: "Keep it a secret from your mother!",
      imageUrl: "https://manhwa18.cc/manga/keep-it-a-secret-from-your-mother-01m.jpg",
    });
    expect(result.metadata).to.deep.equal({
      next: "https://manhwa18.cc/webtoons/2?orderby=trending",
    });

    await extension.getDiscoverSectionItems(
      { id: "trending", title: "Trending", type: 0 } as never,
      result.metadata as { next?: string },
    );
    expect(urls[1]).to.equal("https://manhwa18.cc/webtoons/2?orderby=trending");
  });

  suite.test("search hides raw copies unless turned off", async () => {
    const urls = respond(() =>
      listing([
        item("pizza-boy-vs-milfs", "Pizza Boy vs MILFs"),
        item("the-hunt-for-married-women-raw", "The Hunt for Married Women Raw"),
        item("milf-hunting-in-another-world-raw-01", "MILF Hunting in Another World"),
      ]),
    );
    const extension = new Manhwa18ccExtension();
    try {
      setHideRaw(true);
      const hidden = await extension.getSearchResults({ title: "milf" }, undefined, undefined);
      expect(urls[0]).to.equal("https://manhwa18.cc/search?q=milf");
      expect(hidden.items.map((i) => i.mangaId)).to.deep.equal(["pizza-boy-vs-milfs"]);
      expect(hidden.metadata).to.equal(undefined);

      setHideRaw(false);
      const all = await extension.getSearchResults({ title: "milf" }, undefined, undefined);
      expect(all.items).to.have.length(3);
    } finally {
      setHideRaw(true);
    }
  });

  suite.test("a page of only raw titles reads ahead instead of ending", async () => {
    const urls = respond((url) =>
      url.endsWith("/webtoons")
        ? listing([item("a-raw", "A Raw")], "https://manhwa18.cc/webtoons/2")
        : listing([item("b", "B")]),
    );
    setHideRaw(true);
    const result = await new Manhwa18ccExtension().getSearchResults(
      { title: "" },
      undefined,
      undefined,
    );
    expect(urls).to.deep.equal(["https://manhwa18.cc/webtoons", "https://manhwa18.cc/webtoons/2"]);
    expect(result.items.map((i) => i.mangaId)).to.deep.equal(["b"]);
  });

  suite.test("empty search browses with the chosen sort", async () => {
    const urls = respond(() => listing([]));
    await new Manhwa18ccExtension().getSearchResults({ title: "" }, undefined, {
      id: "rating",
      label: "Rating",
    });
    expect(urls[0]).to.equal("https://manhwa18.cc/webtoons?orderby=rating");
  });

  suite.test("details parse the series page", async () => {
    const urls = respond(() => details);
    const manga = await new Manhwa18ccExtension().getMangaDetails("wireless-onahole");
    expect(urls[0]).to.equal("https://manhwa18.cc/webtoon/wireless-onahole");
    expect(manga.mangaInfo).to.include({
      primaryTitle: "Wireless Onahole",
      author: "Swehwangjorongie",
      artist: "Ottogi",
      status: "Ongoing",
      synopsis: "“The onahole… moved?!”",
      thumbnailUrl: "https://manhwa18.cc/manga/wireless-onaholem.jpg",
    });
    expect(manga.mangaInfo.secondaryTitles).to.deep.equal(["무선 연결 오나홀"]);
    expect(manga.mangaInfo.rating).to.be.closeTo(0.626, 1e-9);
    expect(manga.mangaInfo.tagGroups?.[0].tags.map((t) => t.title)).to.deep.equal([
      "Drama",
      "School Life",
    ]);
  });

  suite.test("chapters keep half chapters and parse both date styles", async () => {
    respond(() => details);
    const chapters = await new Manhwa18ccExtension().getChapters({
      mangaId: "wireless-onahole",
    } as never);
    expect(chapters.map((c) => [c.chapterId, c.chapNum])).to.deep.equal([
      ["chapter-129", 129],
      ["chapter-125-5", 125.5],
      ["chapter-1", 1],
    ]);
    expect(chapters[0].publishDate?.toISOString()).to.equal("2026-11-25T00:00:00.000Z");
    const recent = chapters[1].publishDate?.getTime() ?? 0;
    expect(Date.now() - recent).to.be.closeTo(2 * 3600e3, 60e3);
  });

  suite.test("reader prefers data-src over the loading placeholder", async () => {
    const urls = respond(() => reader);
    const details = await new Manhwa18ccExtension().getChapterDetails({
      chapterId: "chapter-129",
      sourceManga: { mangaId: "wireless-onahole" },
    } as never);
    expect(urls[0]).to.equal("https://manhwa18.cc/webtoon/wireless-onahole/chapter-129");
    expect("pages" in details ? details.pages : []).to.deep.equal([
      "https://img01.manhwa18.cc/online/4661/129/1-a832f.jpg",
      "https://img01.manhwa18.cc/online/4661/129/2-a832f.jpg",
      "https://img01.manhwa18.cc/online/4661/129/3-a832f.jpg",
    ]);
  });

  suite.test("helpers: raw detection, dates and pasted links", async () => {
    expect(isRawTitle({ mangaId: "x-raw", title: "X" })).to.equal(true);
    expect(isRawTitle({ mangaId: "x", title: "Strawberry Raw" })).to.equal(true);
    expect(isRawTitle({ mangaId: "straw", title: "Straw" })).to.equal(false);
    expect(parseDate("3 Feb 2025")?.toISOString()).to.equal("2025-02-03T00:00:00.000Z");
    expect(parseDate("")).to.equal(undefined);

    respond(() => details);
    const pasted = await new Manhwa18ccExtension().getSearchResults(
      { title: "https://manhwa18.cc/webtoon/wireless-onahole/chapter-3" },
      undefined,
      undefined,
    );
    expect(pasted.items).to.deep.equal([
      {
        mangaId: "wireless-onahole",
        title: "Wireless Onahole",
        imageUrl: "https://manhwa18.cc/manga/wireless-onaholem.jpg",
      },
    ]);
  });

  try {
    await suite.run();
  } finally {
    Application.scheduleRequest = scheduleRequest;
  }
}
