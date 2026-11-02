import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "LNORI",
  description: "Extension that pulls light novels from lnori.com.",
  version: "1.0.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.EVERYONE,
  capabilities: [
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
  badges: [{ label: "Light Novels", textColor: "#FFFFFF", backgroundColor: "#5B3FA0" }],
  developers: [
    {
      name: "Karrot",
    },
  ],
} satisfies ExtensionInfo;
