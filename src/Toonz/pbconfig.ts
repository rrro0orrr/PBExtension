import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "Toonz",
  description: "Extension that pulls manga, manhwa and manhua from toonz.to.",
  version: "1.0.1",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.ADULT,
  capabilities: [
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [
    { label: "Aggregator", textColor: "#FFFFFF", backgroundColor: "#800080" },
    { label: "18+", textColor: "#FFFFFF", backgroundColor: "#C62828" },
  ],
  developers: [{ name: "rrro0orrr", github: "https://github.com/rrro0orrr" }],
} satisfies ExtensionInfo;
