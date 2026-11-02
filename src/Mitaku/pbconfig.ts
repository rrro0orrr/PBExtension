import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "Mitaku",
  description: "Extension that pulls content from mitaku.net",
  version: "1.1.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.ADULT,
  badges: [],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
  developers: [
    {
      name: "Netsky",
      github: "https://github.com/TheNetsky",
    },
  ],
} satisfies ExtensionInfo;
