// Shapes of the Inertia.js page props embedded in hentai2read.com pages
// (<script data-page="app">). Only the fields the extension uses are typed.

export interface H2RPage<T> {
  component: string;
  url: string;
  props: T;
}

export interface H2RTagRef {
  id: number;
  name: string;
  type: string;
  url: string;
}

export interface H2RBookCard {
  id: number;
  title: string;
  url: string;
  cover: string;
  type: string;
  typeLabel: string;
  chapters: number;
  pageCount: number;
  artist?: H2RTagRef | null;
  rating?: number;
  views?: number;
}

export interface H2RPaginated {
  data: H2RBookCard[];
  page?: number;
  lastPage?: number;
  total?: number;
  links?: { prev: string | null; next: string | null };
}

export interface H2RHomeProps {
  top?: H2RBookCard[];
  latest?: H2RBookCard[];
}

export interface H2RBookPageProps {
  book?: {
    id: number;
    title: string;
    url: string;
    cover: string;
    alt?: string | string[] | null;
    type?: { label: string; url: string } | null;
    status?: { label: string; url: string } | null;
    description?: unknown;
    tags?: H2RTagRef[];
    groups?: { label: string; type: string; tags: H2RTagRef[] }[];
  };
  stats?: { views: number; rating: number; ratings: number };
  chapters?: {
    id: number;
    number: string;
    title: string;
    url: string;
    date?: string;
  }[];
}

export interface H2RReaderProps {
  images?: (string | null)[];
  avif?: (string | null)[];
}

export interface H2RSearchTag {
  id: number;
  name: string;
  count: number;
}
