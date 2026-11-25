import { type TestLogger } from "@paperback/types";
import { expect } from "chai";
import { ToonzExtension } from "../Toonz/main.js";
import { TestSuite } from "./suite.js";

export async function runTests(logger: TestLogger) {
  const suite = new TestSuite("Toonz tests", logger);
  const scheduleRequest = Application.scheduleRequest;

  suite.test("rejects a related comic ID when the current title has no matching ID", async () => {
    const extension = new ToonzExtension();
    let html = '<h1>Current</h1><script>{"comicId":123,"comicTitle":"Current"}</script>';
    let chapterRequest: string | undefined;
    Application.scheduleRequest = async ({ url }) => {
      if (url.includes("/api/comics/")) chapterRequest = url;
      const body = chapterRequest
        ? '{"chapters":[{"slug":"chapter-1","chapterNumber":"1"}]}'
        : html;
      return [
        { url, status: 200, headers: {}, cookies: [] },
        new TextEncoder().encode(body).buffer,
      ];
    };

    const manga = await extension.getMangaDetails("manga/current");
    expect(await extension.getChapters(manga)).to.have.length(1);
    expect(chapterRequest).to.include("/api/comics/123/chapters");

    chapterRequest = undefined;
    html = '<h1>Current</h1><script>{"comicId":456,"comicTitle":"Related"}</script>';
    await extension.getMangaDetails("manga/current");
    const error = await extension.getChapters(manga).catch((error: Error) => error);
    expect(error).to.be.instanceOf(Error);
    expect(error).to.have.property("message").that.includes("could not find the comic id");
    expect(chapterRequest).to.be.undefined;
  });

  suite.test("loads chapter images from HTML after an RSC request is rejected", async () => {
    const extension = new ToonzExtension();
    Application.scheduleRequest = async ({ url, headers }) => {
      const status = headers?.rsc ? 406 : 200;
      const body = url.includes("/chapter/")
        ? '<script>{"images":[{"filename":"page.jpg"}]}</script>'
        : "<h1>Current</h1>";
      return [{ url, status, headers: {}, cookies: [] }, new TextEncoder().encode(body).buffer];
    };

    const sourceManga = await extension.getMangaDetails("manga/current");
    const details = await extension.getChapterDetails({
      chapterId: "1",
      sourceManga,
      chapNum: 1,
      langCode: "🇬🇧",
    });
    expect(details)
      .to.have.property("pages")
      .that.deep.equals(["https://toonz.to/uploads/page.jpg"]);
  });

  suite.test("requires the exact next page on the current listing", async () => {
    const extension = new ToonzExtension();
    let links = '<a href="/comics?page=20">20</a><a href="/search?page=2">Search</a>';
    Application.scheduleRequest = async ({ url }) => {
      const body = '<a href="/manga/current"><img data-cover alt="Current" src="/cover.jpg"></a>';
      return [
        { url, status: 200, headers: {}, cookies: [] },
        new TextEncoder().encode(body + links).buffer,
      ];
    };
    const search = () => extension.getSearchResults({ title: "" }, undefined, undefined);
    const first = await search();
    expect(first.items).to.have.length(1);
    expect(first.metadata).to.be.undefined;

    links += '<a href="?sort=popular&amp;page=2#results">Next</a>';
    expect((await search()).metadata).to.deep.equal({ page: 2 });
  });

  try {
    await suite.run();
  } finally {
    Application.scheduleRequest = scheduleRequest;
  }
}
