import { ContentRating, SourceIntents } from "@paperback/types";
export default {
    name: "NovelFire",
    description: "Extension that pulls content from novelphoenix.com (formerly novelfire.net).",
    version: "1.0.0-alpha.12",
    icon: "icon.png",
    language: "en",
    contentRating: ContentRating.EVERYONE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
        SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    ],
    badges: [],
    developers: [
        {
            name: "Karrot",
            github: "https://github.com/karrot0",
        },
    ],
};
