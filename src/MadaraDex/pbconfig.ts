import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "MadaraDex",
  description: "Extension that pulls content from madaradex.org",
  version: "1.0.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.MATURE,
  capabilities: [
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [
    { label: "Madara", textColor: "#FFFFFF", backgroundColor: "#2E7D32" },
    { label: "Mature", textColor: "#FFFFFF", backgroundColor: "#C62828" },
  ],
  developers: [
    { name: "nicartjay", github: "https://github.com/Nicartjay" },
    { name: "keiyoushi", github: "https://github.com/keiyoushi" },
  ],
} satisfies ExtensionInfo;
