import { AdvancedSearchForm, NavigationRow, Section } from "@paperback/types";
import type { JSONObject } from "@paperback/types";
import { TagFilterForm, type TagFilterState } from "./TagFilterForm";

export interface NovelArchiveSearchMetadata extends JSONObject {
  tagIncluded: string[];
  tagExcluded: string[];
}

export class NovelArchiveSearchForm extends AdvancedSearchForm {
  private tagForm: TagFilterForm;

  constructor(tags: { id: string; name: string }[], initialMeta?: NovelArchiveSearchMetadata) {
    super();
    this.tagForm = new TagFilterForm(tags, {
      included: initialMeta?.tagIncluded ?? [],
      excluded: initialMeta?.tagExcluded ?? [],
    });
  }

  getSearchQueryMetadata() {
    const tags: TagFilterState = this.tagForm.getState();
    return {
      searchMeta: {
        tagIncluded: tags.included,
        tagExcluded: tags.excluded,
      } satisfies NovelArchiveSearchMetadata,
    };
  }

  private getTagSubtitle(): string {
    const state = this.tagForm.getState();
    const total = state.included.length + state.excluded.length;
    return total > 0 ? `${total} selected` : "";
  }

  override getSections() {
    return [
      Section("tags_section", [
        NavigationRow("tags_nav", {
          title: "Tags",
          subtitle: this.getTagSubtitle(),
          form: this.tagForm,
        }),
      ]),
    ];
  }
}
